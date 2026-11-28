import AccountsService from 'gi://AccountsService';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import Gettext from 'gettext';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {Avatar} from 'resource:///org/gnome/shell/ui/userWidget.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// The power items reuse GNOME's own strings, so they come out translated
// exactly like the ones in Quick Settings.
const shell = Gettext.domain('gnome-shell').gettext;

const USERS_PANEL = 'gnome-users-panel.desktop';

/**
 * Round button with the user's picture at the start of the bar. Its menu
 * links to the user's settings and repeats the Power Off menu from Quick
 * Settings, like the account and power buttons in the Windows Start menu.
 */
export const UserMenuButton = GObject.registerClass(
class UserMenuButton extends PanelMenu.Button {
    _init(settings) {
        super._init(0.0, _('User Menu'));
        this.add_style_class_name('tideline-user-button');

        this._user = AccountsService.UserManager.get_default()
            .get_user(GLib.get_user_name());
        this._avatar = new Avatar(this._user, {
            // Not GNOME's 'user-icon' style: it sets a large icon-size of
            // its own, which Avatar would pick up instead of ours.
            styleClass: 'tideline-avatar',
            iconSize: Math.round(settings.get_int('icon-size') * 0.8),
        });
        this._avatar.y_align = Clutter.ActorAlign.CENTER;
        this.add_child(this._avatar);

        this._user.connectObject(
            'notify::is-loaded', () => this._sync(),
            'changed', () => this._sync(),
            this);
        this._sync();

        // Menus point at the middle of their button by default; anchor this
        // one at the button's left edge so it lines up with the screen edge.
        this.menu.setSourceAlignment(0);

        this._systemActions = SystemActions.getDefault();
        this._buildMenu();

        // Like Quick Settings: Polkit doesn't say when an action becomes
        // allowed, so ask again whenever the menu opens.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._systemActions.forceUpdate();
        });
    }

    _sync() {
        this._avatar.update();
        if (this._user.is_loaded)
            this.accessible_name = this._user.get_real_name() || this._user.get_user_name();
    }

    _buildMenu() {
        this.menu.addAction(_('Edit Profile'), () => this._editProfile());
        const powerSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(powerSeparator);

        const power = [
            this._addAction(shell('Suspend'), 'can-suspend',
                () => this._systemActions.activateSuspend()),
            this._addAction(shell('Restart…'), 'can-restart',
                () => this._systemActions.activateRestart()),
            this._addAction(shell('Power Off…'), 'can-power-off',
                () => this._systemActions.activatePowerOff()),
        ];

        const logoutSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(logoutSeparator);
        const logout = this._addAction(shell('Log Out…'), 'can-logout',
            () => this._systemActions.activateLogout());

        // Lockdown settings or Polkit can rule items out; drop separators
        // that would end up with nothing below them.
        const syncSeparators = () => {
            const anyPower = power.some(item => item.visible);
            powerSeparator.visible = anyPower || logout.visible;
            logoutSeparator.visible = anyPower && logout.visible;
        };
        for (const item of [...power, logout])
            item.connect('notify::visible', syncSeparators);
        syncSeparators();
    }

    _addAction(label, property, callback) {
        const item = this.menu.addAction(label, callback);
        this._systemActions.bind_property(property, item, 'visible',
            GObject.BindingFlags.SYNC_CREATE);
        return item;
    }

    _editProfile() {
        Main.overview.hide();
        const app = Shell.AppSystem.get_default().lookup_app(USERS_PANEL);
        if (app)
            app.activate();
        else
            Util.spawn(['gnome-control-center', 'system', 'users']);
    }

    _onDestroy() {
        this._user.disconnectObject(this);
        super._onDestroy();
    }
});
