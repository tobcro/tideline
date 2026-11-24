import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const TRANSITION_MS = 250;

// Uncovered strips this thin or thinner still count as covered, so rounding
// in tiled layouts (e.g. an odd width split in two) doesn't keep the bar
// translucent.
const COVER_TOLERANCE_PX = 2;

const BLACK = {red: 0, green: 0, blue: 0};

/**
 * Parse a '#rrggbb' colour, as the preferences write it.
 *
 * @param {string} hex - the colour
 * @param {object} fallback - returned when hex is not a valid colour
 * @returns {{red: number, green: number, blue: number}}
 */
export function parseColor(hex, fallback = BLACK) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    if (!match)
        return fallback;
    const [red, green, blue] = match.slice(1).map(h => parseInt(h, 16));
    return {red, green, blue};
}

/**
 * Paints the taskbar backgrounds so they can fade between a translucent and
 * a solid colour depending on whether a maximized window is on the same
 * monitor (or windows tiled to fill it). The primary taskbar's background is drawn on the panel box;
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
        this._color = parseColor(settings.get_string('background-color'));
        this._border = settings.get_boolean('border');
        this._borderColor = parseColor(settings.get_string('border-color'));
        this._borderOpacity = settings.get_int('border-opacity') / 100;
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
            // Tiled windows fill the screen without being maximized.
            'size-changed', () => this._queueUpdate(),
            'position-changed', () => this._queueUpdate(),
            'unmanaged', () => {
                window.disconnectObject(this);
                this._windows.delete(window);
                this._update();
            },
            this);
        this._update();
    }

    /**
     * Whether the monitor's work area is filled by windows: one maximized
     * window, or several (e.g. tiled side by side) that together leave no
     * gaps.
     *
     * @param {number} monitor - the monitor index
     * @returns {boolean}
     */
    _isCovered(monitor) {
        if (this._inOverview)
            return false;

        const workspace = global.workspace_manager.get_active_workspace();
        const windows = [...this._windows].filter(w =>
            w.get_window_type() === Meta.WindowType.NORMAL &&
            !w.minimized &&
            w.get_monitor() === monitor &&
            w.located_on_workspace(workspace));

        if (windows.some(w => w.is_maximized()))
            return true;
        if (windows.length < 2)
            return false;

        const area = workspace.get_work_area_for_monitor(monitor);
        const rects = windows.map(w => w.get_frame_rect());
        return this._rectsCover(area, rects);
    }

    _rectsCover(area, rects) {
        const x1 = area.x, y1 = area.y;
        const x2 = area.x + area.width, y2 = area.y + area.height;
        const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

        // Split the work area along every window edge; each cell of the
        // resulting grid is then either entirely inside a window or not.
        const xs = new Set([x1, x2]);
        const ys = new Set([y1, y2]);
        for (const r of rects) {
            xs.add(clamp(r.x, x1, x2)).add(clamp(r.x + r.width, x1, x2));
            ys.add(clamp(r.y, y1, y2)).add(clamp(r.y + r.height, y1, y2));
        }
        const sortedXs = [...xs].sort((a, b) => a - b);
        const sortedYs = [...ys].sort((a, b) => a - b);

        for (let i = 0; i < sortedXs.length - 1; i++) {
            const left = sortedXs[i], right = sortedXs[i + 1];
            if (right - left <= COVER_TOLERANCE_PX)
                continue;
            for (let j = 0; j < sortedYs.length - 1; j++) {
                const top = sortedYs[j], bottom = sortedYs[j + 1];
                if (bottom - top <= COVER_TOLERANCE_PX)
                    continue;
                const covered = rects.some(r =>
                    r.x <= left && r.x + r.width >= right &&
                    r.y <= top && r.y + r.height >= bottom);
                if (!covered)
                    return false;
            }
        }
        return true;
    }

    _style(opacity) {
        const {red, green, blue} = this._color;
        return `background-color: rgba(${red}, ${green}, ${blue}, ${opacity}); ` +
            `transition-duration: ${TRANSITION_MS}ms;`;
    }

    _borderStyle(visible) {
        // The width stays the same and only the colour fades, so showing or
        // hiding the border never shifts the layout.
        const {red, green, blue} = this._borderColor;
        const alpha = visible ? this._borderOpacity : 0;
        return ` border: 1px solid rgba(${red}, ${green}, ${blue}, ${alpha});`;
    }

    _zoneStyle(zone, opacity, showBorder) {
        // The shape comes from the Zones settings, so it is inline rather
        // than in the stylesheet; the outer zones also keep a gap to the
        // screen edges.
        const {radius, float, gap, padding} = this._zoneGeometry;
        const left = zone.has_style_class_name('tideline-zone-start') ? gap : 0;
        const right = zone.has_style_class_name('tideline-zone-end') ? gap : 0;
        return `${this._style(opacity)} border-radius: ${radius}px; ` +
            `margin: 0 ${right}px ${float}px ${left}px; padding: 0 ${padding}px;` +
            (this._border ? this._borderStyle(showBorder) : '');
    }

    /**
     * Recompute every background. Call it after zones change contents, e.g.
     * when the Activities button is shown or hidden.
     */
    update() {
        this._update();
    }

    // Moving or resizing a window fires many signals in a row; recompute
    // once they settle.
    _queueUpdate() {
        if (this._updateId)
            return;
        this._updateId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._updateId = 0;
            this._update();
            return GLib.SOURCE_REMOVE;
        });
    }

    _update() {
        const dynamic = this._settings.get_boolean('dynamic-opacity');
        const translucent = this._settings.get_int('background-opacity') / 100;
        const clearInOverview = this._settings.get_boolean('overview-transparent');

        for (const [actor, {getMonitor, zones}] of this._targets) {
            let barOpacity = 0;
            let zoneOpacity = 0;
            // The border only shows in the normal state: not in the
            // overview, and not over a maximized window's solid bar.
            let showBorder = false;
            if (this._inOverview && clearInOverview) {
                // Everything clear, so the overview gets the spotlight.
            } else if (dynamic && this._isCovered(getMonitor())) {
                barOpacity = 1;
            } else {
                const opacity = dynamic ? translucent : 1;
                if (zones.length > 0)
                    zoneOpacity = opacity;
                else
                    barOpacity = opacity;
                showBorder = true;
            }

            // In Zones mode the bar itself never gets a border, so it needs
            // no border width at all.
            const barBorder = this._border && zones.length === 0
                ? this._borderStyle(showBorder) : '';
            actor.set_style(this._style(barOpacity) + barBorder);
            for (const zone of zones) {
                // An empty zone (e.g. no Activities button) gets no pill.
                const empty = !zone.get_children().some(child => child.visible);
                zone.set_style(this._zoneStyle(zone, empty ? 0 : zoneOpacity,
                    showBorder && !empty));
            }
        }
    }

    destroy() {
        if (this._updateId) {
            GLib.source_remove(this._updateId);
            this._updateId = 0;
        }
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
