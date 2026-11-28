import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {parseColor} from './background.js';
import {previews} from './previews.js';
import {settingsMenu} from './settingsMenu.js';

const LABEL_SHOW_DELAY = 300;
const LABEL_ANIMATION_TIME = 150;
const MAX_INDICATOR_DOTS = 4;
const WHITE = {red: 255, green: 255, blue: 255};
// Dots of apps without focus use the dot colour at this opacity.
const INACTIVE_DOT_OPACITY = 0.5;
const DRAG_TIMEOUT_THRESHOLD = 200;
const SCROLL_ANIMATION_TIME = 150;
// Pixels per unit of touchpad scroll delta; a wheel notch moves one button.
const SMOOTH_SCROLL_PX = 24;
// While dragging an icon near an edge of a scrolled row, nudge it this far.
const DRAG_SCROLL_PX = 12;

/**
 * Small tooltip shown above a taskbar button while it is hovered.
 */
class HoverLabel {
    constructor(actor, text, shouldShow = () => true) {
        this._actor = actor;
        this._shouldShow = shouldShow;
        this._timeoutId = 0;

        this._label = new St.Label({
            style_class: 'dash-label tideline-label',
            text,
            opacity: 0,
        });
        this._label.hide();
        Main.layoutManager.uiGroup.add_child(this._label);

        actor.connectObject('notify::hover', () => this._sync(), this);
    }

    setText(text) {
        this._label.text = text;
    }

