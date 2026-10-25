import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Taskbar} from './taskbar.js';

/**
 * Taskbar for a non-primary monitor: just the app icons, centered along the
 * bottom edge. The clock, system menus and Activities stay on the primary
 * monitor's panel.
 */
export const SecondaryBar = GObject.registerClass(
class SecondaryBar extends St.Widget {
    _init(settings, monitorIndex) {
        super._init({
            style_class: 'tideline-secondary',
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this.monitorIndex = monitorIndex;
        this._height = settings.get_int('panel-height');

        this._taskbar = new Taskbar(settings, {monitorIndex, showAppsButton: false});
        this._taskbar.x_align = Clutter.ActorAlign.CENTER;
        this._taskbar.x_expand = true;
        this.add_child(this._taskbar);

        // Chrome is untracked automatically when the actor is destroyed.
        Main.layoutManager.addChrome(this, {
            affectsStruts: true,
            trackFullscreen: true,
        });
        this._place();
    }

    _place() {
        const monitor = Main.layoutManager.monitors[this.monitorIndex];
        if (!monitor)
            return;

        this.set_position(monitor.x, monitor.y + monitor.height - this._height);
        this.set_size(monitor.width, this._height);
    }
});
