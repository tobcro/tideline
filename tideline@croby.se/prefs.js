import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TidelinePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        window.add(page);

        const layout = new Adw.PreferencesGroup({title: _('Layout')});
        page.add(layout);
        layout.add(this._spinRow(settings, 'panel-height', _('Taskbar height'), 24, 96));
        layout.add(this._spinRow(settings, 'icon-size', _('App icons size'), 16, 64));
        layout.add(this._comboRow(settings, 'clock-position', _('Clock position'),
            [['center', _('Center')], ['right', _('Right')]]));

        const background = new Adw.PreferencesGroup({title: _('Background')});
        page.add(background);
        background.add(this._colorRow(settings, 'background-color', _('Color')));
        const dynamicRow = this._switchRow(settings, 'dynamic-opacity',
            _('Translucent unless a window is maximized'));
        background.add(dynamicRow);
        const opacityRow = this._spinRow(settings, 'background-opacity',
            _('Translucent opacity (%)'), 0, 100);
        settings.bind('dynamic-opacity', opacityRow, 'sensitive', Gio.SettingsBindFlags.GET);
        background.add(opacityRow);
        background.add(this._switchRow(settings, 'overview-transparent',
            _('Fully translucent in Overview')));

        const content = new Adw.PreferencesGroup({title: _('Content')});
        page.add(content);
        content.add(this._switchRow(settings, 'show-activities', _('Show Activities button')));
        content.add(this._switchRow(settings, 'show-apps-button', _('Show App grid button')));
        content.add(this._switchRow(settings, 'show-favorites', _('Show pinned apps')));
        content.add(this._switchRow(settings, 'window-previews',
            _('Show window previews on hover')));
        content.add(this._switchRow(settings, 'isolate-workspaces',
            _('Only show windows on the current workspace')));
        content.add(this._switchRow(settings, 'hide-overview-dash',
            _('Hide the GNOME dash in the overview')));

        const monitors = new Adw.PreferencesGroup({title: _('Multiple monitors')});
        page.add(monitors);
        monitors.add(this._switchRow(settings, 'multi-monitor',
            _('Show a taskbar on every monitor')));
        const isolateRow = this._switchRow(settings, 'isolate-monitors',
            _("Only show windows on the taskbar's own monitor"));
        settings.bind('multi-monitor', isolateRow, 'sensitive', Gio.SettingsBindFlags.GET);
        monitors.add(isolateRow);
    }

    _switchRow(settings, key, title) {
        const row = new Adw.SwitchRow({title});
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _spinRow(settings, key, title, lower, upper) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({lower, upper, step_increment: 2}),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _colorRow(settings, key, title) {
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        const row = new Adw.ActionRow({title, activatable_widget: button});
        row.add_suffix(button);

        const sync = () => {
            const rgba = new Gdk.RGBA();
            if (!rgba.parse(settings.get_string(key)))
                rgba.parse('#000000');
            if (!rgba.equal(button.rgba))
                button.rgba = rgba;
        };
        sync();
        settings.connect(`changed::${key}`, sync);

        button.connect('notify::rgba', () => {
            const hex = '#' + [button.rgba.red, button.rgba.green, button.rgba.blue]
                .map(c => Math.round(c * 255).toString(16).padStart(2, '0'))
                .join('');
            if (settings.get_string(key) !== hex)
                settings.set_string(key, hex);
        });
        return row;
    }

    _comboRow(settings, key, title, choices) {
        const row = new Adw.ComboRow({
            title,
            model: Gtk.StringList.new(choices.map(([, label]) => label)),
        });
        const sync = () => {
            row.selected = Math.max(0,
                choices.findIndex(([id]) => id === settings.get_string(key)));
        };
        sync();
        settings.connect(`changed::${key}`, sync);
        row.connect('notify::selected', () => {
            const id = choices[row.selected][0];
            if (settings.get_string(key) !== id)
                settings.set_string(key, id);
        });
        return row;
    }
}