    _sync() {
        this._clearTimeout();
        if (this._actor.hover && this._shouldShow()) {
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                LABEL_SHOW_DELAY, () => {
                    this._timeoutId = 0;
                    this.show();
                    return GLib.SOURCE_REMOVE;
                });
        } else {
            this.hide();
        }
    }

    show() {
        if (!this._actor.get_stage())
            return;

        this._label.show();
        const [stageX, stageY] = this._actor.get_transformed_position();
        const [width] = this._actor.get_transformed_size();
        const labelWidth = this._label.width;
        const monitor = Main.layoutManager.findMonitorForActor(this._actor);

        let x = Math.floor(stageX + (width - labelWidth) / 2);
        if (monitor)
            x = Math.clamp(x, monitor.x, monitor.x + monitor.width - labelWidth);
        const y = stageY - this._label.height - 8;

        this._label.set_position(x, y);
        this._label.ease({
            opacity: 255,
            duration: LABEL_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    hide() {
        this._clearTimeout();
        this._label.ease({
            opacity: 0,
            duration: LABEL_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this._label.hide(),
        });
    }

    _clearTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    destroy() {
        this._clearTimeout();
        this._actor.disconnectObject(this);
        this._label.destroy();
    }
}

/**
 * One button per application: launches it, focuses/cycles/minimizes its
 * windows, and shows a dot per open window.
 */
const TaskbarAppButton = GObject.registerClass(
class TaskbarAppButton extends St.Button {
    _init(app, taskbar) {
        super._init({
            style_class: 'tideline-app',
            button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.MIDDLE,
            reactive: true,
            can_focus: true,
            track_hover: true,
            y_expand: true,
        });

        this.app = app;
        this._taskbar = taskbar;
        this._delegate = this;
        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);

        const layout = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            y_expand: true,
        });
        this.set_child(layout);

        this._iconBin = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        layout.add_child(this._iconBin);

        this._dots = new St.BoxLayout({
            style_class: 'tideline-dots',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            x_expand: true,
            y_expand: true,
        });
        layout.add_child(this._dots);

        // Running apps show window previews instead of the name label.
        this._label = new HoverLabel(this, app.get_name(),
            () => !taskbar.previewsEnabled || this.getWindows().length === 0);
        if (taskbar.previewsEnabled) {
            this.connect('notify::hover', () => {
                if (this.hover && this.getWindows().length > 0)
                    previews.buttonEntered(this);
                else if (!this.hover)
                    previews.buttonLeft();
            });
        }

        this._draggable = DND.makeDraggable(this,
            {timeoutThreshold: DRAG_TIMEOUT_THRESHOLD});
        this._draggable.connectObject(
            'drag-begin', () => {
                this._label.hide();
                previews.close();
                taskbar.dragBegin(this);
            },
            'drag-end', () => taskbar.dragEnd(),
            this);

        const rightClick = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_SECONDARY,
            recognize_on_press: true,
        });
        rightClick.connect('recognize', () => this.popupMenu());
        this.add_action(rightClick);

        this.connect('popup-menu', () => this.popupMenu());
        this.connect('scroll-event', (_actor, event) => this._onScroll(event));
        this.connect('destroy', () => this._onDestroy());

        this.setIconSize(taskbar.iconSize);

        // Keep the minimize target in sync when the button moves, e.g. as
        // apps are added and the centered row shifts.
        this._iconGeometryId = 0;
        this.connect('notify::allocation', () => this._queueIconGeometry());
    }

    setIconSize(size) {
        this._iconBin.set_child(this.app.create_icon_texture(size));
    }

    getDragActor() {
        return this.app.create_icon_texture(this._taskbar.iconSize);
    }

    getDragActorSource() {
        return this._iconBin;
    }

    getWindows() {
        return this._taskbar.filterWindows(this.app.get_windows());
    }

    sync() {
        const windows = this.getWindows();
        const focusApp = Shell.WindowTracker.get_default().focus_app;

        if (windows.length > 0)
            this.add_style_pseudo_class('running');
        else
            this.remove_style_pseudo_class('running');

        if (focusApp === this.app && windows.length > 0)
            this.add_style_pseudo_class('focused');
        else
            this.remove_style_pseudo_class('focused');

        const nDots = Math.min(windows.length, MAX_INDICATOR_DOTS);
        if (this._dots.get_n_children() !== nDots) {
            this._dots.destroy_all_children();
            for (let i = 0; i < nDots; i++)
                this._dots.add_child(new St.Widget({style_class: 'tideline-dot'}));
        }

        const {red, green, blue} = this._taskbar.dotColor;
        const alpha = this.has_style_pseudo_class('focused') ? 1 : INACTIVE_DOT_OPACITY;
        for (const dot of this._dots.get_children())
            dot.set_style(`background-color: rgba(${red}, ${green}, ${blue}, ${alpha});`);

        const nAll = this.app.get_windows().length;
        this._label.setText(nAll > 1
            ? `${this.app.get_name()} (${nAll})`
            : this.app.get_name());

        previews.refresh(this);
        this._queueIconGeometry();
    }

    _ownsWindow(window) {
        // Windows minimize to the button on their own monitor. The primary
        // taskbar also takes windows on monitors that have no taskbar.
        if (window.get_monitor() === this._taskbar.monitorIndex)
            return true;
        return this._taskbar.isPrimary &&
            !this._taskbar.settings.get_boolean('multi-monitor');
    }

    _queueIconGeometry() {
        if (this._iconGeometryId)
            return;
        this._iconGeometryId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._iconGeometryId = 0;
            this._updateIconGeometry();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateIconGeometry() {
        if (!this.get_stage())
            return;

        // GNOME's minimize animation shrinks the window into this rectangle,
        // and unminimizing grows it back out; without one it uses the
        // monitor's top-left corner.
        const [x, y] = this.get_transformed_position();
        const [width, height] = this.get_transformed_size();
        const rect = new Mtk.Rectangle({
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height),
        });
        for (const window of this.getWindows()) {
            if (this._ownsWindow(window))
                window.set_icon_geometry(rect);
        }
    }

    vfunc_clicked(button) {
        this._label.hide();
        previews.close();

        const event = Clutter.get_current_event();
        const modifiers = event ? event.get_state() : 0;
        const ctrl = (modifiers & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const windows = this.getWindows();

        if (windows.length === 0) {
            if (this.app.state === Shell.AppState.RUNNING &&
                this.app.can_open_new_window())
                this.app.open_new_window(-1);
            else
                this.app.activate();
            Main.overview.hide();
            return;
        }

        if (button === Clutter.BUTTON_MIDDLE || ctrl) {
            if (this.app.can_open_new_window())
                this.app.open_new_window(-1);
            Main.overview.hide();
            return;
        }

        const focusApp = Shell.WindowTracker.get_default().focus_app;
        if (focusApp === this.app && !Main.overview.visible) {
            if (windows.length === 1) {
                windows[0].minimize();
            } else {
                // Windows are in MRU order; activate the least recently used
                // one so repeated clicks cycle through all of them.
                Main.activateWindow(windows[windows.length - 1]);
            }
        } else {
            Main.activateWindow(windows[0]);
        }
        Main.overview.hide();
    }

    _onScroll(event) {
        // While the row scrolls, the wheel scrolls it rather than cycling
        // through the app's windows.
        if (this._taskbar.overflowing)
            return Clutter.EVENT_PROPAGATE;

        const windows = this.getWindows();
        if (windows.length < 2)
            return Clutter.EVENT_PROPAGATE;

        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.DOWN)
            Main.activateWindow(windows[windows.length - 1]);
        else if (direction === Clutter.ScrollDirection.UP)
            Main.activateWindow(windows[1]);
        return Clutter.EVENT_STOP;
    }

    popupMenu() {
        this._label.hide();
        previews.close();

        if (!this._menu) {
            this._menu = new AppMenu(this, St.Side.BOTTOM, {
                favoritesSection: true,
                showSingleWindows: true,
            });
            this._menu.setApp(this.app);
            this._menu.connect('open-state-changed', (_menu, open) => {
                if (open)
                    this.add_style_pseudo_class('active');
                else
                    this.remove_style_pseudo_class('active');
            });
            Main.uiGroup.add_child(this._menu.actor);
            this._menuManager.addMenu(this._menu);
        }

        this._menu.open(true);
        return Clutter.EVENT_STOP;
    }

    _onDestroy() {
        if (this._iconGeometryId) {
            GLib.source_remove(this._iconGeometryId);
            this._iconGeometryId = 0;
        }
        for (const window of this.getWindows()) {
            if (this._ownsWindow(window))
                window.set_icon_geometry(null);
        }
        if (previews.isOpenFor(this))
            previews.close();
        this._draggable.disconnectObject(this);
        this._label.destroy();
        this._menu?.destroy();
        this._menu = null;
    }
});

