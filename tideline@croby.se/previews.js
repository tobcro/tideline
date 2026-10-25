import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const OPEN_DELAY = 400;
const CLOSE_DELAY = 300;
const ANIMATION_TIME = 150;
const THUMBNAIL_WIDTH = 220;
const THUMBNAIL_HEIGHT = 140;
const POPUP_GAP = 8;

/**
 * One window in the preview popup: title, close button and a live
 * thumbnail. Clicking it activates the window.
 */
const WindowPreviewItem = GObject.registerClass(
class WindowPreviewItem extends St.Button {
    _init(window, onActivated) {
        super._init({
            style_class: 'tideline-preview',
            reactive: true,
            can_focus: true,
            track_hover: true,
        });

        this._window = window;

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        this.set_child(box);

        const header = new St.BoxLayout({style_class: 'tideline-preview-header'});
        box.add_child(header);

        this._title = new St.Label({
            style_class: 'tideline-preview-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add_child(this._title);

        const closeButton = new St.Button({
            style_class: 'tideline-preview-close',
            child: new St.Icon({icon_name: 'window-close-symbolic'}),
            y_align: Clutter.ActorAlign.CENTER,
        });
        closeButton.connect('clicked', () =>
            this._window.delete(global.get_current_time()));
        header.add_child(closeButton);

        box.add_child(this._createThumbnail());

        // Fix the width so a long title does not stretch the item.
        this._title.width = Math.max(this._thumbnailWidth - 28, 40);

        window.connectObject('notify::title', () => this._syncTitle(), this);
        this._syncTitle();

        this.connect('clicked', () => {
            Main.activateWindow(this._window);
            onActivated();
        });
        this.connect('destroy', () => this._window.disconnectObject(this));
    }

    _syncTitle() {
        this._title.text = this._window.get_title() ?? '';
    }

    _createThumbnail() {
        const frame = this._window.get_frame_rect();
        const scale = Math.min(
            THUMBNAIL_WIDTH / Math.max(frame.width, 1),
            THUMBNAIL_HEIGHT / Math.max(frame.height, 1),
            1);
        this._thumbnailWidth = Math.round(frame.width * scale);

        const bin = new Clutter.Actor({
            width: this._thumbnailWidth,
            height: Math.round(frame.height * scale),
            clip_to_allocation: true,
        });

        const actor = this._window.get_compositor_private();
        if (!actor)
            return bin;

        // The window actor covers the whole buffer, including client-side
        // shadows; offset it so only the visible frame shows. Clones also
        // paint minimized (unmapped) windows.
        const buffer = this._window.get_buffer_rect();
        bin.add_child(new Clutter.Clone({
            source: actor,
            x: Math.round((buffer.x - frame.x) * scale),
            y: Math.round((buffer.y - frame.y) * scale),
            width: Math.round(buffer.width * scale),
            height: Math.round(buffer.height * scale),
        }));

        if (this._window.minimized)
            bin.opacity = 160;
        return bin;
    }
});

const WindowPreviewPopup = GObject.registerClass(
class WindowPreviewPopup extends St.BoxLayout {
    _init(manager) {
        super._init({
            style_class: 'tideline-previews',
            reactive: true,
            track_hover: true,
            opacity: 0,
        });
        this._manager = manager;
        this.connect('notify::hover', () => manager.popupHoverChanged(this.hover));
    }

    setWindows(button, windows) {
        this.destroy_all_children();
        for (const window of windows)
            this.add_child(new WindowPreviewItem(window, () => this._manager.close()));
        this._position(button);
    }

    _position(button) {
        const [, width] = this.get_preferred_width(-1);
        const [, height] = this.get_preferred_height(width);
        const [buttonX, buttonY] = button.get_transformed_position();
        const [buttonWidth] = button.get_transformed_size();
        const monitor = Main.layoutManager.findMonitorForActor(button);

        let x = Math.round(buttonX + (buttonWidth - width) / 2);
        if (monitor)
            x = Math.clamp(x, monitor.x, monitor.x + monitor.width - width);
        this.set_position(x, Math.round(buttonY - height - POPUP_GAP));
    }
});

/**
 * Opens and closes the preview popup as the pointer moves between taskbar
 * buttons and the popup. Only one popup exists at a time, shared by every
 * taskbar.
 */
class PreviewManager {
    constructor() {
        this._popup = null;
        this._button = null;
        this._openId = 0;
        this._closeId = 0;
    }

    isOpenFor(button) {
        return this._popup !== null && this._button === button;
    }

    buttonEntered(button) {
        this._cancelClose();
        if (this._button === button)
            return;

        this._cancelOpen();
        // Moving from one button to the next while a popup is up should
        // switch immediately, like a menu bar.
        const delay = this._popup ? 0 : OPEN_DELAY;
        this._openId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._openId = 0;
            this._open(button);
            return GLib.SOURCE_REMOVE;
        });
    }

    buttonLeft() {
        this._cancelOpen();
        this._scheduleClose();
    }

    popupHoverChanged(hover) {
        if (hover)
            this._cancelClose();
        else
            this._scheduleClose();
    }

    refresh(button) {
        if (this.isOpenFor(button))
            this._open(button);
    }

    _open(button) {
        const windows = button.getWindows();
        if (windows.length === 0 || !button.get_stage()) {
            this.close();
            return;
        }

        if (!this._popup) {
            this._popup = new WindowPreviewPopup(this);
            Main.layoutManager.addTopChrome(this._popup);
            this._popup.ease({
                opacity: 255,
                duration: ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        this._button = button;
        this._popup.setWindows(button, windows);
    }

    close() {
        this._cancelOpen();
        this._cancelClose();
        this._button = null;
        if (!this._popup)
            return;

        const popup = this._popup;
        this._popup = null;
        Main.layoutManager.removeChrome(popup);
        popup.destroy();
    }

    _scheduleClose() {
        if (this._closeId || !this._popup)
            return;
        this._closeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CLOSE_DELAY, () => {
            this._closeId = 0;
            if (!this._popup?.hover && !this._button?.hover)
                this.close();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelOpen() {
        if (this._openId) {
            GLib.source_remove(this._openId);
            this._openId = 0;
        }
    }

    _cancelClose() {
        if (this._closeId) {
            GLib.source_remove(this._closeId);
            this._closeId = 0;
        }
    }
}

export const previews = new PreviewManager();
