import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Smallest space kept between the center zone and its neighbours.
const MIN_ZONE_SPACING = 4;

/**
 * Arrow in the right zone that shows or hides the icons the zone collapsed.
 */
const CollapseToggle = GObject.registerClass(
class CollapseToggle extends St.Button {
    _init() {
        super._init({
            style_class: 'panel-button tideline-zone-toggle',
            reactive: true,
            can_focus: true,
            track_hover: true,
            accessible_name: _('Show more icons'),
        });
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this.set_child(this._icon);
        this.setExpanded(false);
    }

    setExpanded(expanded) {
        // Points to where the icons appear: left to show them, right to
        // push them back behind the arrow.
        const rtl = this.get_text_direction() === Clutter.TextDirection.RTL;
        this._icon.icon_name = expanded !== rtl
            ? 'pan-end-symbolic' : 'pan-start-symbolic';
        this.accessible_name = expanded ? _('Hide icons') : _('Show more icons');
    }
});

/**
 * Keeps the panel's three zones (left, center, right) from overlapping.
 *
 * The stock panel centers the center box and gives each side whatever is
 * left, so a long row of apps or many indicators make them run into each
 * other. This gives the taskbar a maximum width so it stays clear of both
 * sides; once it can't fit next to a full right zone, the right zone
 * collapses to the clock plus an arrow that shows the other icons again.
 * The taskbar scrolls whatever still doesn't fit.
 */
export class ZoneOverflow {
    /**
     * @param {Gio.Settings} settings - the extension's settings
     * @param {Taskbar} taskbar - the taskbar in the panel's center box
     */
    constructor(settings, taskbar) {
        this._taskbar = taskbar;
        this._gap = Math.max(MIN_ZONE_SPACING,
            settings.get_boolean('zones') ? settings.get_int('zone-gap') : 0);
        this._crowded = false;
        this._expanded = false;
        // Right-zone children we hid -> whether their owner wants them shown.
        this._hidden = new Map();
        this._hiding = false;
        this._laterId = 0;

        const panel = Main.panel;
        this._toggle = new CollapseToggle();
        this._toggle.hide();
        this._toggle.connect('clicked', () => {
            this._expanded = !this._expanded;
            this._update();
        });
        const clock = this._clock;
        const children = panel._rightBox.get_children();
        const index = clock ? children.indexOf(clock) : -1;
        panel._rightBox.insert_child_at_index(this._toggle,
            index >= 0 ? index : children.length);

        const queue = () => this._queueUpdate();
        for (const actor of [panel, panel._leftBox, panel._centerBox, taskbar])
            actor.connectObject('notify::allocation', queue, this);
        panel._rightBox.connectObject(
            'notify::allocation', queue,
            'child-added', (_box, child) => {
                if (this._hidden.size > 0 && this._isCollapsible(child))
                    this._hideChild(child);
                queue();
            },
            'child-removed', (_box, child) => {
                this._showChild(child);
                queue();
            },
            this);

        this._update();
    }

    get _clock() {
        return Main.panel.statusArea.dateMenu?.container ?? null;
    }

    _isCollapsible(child) {
        return child !== this._toggle && child !== this._clock;
    }