/**
 * Button that toggles the application grid.
 */
const ShowAppsButton = GObject.registerClass(
class ShowAppsButton extends St.Button {
    _init(iconSize) {
        super._init({
            style_class: 'tideline-app tideline-show-apps',
            reactive: true,
            can_focus: true,
            track_hover: true,
            y_expand: true,
        });
        this._icon = new St.Icon({icon_name: 'view-app-grid-symbolic'});
        this.set_child(this._icon);
        this._label = new HoverLabel(this, _('Show Apps'));
        this.setIconSize(iconSize);

        // Like the Start button on Windows, a right-click offers settings.
        const rightClick = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_SECONDARY,
            recognize_on_press: true,
        });
        rightClick.connect('recognize', () => this.popupMenu());
        this.add_action(rightClick);
        this.connect('popup-menu', () => this.popupMenu());

        this.connect('destroy', () => this._label.destroy());
    }

    popupMenu() {
        this._label.hide();
        settingsMenu.openFor(this);
        return Clutter.EVENT_STOP;
    }

    setIconSize(size) {
        // Symbolic icons look heavy at full size; match the dash's proportion.
        this._icon.icon_size = Math.round(size * 0.75);
    }

    vfunc_clicked() {
        this._label.hide();
        const showAppsButton = Main.overview.dash?.showAppsButton;
        if (Main.overview.visible && showAppsButton?.checked)
            Main.overview.hide();
        else
            Main.overview.showApps();
    }
});

