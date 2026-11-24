import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

/**
 * The small "Tideline Settings" menu that opens on a right-click on empty
 * taskbar space or on the app grid button, like "Taskbar settings" does on
 * Windows. One menu is open at a time, built fresh each time it opens.
 */
class SettingsMenu {
    constructor() {
        this._openPreferences = null;
        this._menu = null;
        this._manager = null;
        this._destroyId = 0;
    }

    /**
     * @param {Function} openPreferences - opens the preferences window
     */
    init(openPreferences) {
        this._openPreferences = openPreferences;
    }

    /**
     * Open the menu above an actor, e.g. the app grid button.
     *
     * @param {Clutter.Actor} sourceActor - what the menu points at
     */
    openFor(sourceActor) {
        this._open(sourceActor, 0.5);
    }

    /**
     * Open the menu above a point, e.g. where empty space was clicked.
     *
     * @param {number} x - stage x
     * @param {number} y - stage y
     */
    openAt(x, y) {
        Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
        this._open(Main.layoutManager.dummyCursor, 0);
    }

    /**
     * Make right-clicks on the actor's own empty space open the menu.
     * Clicks on children such as app buttons or panel menus are left alone,
     * since the gesture only sees events that target the actor itself.
     *
     * @param {Clutter.Actor} actor - a bar
     */
    addTo(actor) {
        const gesture = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_SECONDARY,
            recognize_on_press: true,
        });
        gesture.connect('recognize', () => {
            const {x, y} = gesture.get_coords_abs();
            this.openAt(x, y);
        });
        actor.add_action_full('tideline-settings-menu',
            Clutter.EventPhase.TARGET, gesture);
    }

    removeFrom(actor) {
        actor.remove_action_by_name('tideline-settings-menu');
    }

    _open(sourceActor, alignment) {
        this.close();

        this._menu = new PopupMenu.PopupMenu(sourceActor, alignment, St.Side.BOTTOM);
        this._menu.addAction(_('Tideline Settings'), () => this._openPreferences?.(),
            'emblem-system-symbolic');
        Main.uiGroup.add_child(this._menu.actor);
        this._menu.actor.hide();

        this._manager = new PopupMenu.PopupMenuManager(sourceActor);
        this._manager.addMenu(this._menu);

        const menu = this._menu;
        menu.connect('open-state-changed', (_menu, open) => {
            if (open || menu !== this._menu)
                return;
            // Let the closing animation finish before tearing it down.
            this._destroyId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._destroyId = 0;
                if (menu === this._menu)
                    this.close();
                return GLib.SOURCE_REMOVE;
            });
        });
        this._menu.open(true);
    }

    close() {
        if (this._destroyId) {
            GLib.source_remove(this._destroyId);
            this._destroyId = 0;
        }
        const menu = this._menu;
        this._menu = null;
        if (menu) {
            this._manager.removeMenu(menu);
            menu.destroy();
        }
        this._manager = null;
    }

    destroy() {
        this.close();
        this._openPreferences = null;
    }
}

export const settingsMenu = new SettingsMenu();