    _queueUpdate() {
        // Allocation signals arrive mid-layout; changing sizes then would
        // fight the layout in progress, so wait for the next frame.
        if (this._laterId)
            return;
        const laters = global.compositor.get_laters();
        this._laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._laterId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        const panel = Main.panel;
        const width = panel.get_allocation_box().get_width();
        if (!width)
            return;

        const natural = actor => actor.get_preferred_width(-1)[1];

        // The panel centers the center box on the work area rather than
        // the monitor; mirror its arithmetic (see Panel.vfunc_allocate).
        let offset = 0;
        const monitor = Main.layoutManager.findMonitorForActor(panel);
        if (monitor) {
            const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
            offset = 2 * (workArea.x - monitor.x) + workArea.width - monitor.width;
        }
        const rtl = panel.get_text_direction() === Clutter.TextDirection.RTL;
        const leftWidth = natural(panel._leftBox);

        // Width of the center box when it sits between a left zone and a
        // right zone this wide, without either overlapping it.
        const centerLimit = rightWidth => {
            const [startSide, endSide] = rtl
                ? [rightWidth, leftWidth] : [leftWidth, rightWidth];
            return Math.min(
                width + offset - 2 * (startSide + this._gap),
                width - offset - 2 * (endSide + this._gap));
        };

        // The right zone's width with every icon showing, and collapsed to
        // the arrow and the clock.
        const rightBox = panel._rightBox;
        const spacing = rightBox.layout_manager?.spacing ?? 0;
        let hiddenWidth = 0;
        let collapsibleWidth = 0;
        for (const child of rightBox.get_children()) {
            if (!this._isCollapsible(child))
                continue;
            const wanted = this._hidden.get(child) ?? child.visible;
            if (!wanted)
                continue;
            const childWidth = natural(child) + spacing;
            collapsibleWidth += childWidth;
            if (!child.visible)
                hiddenWidth += childWidth;
        }
        const toggleWidth = natural(this._toggle) + spacing;
        const expandedWidth = natural(rightBox) + hiddenWidth -
            (this._toggle.visible ? toggleWidth : 0);
        const collapsedWidth = expandedWidth - collapsibleWidth + toggleWidth;

        // Whatever else shares the center box with the taskbar, such as
        // the clock when it is centered.
        const centerExtra = natural(panel._centerBox) - natural(this._taskbar);
        const needed = centerExtra + this._taskbar.fullWidth;

        const crowded = collapsibleWidth > 0 && needed > centerLimit(expandedWidth);
        if (crowded !== this._crowded) {
            this._crowded = crowded;
            this._expanded = false;
        }
        // Showing everything must still leave room for a usable taskbar;
        // on a screen too narrow for that, the arrow stays greyed out.
        const [taskbarMin] = this._taskbar.get_preferred_width(-1);
        const canExpand =
            centerLimit(expandedWidth + toggleWidth) - centerExtra >= taskbarMin;
        if (!canExpand)
            this._expanded = false;

        this._toggle.visible = crowded;
        this._toggle.reactive = canExpand;
        this._toggle.opacity = canExpand ? 255 : 128;
        this._toggle.setExpanded(this._expanded);
        this._setCollapsed(crowded && !this._expanded);

        let rightWidth = expandedWidth;
        if (crowded)
            rightWidth = this._expanded ? expandedWidth + toggleWidth : collapsedWidth;
        this._taskbar.setMaxWidth(
            Math.max(0, Math.floor(centerLimit(rightWidth) - centerExtra)));
    }

    _setCollapsed(collapsed) {
        if (collapsed) {
            for (const child of Main.panel._rightBox.get_children()) {
                if (this._isCollapsible(child) && !this._hidden.has(child))
                    this._hideChild(child);
            }
        } else {
            for (const child of [...this._hidden.keys()])
                this._showChild(child);
        }
    }

    _hideChild(child) {
        this._hidden.set(child, child.visible);
        // Indicators show and hide themselves (e.g. when a device appears);
        // remember what they asked for and keep them hidden for now.
        child.connectObject(
            'notify::visible', () => {
                if (this._hiding)
                    return;
                this._hidden.set(child, child.visible);
                if (child.visible)
                    this._setVisible(child, false);
                this._queueUpdate();
            },
            'destroy', () => this._hidden.delete(child),
            this);
        this._setVisible(child, false);
    }

    _showChild(child) {
        if (!this._hidden.has(child))
            return;
        const wanted = this._hidden.get(child);
        this._hidden.delete(child);
        child.disconnectObject(this);
        this._setVisible(child, wanted);
    }

    _setVisible(child, visible) {
        this._hiding = true;
        child.visible = visible;
        this._hiding = false;
    }

    destroy() {
        if (this._laterId) {
            global.compositor.get_laters().remove(this._laterId);
            this._laterId = 0;
        }
        const panel = Main.panel;
        for (const actor of [panel, panel._leftBox, panel._centerBox,
            panel._rightBox, this._taskbar])
            actor.disconnectObject(this);
        this._setCollapsed(false);
        this._toggle.destroy();
        this._toggle = null;
        this._taskbar.setMaxWidth(-1);
        this._taskbar = null;
    }
}
