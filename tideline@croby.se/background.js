import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TRANSITION_MS = 250;

/**
 * Paints the taskbar backgrounds so they can fade between a translucent and
 * a solid colour depending on whether a maximized window is on the same
 * monitor. The primary taskbar's background is drawn on the panel box;
 * secondary bars are added with addTarget().
 *
 * With the Zones style, each bar is split into rounded zones (Activities,
 * apps, clock) that carry the translucent colour while the bar itself stays
 * clear. A maximized window brings back the single solid bar.
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
        this._zones = settings.get_boolean('zones');
        this._zoneGeometry = {
            radius: settings.get_int('zone-radius'),
            float: settings.get_int('zone-float'),
            gap: settings.get_int('zone-gap'),
            padding: settings.get_int('zone-padding'),
        };
        // bar actor -> {getMonitor, zones}
        this._targets = new Map();
        this.addTarget(Main.layoutManager.panelBox, null,
            [Main.panel._leftBox, Main.panel._centerBox, Main.panel._rightBox]);

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

    /**
     * @param {Clutter.Actor} actor - the whole bar
     * @param {number|null} monitorIndex - its monitor, or null for the primary
     * @param {Clutter.Actor[]} zones - the bar's zones, left to right
     */
    addTarget(actor, monitorIndex, zones = []) {
        const getMonitor = () => monitorIndex ?? Main.layoutManager.primaryIndex;
        if (!this._zones)
            zones = [];

        zones.forEach((zone, i) => {
            zone.add_style_class_name('tideline-zone');
            if (i === 0)
                zone.add_style_class_name('tideline-zone-start');
            if (i === zones.length - 1)
                zone.add_style_class_name('tideline-zone-end');
        });

        this._targets.set(actor, {getMonitor, zones});
        this.update();
    }

    removeTarget(actor) {
        const target = this._targets.get(actor);
        if (target)
            this._clearZones(target.zones);
        this._targets.delete(actor);
    }

    _clearZones(zones) {
        for (const zone of zones) {
            zone.set_style(null);
            zone.remove_style_class_name('tideline-zone');
            zone.remove_style_class_name('tideline-zone-start');
            zone.remove_style_class_name('tideline-zone-end');
        }
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

    _style(opacity) {
        const {red, green, blue} = this._color;
        return `background-color: rgba(${red}, ${green}, ${blue}, ${opacity}); ` +
            `transition-duration: ${TRANSITION_MS}ms;`;
    }

    _zoneStyle(zone, opacity) {
        // The shape comes from the Zones settings, so it is inline rather
        // than in the stylesheet; the outer zones also keep a gap to the
        // screen edges.
        const {radius, float, gap, padding} = this._zoneGeometry;
        const left = zone.has_style_class_name('tideline-zone-start') ? gap : 0;
        const right = zone.has_style_class_name('tideline-zone-end') ? gap : 0;
        return `${this._style(opacity)} border-radius: ${radius}px; ` +
            `margin: 0 ${right}px ${float}px ${left}px; padding: 0 ${padding}px;`;
    }

    /**
     * Recompute every background. Call it after zones change contents, e.g.
     * when the Activities button is shown or hidden.
     */
    update() {
        this._update();
    }

    _update() {
        const dynamic = this._settings.get_boolean('dynamic-opacity');
        const translucent = this._settings.get_int('background-opacity') / 100;
        const clearInOverview = this._settings.get_boolean('overview-transparent');

        for (const [actor, {getMonitor, zones}] of this._targets) {
            let barOpacity = 0;
            let zoneOpacity = 0;
            if (this._inOverview && clearInOverview) {
                // Everything clear, so the overview gets the spotlight.
            } else if (dynamic && this._hasMaximizedWindow(getMonitor())) {
                barOpacity = 1;
            } else {
                const opacity = dynamic ? translucent : 1;
                if (zones.length > 0)
                    zoneOpacity = opacity;
                else
                    barOpacity = opacity;
            }

            actor.set_style(this._style(barOpacity));
            for (const zone of zones) {
                // An empty zone (e.g. no Activities button) gets no pill.
                const empty = !zone.get_children().some(child => child.visible);
                zone.set_style(this._zoneStyle(zone, empty ? 0 : zoneOpacity));
            }
        }
    }

    destroy() {
        for (const window of this._windows)
            window.disconnectObject(this);
        this._windows.clear();
        global.display.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        Main.overview.disconnectObject(this);

        for (const [actor, {zones}] of this._targets) {
            actor.set_style(null);
            this._clearZones(zones);
        }
        this._targets.clear();
        Main.panel.remove_style_class_name('tideline-transparent');
    }
}
