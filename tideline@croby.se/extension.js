import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ExtensionState} from 'resource:///org/gnome/shell/misc/extensionUtils.js';

import {DynamicBackground} from './background.js';
import {previews} from './previews.js';
import {SecondaryBar} from './secondaryBar.js';
import {Taskbar} from './taskbar.js';

const CONFLICTING_EXTENSIONS = [
    'ubuntu-dock@ubuntu.com',
    'dash-to-dock@micxgx.gmail.com',
    'dash-to-panel@jderose9.github.com',
];

export default class TidelineExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._injections = new InjectionManager();
        this._setup();

        this._settings.connectObject('changed', () => {
            this._teardown();
            this._setup();
        }, this);

        this._warnAboutConflicts();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._teardown();
        this._injections = null;
        this._settings = null;
    }

    _setup() {
        const panel = Main.panel;
        const layoutManager = Main.layoutManager;

        this._background = new DynamicBackground(this._settings);
        panel.add_style_class_name('tideline-panel');
        // Not an inline style: the overview resets Main.panel.style.
        panel.set_height(this._settings.get_int('panel-height'));

        this._movePanelToBottom();
        this._setupActivities();
        this._setupClock();

        this._taskbar = new Taskbar(this._settings);
        panel._centerBox.insert_child_at_index(this._taskbar, 0);

        // Panel menus normally drop down; make them pop up instead, including
        // for indicators that other extensions add later.
        for (const indicator of Object.values(panel.statusArea))
            this._setMenuSide(indicator, St.Side.BOTTOM);
        const ext = this;
        this._injections.overrideMethod(panel, 'addToStatusArea', original =>
            function (...args) {
                const indicator = original.apply(this, args);
                ext._setMenuSide(indicator, St.Side.BOTTOM);
                return indicator;
            });

        this._setupOverviewDash();

        this._secondaryBars = [];
        this._setupSecondaryBars();

        layoutManager.connectObject(
            'startup-complete', () => this._placePanel(),
            'monitors-changed', () => this._setupSecondaryBars(),
            this);
    }

    _teardown() {
        const panel = Main.panel;
        const layoutManager = Main.layoutManager;

        layoutManager.disconnectObject(this);
        layoutManager.panelBox.disconnectObject(this);
        this._injections.clear();

        for (const indicator of Object.values(panel.statusArea))
            this._setMenuSide(indicator, St.Side.TOP);

        previews.close();
        this._destroySecondaryBars();
        this._taskbar?.destroy();
        this._taskbar = null;

        this._restoreClock();
        panel.statusArea.activities?.container.show();
        this._restoreOverviewDash();

        this._background?.destroy();
        this._background = null;
        panel.set_height(-1);
        panel.remove_style_class_name('tideline-panel');

        // Put the panel and its pointer barrier back where the shell wants them.
        layoutManager._updateBoxes();
        layoutManager._updatePanelBarrier();
    }

    _setupSecondaryBars() {
        this._destroySecondaryBars();
        if (!this._settings.get_boolean('multi-monitor'))
            return;

        const {monitors, primaryIndex} = Main.layoutManager;
        for (let i = 0; i < monitors.length; i++) {
            if (i === primaryIndex)
                continue;
            const bar = new SecondaryBar(this._settings, i);
            this._background.addTarget(bar, i);
            this._secondaryBars.push(bar);
        }
    }

    _destroySecondaryBars() {
        for (const bar of this._secondaryBars ?? []) {
            this._background?.removeTarget(bar);
            bar.destroy();
        }
        this._secondaryBars = [];
    }

    _movePanelToBottom() {
        const layoutManager = Main.layoutManager;
        const ext = this;

        this._injections.overrideMethod(layoutManager, '_updateBoxes', original =>
            function (...args) {
                original.apply(this, args);
                ext._placePanel();
            });

        // The stock barrier stops the pointer at the top-right corner of the
        // panel; move it to the bottom edge so it still guards the corner.
        this._injections.overrideMethod(layoutManager, '_updatePanelBarrier', () =>
            function () {
                this._destroyPanelBarrier();

                const primary = this.primaryMonitor;
                if (!primary || !this.panelBox.height)
                    return;

                const bottom = primary.y + primary.height;
                this._rightPanelBarrier = new Meta.Barrier({
                    backend: global.backend,
                    x1: primary.x + primary.width, y1: bottom - this.panelBox.height,
                    x2: primary.x + primary.width, y2: bottom,
                    directions: Meta.BarrierDirection.NEGATIVE_X,
                });
            });

        layoutManager.panelBox.connectObject('notify::height',
            () => this._placePanel(), this);

        layoutManager._updateBoxes();
        layoutManager._updatePanelBarrier();
    }

    _placePanel() {
        const {panelBox, primaryMonitor} = Main.layoutManager;
        if (!primaryMonitor)
            return;

        // The startup animation slides the panel in from above; it would look
        // wrong at the bottom, so skip straight to the final position.
        panelBox.translation_y = 0;
        panelBox.set_position(primaryMonitor.x,
            primaryMonitor.y + primaryMonitor.height - panelBox.height);
    }

    _setupActivities() {
        const activities = Main.panel.statusArea.activities?.container;
        if (activities)
            activities.visible = this._settings.get_boolean('show-activities');
    }

    _setupClock() {
        const clock = Main.panel.statusArea.dateMenu?.container;
        if (!clock || this._settings.get_string('clock-position') !== 'right')
            return;

        const parent = clock.get_parent();
        this._clockOrigin = {parent, index: parent.get_children().indexOf(clock)};
        parent.remove_child(clock);
        Main.panel._rightBox.add_child(clock);
    }

    _restoreClock() {
        if (!this._clockOrigin)
            return;

        const clock = Main.panel.statusArea.dateMenu?.container;
        const {parent, index} = this._clockOrigin;
        this._clockOrigin = null;
        if (!clock)
            return;

        clock.get_parent()?.remove_child(clock);
        parent.insert_child_at_index(clock, index);
    }

    _setupOverviewDash() {
        const dash = Main.overview.dash;
        if (!dash || !this._settings.get_boolean('hide-overview-dash'))
            return;

        // The overview's layout asks the dash for its height directly, so pin
        // it to zero. Hiding it instead would stop its icons from being
        // styled, which makes the dash's own icon sizing code throw.
        this._dashHidden = true;
        dash.set_height(0);
        dash.opacity = 0;
        dash.reactive = false;
        dash.set_clip_to_allocation(true);
    }

    _restoreOverviewDash() {
        if (!this._dashHidden)
            return;

        this._dashHidden = false;
        const dash = Main.overview.dash;
        dash.set_height(-1);
        dash.opacity = 255;
        dash.reactive = true;
        dash.set_clip_to_allocation(false);
    }

    _setMenuSide(indicator, side) {
        const menu = indicator?.menu;
        if (!menu?._boxPointer)
            return;

        menu._arrowSide = side;
        menu._boxPointer.updateArrowSide(side);
    }

    _warnAboutConflicts() {
        const active = CONFLICTING_EXTENSIONS.filter(uuid =>
            Main.extensionManager.lookup(uuid)?.state === ExtensionState.ACTIVE);
        if (active.length > 0) {
            console.warn(`${this.uuid}: these extensions also change the dock ` +
                `or panel and may conflict: ${active.join(', ')}`);
        }
    }
}
