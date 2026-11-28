import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const DEVELOPER = 'Tobias';
const LICENSE_URL = 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html';

// The version pill on the About page, styled like the one in Adw.AboutDialog.
const CSS = `
.tideline-version {
  padding: 3px 18px;
  border-radius: 999px;
  color: var(--accent-color);
  background-color: color-mix(in srgb, var(--accent-bg-color) 10%, transparent);
}
`;

export default class TidelinePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.search_enabled = true;
        window.set_default_size(640, 720);

        window.add(this._appearancePage(settings));
        window.add(this._taskbarPage(settings));
        window.add(this._aboutPage(window));

        // The preferences process outlives the window, so take the style
        // sheet away again when it closes.
        const provider = new Gtk.CssProvider();
        provider.load_from_string(CSS);
        const display = Gdk.Display.get_default();
        Gtk.StyleContext.add_provider_for_display(display, provider,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        window.connect('close-request', () => {
            Gtk.StyleContext.remove_provider_for_display(display, provider);
            return false;
        });
    }

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });

        const size = new Adw.PreferencesGroup({title: _('Size')});
        page.add(size);
        size.add(this._spinRow(settings, 'panel-height', _('Taskbar height'), 24, 96));
        size.add(this._spinRow(settings, 'icon-size', _('App icon size'), 16, 64));

        const background = new Adw.PreferencesGroup({title: _('Background')});
        page.add(background);
        background.add(this._colorRow(settings, 'background-color', _('Color')));
        const translucent = this._expanderRow(settings, 'dynamic-opacity',
            _('Translucent'), _('Turns solid when a window is maximized'));
        translucent.add_row(this._spinRow(settings, 'background-opacity',
            _('Opacity (%)'), 0, 100));
        background.add(translucent);
        background.add(this._switchRow(settings, 'overview-transparent',
            _('Fully transparent in the Overview')));

        const style = new Adw.PreferencesGroup({title: _('Style')});
        page.add(style);
        const zones = this._expanderRow(settings, 'zones', _('Zones'),
            _('Rounded, floating zones for the left side, the apps and the clock'));
        for (const [key, title, upper] of [
            ['zone-radius', _('Roundness (px)'), 30],
            ['zone-float', _('Float height (px)'), 16],
            ['zone-gap', _('Gap to screen edges (px)'), 64],
            ['zone-padding', _('Padding (px)'), 32],
        ])
            zones.add_row(this._spinRow(settings, key, title, 0, upper, 1));
        style.add(zones);
        const border = this._expanderRow(settings, 'border', _('Border'),
            _('A 1px outline around the taskbar, or around each zone'));
        border.add_row(this._colorRow(settings, 'border-color', _('Color')));
        border.add_row(this._spinRow(settings, 'border-opacity', _('Opacity (%)'), 0, 100));
        style.add(border);

        return page;
    }

    _taskbarPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Taskbar'),
            icon_name: 'view-app-grid-symbolic',
        });

        const buttons = new Adw.PreferencesGroup({title: _('Buttons')});
        page.add(buttons);
        buttons.add(this._switchRow(settings, 'show-user-button', _('User button'),
            _('Your picture, with a menu to edit your profile, power off or log out')));
        buttons.add(this._switchRow(settings, 'show-activities', _('Activities button')));
        buttons.add(this._switchRow(settings, 'show-apps-button', _('App grid button')));

        const apps = new Adw.PreferencesGroup({title: _('Apps')});
        page.add(apps);
        apps.add(this._switchRow(settings, 'show-favorites', _('Pinned apps')));
        apps.add(this._switchRow(settings, 'window-previews', _('Window previews on hover')));
        apps.add(this._switchRow(settings, 'isolate-workspaces',
            _('Only windows on the current workspace')));
        apps.add(this._colorRow(settings, 'dot-color', _('Window dot color'),
            _('Dots of apps without focus are shown at 50%')));

        const monitors = new Adw.PreferencesGroup({title: _('Multiple Monitors')});
        page.add(monitors);
        const multi = this._expanderRow(settings, 'multi-monitor',
            _('Taskbar on every monitor'), _('Extra monitors show just the apps'));
        multi.add_row(this._switchRow(settings, 'isolate-monitors',
            _("Only windows on the taskbar's own monitor")));
        monitors.add(multi);

        const overview = new Adw.PreferencesGroup({title: _('Overview')});
        page.add(overview);
        overview.add(this._switchRow(settings, 'hide-overview-dash',
            _('Hide the GNOME dash'), _('The taskbar already does its job')));

        return page;
    }

    _aboutPage(window) {
        const page = new Adw.PreferencesPage({
            title: _('About'),
            icon_name: 'help-about-symbolic',
        });

        // The header of Adw.AboutDialog: icon, name, developer and version.
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            halign: Gtk.Align.CENTER,
            spacing: 6,
            margin_top: 24,
        });
        const icon = Gtk.Image.new_from_file(
            this.dir.get_child('icons').get_child('tideline.svg').get_path());
        icon.pixel_size = 128;
        icon.margin_bottom = 18;
        header.append(icon);
        header.append(new Gtk.Label({
            label: this.metadata.name,
            css_classes: ['title-1'],
            wrap: true,
            justify: Gtk.Justification.CENTER,
        }));
        header.append(new Gtk.Label({
            label: DEVELOPER,
            css_classes: ['dim-label'],
        }));
        const version = this.metadata['version-name'] ?? String(this.metadata.version ?? '');
        header.append(new Gtk.Label({
            label: version,
            css_classes: ['tideline-version'],
            halign: Gtk.Align.CENTER,
            margin_top: 6,
        }));
        header.append(new Gtk.Label({
            label: _('A taskbar. At the bottom. Like nature (and Redmond) intended.'),
            wrap: true,
            justify: Gtk.Justification.CENTER,
            margin_top: 18,
        }));
        const headerGroup = new Adw.PreferencesGroup();
        headerGroup.add(header);
        page.add(headerGroup);

        const links = new Adw.PreferencesGroup();
        page.add(links);
        const url = this.metadata.url;
        links.add(this._linkRow(window, _('Website'), url));
        links.add(this._linkRow(window, _('Report an Issue'), `${url}/issues`));

        const legal = new Adw.PreferencesGroup();
        page.add(legal);
        legal.add(this._linkRow(window, _('License'), LICENSE_URL,
            _('GNU General Public License, version 2 or later')));

        return page;
    }

    _linkRow(window, title, uri, subtitle = null) {
        const row = new Adw.ActionRow({title, activatable: true});
        if (subtitle)
            row.subtitle = subtitle;
        row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        row.connect('activated', () =>
            new Gtk.UriLauncher({uri}).launch(window, null, null));
        return row;
    }

    _switchRow(settings, key, title, subtitle = null) {
        const row = new Adw.SwitchRow({title});
        if (subtitle)
            row.subtitle = subtitle;
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    // A row with its own on/off switch whose extra settings fold out below it.
    _expanderRow(settings, key, title, subtitle) {
        const row = new Adw.ExpanderRow({title, subtitle, show_enable_switch: true});
        settings.bind(key, row, 'enable-expansion', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _spinRow(settings, key, title, lower, upper, step = 2) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({lower, upper, step_increment: step}),
        });
        settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _colorRow(settings, key, title, subtitle = null) {
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        const row = new Adw.ActionRow({title, activatable_widget: button});
        if (subtitle)
            row.subtitle = subtitle;
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
}
