import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TRANSITION_MS = 250;

/**
 * Paints the taskbar backgrounds so they can fade between a translucent and
 * a solid colour depending on whether a maximized window is on the same
 * monitor. The primary taskbar's background is drawn on the panel box;
 * secondary bars are added with addTarget().
 *
 * The overview overwrites Main.panel's inline style when it opens and
 * closes, so the colour lives on the panel box instead and the panel itself
 * is made transparent by the stylesheet.
 */
export class DynamicBackground {
    constructor(settings) {
        this._settings = settings;
        this._color = this._parseColor(settings.get_string('background-color'));
        this._windows = new Set();
        this._inOverview = Main.overview.visible;
        // actor -> function returning the monitor index the actor is on
        this._targets = new Map([
            [Main.layoutManager.panelBox, () => Main.layoutManager.primaryIndex],
        ]);

        Main.panel.add_style_class_name('tideline-transparent');

        if (settings.get_boolean('dynamic-opacity')) {
            global.display.connectObject(
                'window-created', (_display, window) => this._trackWindow(window),
                'window-entered-monitor', () => this._update(),
                'window-left-monitor', () => this._update(),
                this);
            global.workspace_manager.connectObject(
                'active-workspace-changed', () => this._update(), this);

            for (const actor of global.get_window_actors())
                this._trackWindow(actor.meta_window);
        }

        // Track the overview ourselves: Main.overview.visible stays true
        // until the closing animation ends, and the bar should start fading
        // back as soon as it begins.
        Main.overview.connectObject(
            'showing', () => {
                this._inOverview = true;
                this._update();
            },
            'hiding', () => {
                this._inOverview = false;
                this._update();
            },
            this);

        this._update();
    }

    _parseColor(hex) {
        // Expects '#rrggbb', as written by the preferences; anything else
        // falls back to black.
        const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
        if (!match)
            return {red: 0, green: 0, blue: 0};
        const [red, green, blue] = match.slice(1).map(h => parseInt(h, 16));
        return {red, green, blue};
    }

    addTarget(actor, monitorIndex) {
        this._targets.set(actor, () => monitorIndex);
        this._update();
    }

    removeTarget(actor) {
        this._targets.delete(actor);
    }

    _trackWindow(window) {
        if (this._windows.has(window))
            return;

        this._windows.add(window);
        window.connectObject(
            'notify::maximized-horizontally', () => this._update(),
            'notify::maximized-vertically', () => this._update(),
            'notify::minimized', () => this._update(),
            'workspace-changed', () => this._update(),
            'unmanaged', () => {
                window.disconnectObject(this);
                this._windows.delete(window);
                this._update();
            },
            this);
        this._update();
    }

    _hasMaximizedWindow(monitor) {
        if (this._inOverview)
            return false;

        const workspace = global.workspace_manager.get_active_workspace();
        return [...this._windows].some(w =>
            w.get_window_type() === Meta.WindowType.NORMAL &&
            w.is_maximized() &&
            !w.minimized &&
            w.get_monitor() === monitor &&
            w.located_on_workspace(workspace));
    }

    _update() {
        const dynamic = this._settings.get_boolean('dynamic-opacity');
        const translucent = this._settings.get_int('background-opacity') / 100;
        const {red, green, blue} = this._color;

        const clearInOverview = this._settings.get_boolean('overview-transparent');

        for (const [actor, getMonitor] of this._targets) {
            let opacity;
            if (this._inOverview && clearInOverview)
                opacity = 0;
            else if (!dynamic || this._hasMaximizedWindow(getMonitor()))
                opacity = 1;
            else
                opacity = translucent;
            actor.set_style(
                `background-color: rgba(${red}, ${green}, ${blue}, ${opacity}); ` +
                `transition-duration: ${TRANSITION_MS}ms;`);
        }
    }

    destroy() {
        for (const window of this._windows)
            window.disconnectObject(this);
        this._windows.clear();
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.overview.disconnectObject(this);

        Main.layoutManager.panelBox.set_style(null);
        this._targets.clear();
        Main.panel.remove_style_class_name('tideline-transparent');
    }
}