/**
 * Arrow at either end of the app row that scrolls it when the apps don't fit.
 */
const ScrollArrow = GObject.registerClass(
class ScrollArrow extends St.Button {
    _init(iconName) {
        super._init({
            style_class: 'tideline-scroll-arrow',
            reactive: false,
            can_focus: false,
            track_hover: true,
            y_expand: true,
            opacity: 0,
            child: new St.Icon({icon_name: iconName}),
        });
    }
});

/**
 * The row of application buttons. The primary taskbar lives inside the
 * panel; secondary monitors get one each, without the app grid button.
 *
 * When the apps don't fit in the space the taskbar gets (see setMaxWidth()
 * and ZoneOverflow), the row scrolls: arrows appear at its ends, and the
 * mouse wheel or touchpad scroll it too.
 */
export const Taskbar = GObject.registerClass(
class Taskbar extends St.Widget {
    /**
     * @param {Gio.Settings} settings - the extension's settings
     * @param {object} params
     * @param {number|null} params.monitorIndex - monitor this taskbar is on,
     *   or null to follow the primary monitor
     * @param {boolean} params.showAppsButton - whether to add the app grid button
     */
    _init(settings, {monitorIndex = null, showAppsButton = true} = {}) {
        super._init({
            style_class: 'tideline',
            // Reactive so the wheel scrolls the row between buttons too.
            reactive: true,
            y_expand: true,
        });

        this._settings = settings;
        this._monitorIndex = monitorIndex;
        this._buttons = new Map();
        this._runningOrder = [];
        this._redisplayId = 0;
        this._draggedButton = null;
        this._dropPlaceholder = null;
        this._dropPos = -1;
        this._dragMonitor = null;
        this._maxWidth = -1;
        this._overflowing = false;
        this._scrollTarget = null;
        this._focusApp = null;
        this._revealLaterId = 0;

        this.iconSize = settings.get_int('icon-size');
        this.previewsEnabled = settings.get_boolean('window-previews');
        this.dotColor = parseColor(settings.get_string('dot-color'), WHITE);

        if (showAppsButton && settings.get_boolean('show-apps-button')) {
            this._showApps = new ShowAppsButton(this.iconSize);
            this.add_child(this._showApps);
        }

        this._appBox = new St.BoxLayout({style_class: 'tideline-apps'});
        this._appBox._delegate = this;
        this._scrollView = new St.ScrollView({
            style_class: 'tideline-scroll',
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
            enable_mouse_scrolling: false,
            reactive: false,
            y_expand: true,
            child: this._appBox,
        });
        this.add_child(this._scrollView);

        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
        this._prevArrow = new ScrollArrow(rtl ? 'pan-end-symbolic' : 'pan-start-symbolic');
        this._nextArrow = new ScrollArrow(rtl ? 'pan-start-symbolic' : 'pan-end-symbolic');
        this._prevArrow.connect('clicked', () => this._scrollPage(-1));
        this._nextArrow.connect('clicked', () => this._scrollPage(1));
        this.add_child(this._prevArrow);
        this.add_child(this._nextArrow);

        this._scrollView.hadjustment.connectObject(
            'notify::value', () => this._syncArrows(),
            'changed', () => this._syncArrows(),
            this);
        this.connect('scroll-event', (_actor, event) => this._onScroll(event));
        settingsMenu.addTo(this);

        const queue = () => this._queueRedisplay();
        const appSystem = Shell.AppSystem.get_default();
        appSystem.connectObject(
            'app-state-changed', queue,
            'installed-changed', queue,
            this);
        AppFavorites.getAppFavorites().connectObject('changed', queue, this);
        Shell.WindowTracker.get_default().connectObject(
            'notify::focus-app', queue,
            'tracked-windows-changed', queue,
            this);
        global.display.connectObject(
            'window-created', queue,
            'window-entered-monitor', queue,
            'window-left-monitor', queue,
            this);
        global.workspace_manager.connectObject(
            'active-workspace-changed', queue,
            'workspace-added', queue,
            'workspace-removed', queue,
            this);
        St.TextureCache.get_default().connectObject(
            'icon-theme-changed', () => this._refreshIcons(), this);

        this.connect('destroy', () => this._onDestroy());
        this._redisplay();
    }

    /**
     * Cap the taskbar's natural width; the apps scroll beyond it.
     *
     * @param {number} width - the most it may take, or -1 for no limit
     */
    setMaxWidth(width) {
        if (width === this._maxWidth)
            return;
        this._maxWidth = width;
        this.queue_relayout();
    }

    /**
     * @returns {boolean} whether the apps don't fit and the row scrolls
     */
    get overflowing() {
        return this._overflowing;
    }

    /**
     * @returns {number} the width the taskbar needs to show every app
     */
    get fullWidth() {
        const {lead, apps} = this._widths();
        return this.get_theme_node().adjust_preferred_width(0, lead + apps)[1];
    }

    _widths() {
        const spacing = this.get_theme_node().get_length('spacing');
        const showApps = this._showApps?.visible
            ? this._showApps.get_preferred_width(-1)[1] : 0;
        return {
            spacing,
            lead: showApps ? showApps + spacing : 0,
            apps: this._scrollView.get_preferred_width(-1)[1],
            arrow: this._prevArrow.get_preferred_width(-1)[1],
        };
    }

    vfunc_get_preferred_width(forHeight) {
        const node = this.get_theme_node();
        node.adjust_for_height(forHeight);
        const {spacing, lead, apps, arrow} = this._widths();

        // At the least, both arrows and one app button.
        const button = this._appBox.get_first_child()?.get_preferred_width(-1)[1] ?? 0;
        const min = lead + Math.min(apps, 2 * (arrow + spacing) + button);
        let [minWidth, natWidth] = node.adjust_preferred_width(min, lead + apps);
        if (this._maxWidth >= 0)
            natWidth = Math.max(minWidth, Math.min(natWidth, this._maxWidth));
        return [minWidth, natWidth];
    }

    vfunc_get_preferred_height(forWidth) {
        const node = this.get_theme_node();
        node.adjust_for_width(forWidth);
        let min = 0, nat = 0;
        for (const child of this.get_children()) {
            const [childMin, childNat] = child.get_preferred_height(-1);
            min = Math.max(min, childMin);
            nat = Math.max(nat, childNat);
        }
        return node.adjust_preferred_height(min, nat);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const width = content.get_width();
        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
        const {spacing, lead, apps, arrow} = this._widths();

        // Lay children out from the start edge, mirrored for RTL.
        const place = (actor, start, childWidth) => {
            const childBox = new Clutter.ActorBox();
            childBox.x1 = rtl
                ? content.x2 - start - childWidth
                : content.x1 + start;
            childBox.x2 = childBox.x1 + childWidth;
            childBox.y1 = content.y1;
            childBox.y2 = content.y2;
            actor.allocate(childBox);
        };

        if (this._showApps?.visible)
            place(this._showApps, 0, lead - spacing);

        const rest = Math.max(0, width - lead);
        const overflowing = apps > rest + 0.5;
        if (overflowing) {
            const arrowSpace = arrow + spacing;
            place(this._prevArrow, lead, arrow);
            place(this._scrollView, lead + arrowSpace,
                Math.max(0, rest - 2 * arrowSpace));
            place(this._nextArrow, width - arrow, arrow);
        } else {
            place(this._prevArrow, lead, 0);
            place(this._scrollView, lead, rest);
            place(this._nextArrow, width, 0);
        }

        if (overflowing !== this._overflowing) {
            this._overflowing = overflowing;
            this._syncArrows();
            if (overflowing)
                this._queueRevealFocused();
        }
    }

    _syncArrows() {
        const adj = this._scrollView.hadjustment;
        const atStart = adj.value <= adj.lower + 0.5;
        const atEnd = adj.value >= adj.upper - adj.page_size - 0.5;
        for (const [arrow, blocked] of [[this._prevArrow, atStart], [this._nextArrow, atEnd]]) {
            arrow.reactive = this._overflowing && !blocked;
            if (!this._overflowing)
                arrow.opacity = 0;
            else
                arrow.opacity = blocked ? 90 : 255;
        }
    }

    _clampScroll(value) {
        const adj = this._scrollView.hadjustment;
        return Math.clamp(value, adj.lower, Math.max(adj.lower, adj.upper - adj.page_size));
    }

    _scrollTo(value, animate = true) {
        const adj = this._scrollView.hadjustment;
        value = this._clampScroll(value);
        adj.remove_transition('value');
        if (!animate) {
            this._scrollTarget = null;
            adj.value = value;
            return;
        }
        this._scrollTarget = value;
        adj.ease(value, {
            duration: SCROLL_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._scrollTarget = null;
            },
        });
    }

    _scrollBy(delta, animate = true) {
        const from = this._scrollTarget ?? this._scrollView.hadjustment.value;
        this._scrollTo(from + delta, animate);
    }

    _scrollPage(direction) {
        // Keep one button of the old view in sight as a reference point.
        const page = this._scrollView.hadjustment.page_size;
        this._scrollBy(direction * Math.max(this._buttonWidth(), page - this._buttonWidth()));
    }

    _buttonWidth() {
        const button = this._appBox.get_first_child();
        const spacing = this._appBox.get_theme_node().get_length('spacing');
        return (button ? button.width : this.iconSize) + spacing;
    }

    _onScroll(event) {
        if (!this._overflowing)
            return Clutter.EVENT_PROPAGATE;

        const step = this._buttonWidth();
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.LEFT:
            this._scrollBy(-step);
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.RIGHT:
            this._scrollBy(step);
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
            // A wheel notch is a delta of 1; touchpads send small, frequent
            // deltas that should follow the fingers without easing.
            const wheel = event.get_scroll_source() === Clutter.ScrollSource.WHEEL;
            if (wheel)
                this._scrollBy(delta * step);
            else
                this._scrollBy(delta * SMOOTH_SCROLL_PX, false);
            break;
        }
        }
        return Clutter.EVENT_STOP;
    }

    _queueRevealFocused() {
        if (this._revealLaterId)
            return;
        // Wait for the buttons to be allocated before measuring them.
        const laters = global.compositor.get_laters();
        this._revealLaterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._revealLaterId = 0;
            const focusApp = Shell.WindowTracker.get_default().focus_app;
            const button = focusApp && this._buttons.get(focusApp);
            if (button && this._overflowing)
                this._reveal(button);
            return GLib.SOURCE_REMOVE;
        });
    }

    _reveal(button) {
        const adj = this._scrollView.hadjustment;
        const {x1, x2} = button.get_allocation_box();
        const margin = this._buttonWidth() / 2;
        const value = this._scrollTarget ?? adj.value;
        if (x1 < value)
            this._scrollTo(x1 - margin);
        else if (x2 > value + adj.page_size)
            this._scrollTo(x2 - adj.page_size + margin);
    }

    get monitorIndex() {
        return this._monitorIndex ?? Main.layoutManager.primaryIndex;
    }

    get isPrimary() {
        return this._monitorIndex === null;
    }

    get settings() {
        return this._settings;
    }

    filterWindows(windows) {
        const isolateWorkspaces = this._settings.get_boolean('isolate-workspaces');
        const isolateMonitors = this._settings.get_boolean('isolate-monitors');
        const activeWs = global.workspace_manager.get_active_workspace();
        const monitor = this.monitorIndex;
        return windows.filter(w =>
            !w.skip_taskbar &&
            w.get_window_type() !== Meta.WindowType.DESKTOP &&
            (!isolateWorkspaces || w.located_on_workspace(activeWs)) &&
            (!isolateMonitors || w.get_monitor() === monitor));
    }

    _queueRedisplay() {
        if (this._redisplayId)
            return;
        this._redisplayId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._redisplayId = 0;
            this._redisplay();
            return GLib.SOURCE_REMOVE;
        });
    }

    _getApps() {
        const apps = [];
        const seen = new Set();

        if (this._settings.get_boolean('show-favorites')) {
            for (const app of AppFavorites.getAppFavorites().getFavorites()) {
                apps.push(app);
                seen.add(app);
            }
        }

        // Keep running apps in the order they were first seen so icons do
        // not jump around whenever focus changes.
        const running = Shell.AppSystem.get_default().get_running()
            .filter(app => this.filterWindows(app.get_windows()).length > 0);
        this._runningOrder = this._runningOrder.filter(app => running.includes(app));
        for (const app of running) {
            if (!this._runningOrder.includes(app))
                this._runningOrder.push(app);
        }

        for (const app of this._runningOrder) {
            if (!seen.has(app))
                apps.push(app);
        }
        return apps;
    }

    _redisplay() {
        // Reordering under a drag would fight the live preview of the drop
        // position; dragEnd() redisplays once the drag is over.
        if (this._draggedButton || this._dropPlaceholder)
            return;

        const apps = this._getApps();
        const wanted = new Set(apps);

        for (const [app, button] of this._buttons) {
            if (!wanted.has(app)) {
                app.disconnectObject(this);
                button.destroy();
                this._buttons.delete(app);
            }
        }

        apps.forEach((app, index) => {
            let button = this._buttons.get(app);
            if (!button) {
                button = new TaskbarAppButton(app, this);
                this._buttons.set(app, button);
                this._appBox.insert_child_at_index(button, index);
                // Window lists change without the app changing state, so
                // connect per-app to keep the dots accurate.
                app.connectObject('windows-changed',
                    () => this._queueRedisplay(), this);
            } else if (this._appBox.get_child_at_index(index) !== button) {
                this._appBox.set_child_at_index(button, index);
            }
            button.sync();
        });

        // Scroll a newly focused app into view, e.g. one just opened at
        // the end of a long row.
        const focusApp = Shell.WindowTracker.get_default().focus_app;
        if (focusApp !== this._focusApp) {
            this._focusApp = focusApp;
            this._queueRevealFocused();
        }
    }

    _refreshIcons() {
        for (const button of this._buttons.values())
            button.setIconSize(this.iconSize);
    }

    // Drag-and-drop: pinned apps can be reordered, and running apps or icons
    // from the app grid can be dropped among them to pin them.

    dragBegin(button) {
        this._draggedButton = button;
        button.opacity = 100;
    }

    dragEnd() {
        if (this._draggedButton)
            this._draggedButton.opacity = 255;
        this._draggedButton = null;
        this._clearDropTarget();
        this._redisplay();
    }

    _numFavorites() {
        return [...this._buttons.keys()].filter(app =>
            AppFavorites.getAppFavorites().isFavorite(app.get_id())).length;
    }

    _canDrop(source) {
        const app = source?.app;
        return app instanceof Shell.App &&
            !app.is_window_backed() &&
            this._settings.get_boolean('show-favorites') &&
            global.settings.is_writable('favorite-apps');
    }

    handleDragOver(source, _actor, x) {
        if (!this._canDrop(source))
            return DND.DragMotionResult.NO_DROP;

        // A button from this taskbar moves itself as a live preview; anything
        // else gets a placeholder gap.
        const ownButton = source === this._draggedButton ? source : null;
        const others = this._appBox.get_children().filter(child =>
            child !== ownButton && child !== this._dropPlaceholder);

        let pos = others.filter(child => {
            const box = child.get_allocation_box();
            return (box.x1 + box.x2) / 2 < x;
        }).length;
        if (this.get_text_direction() === Clutter.TextDirection.RTL)
            pos = others.length - pos;

        const isFavorite = AppFavorites.getAppFavorites().isFavorite(source.app.get_id());
        const nFavorites = this._numFavorites() - (isFavorite && ownButton ? 1 : 0);
        pos = Math.min(pos, nFavorites);

        // Near an edge of a scrolled row, bring the hidden buttons in.
        if (this._overflowing) {
            const adj = this._scrollView.hadjustment;
            const edge = this._buttonWidth() / 2;
            if (x < adj.value + edge)
                this._scrollBy(-DRAG_SCROLL_PX, false);
            else if (x > adj.value + adj.page_size - edge)
                this._scrollBy(DRAG_SCROLL_PX, false);
        }

        if (pos !== this._dropPos) {
            this._dropPos = pos;
            if (ownButton) {
                this._appBox.set_child_at_index(ownButton, pos);
            } else {
                if (!this._dropPlaceholder) {
                    this._dropPlaceholder = new St.Widget({
                        style_class: 'tideline-drop-placeholder',
                        width: this.iconSize,
                    });
                    this._appBox.add_child(this._dropPlaceholder);
                }
                this._appBox.set_child_at_index(this._dropPlaceholder, pos);
            }
        }

        this._ensureDragMonitor();
        return DND.DragMotionResult.MOVE_DROP;
    }

    acceptDrop(source) {
        if (!this._canDrop(source) || this._dropPos < 0)
            return false;

        // Favorites always come first, so the drop position is also the
        // position among favorites.
        const id = source.app.get_id();
        const pos = this._dropPos;
        const appFavorites = AppFavorites.getAppFavorites();
        const laters = global.compositor.get_laters();
        laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            if (appFavorites.isFavorite(id))
                appFavorites.moveFavoriteToPos(id, pos);
            else
                appFavorites.addFavoriteAtPos(id, pos);
            return GLib.SOURCE_REMOVE;
        });

        this._clearDropTarget();
        return true;
    }

    _ensureDragMonitor() {
        if (this._dragMonitor)
            return;

        // Undo the drop preview when the pointer leaves this taskbar, and
        // clean up however the drag ends.
        this._dragMonitor = {
            dragMotion: event => {
                if (!this._appBox.contains(event.targetActor)) {
                    this._clearDropTarget();
                    if (!this._draggedButton)
                        this._redisplay();
                }
                return DND.DragMotionResult.CONTINUE;
            },
            dragDrop: event => {
                if (!this._appBox.contains(event.targetActor)) {
                    this._clearDropTarget();
                    this._queueRedisplay();
                }
                return DND.DragDropResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);
    }

    _clearDropTarget() {
        this._dropPos = -1;
        this._dropPlaceholder?.destroy();
        this._dropPlaceholder = null;
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
    }

    _onDestroy() {
        this._clearDropTarget();
        if (this._revealLaterId) {
            global.compositor.get_laters().remove(this._revealLaterId);
            this._revealLaterId = 0;
        }
        this._scrollView.hadjustment.remove_transition('value');
        this._scrollView.hadjustment.disconnectObject(this);
        if (this._redisplayId) {
            GLib.source_remove(this._redisplayId);
            this._redisplayId = 0;
        }
        for (const app of this._buttons.keys())
            app.disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        AppFavorites.getAppFavorites().disconnectObject(this);
        Shell.WindowTracker.get_default().disconnectObject(this);
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        St.TextureCache.get_default().disconnectObject(this);
        this._buttons.clear();
    }
});
