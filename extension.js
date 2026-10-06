import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// ---- Edit these -----------------------------------------------------------
const CONFIG = {
    // Wallpaper shown only during the intro. Missing file => plain black.
    wallpaper: GLib.build_filenamev([GLib.get_home_dir(), 'Pictures', 'lock-intro.jpg']),
    // Set to a string to always show that text instead of a random phrase.
    // Handy for checking the fade; set back to null when you're done testing.
    testPhrase: 'TEST \u2014 this text fades in, holds, then fades out',
    // One phrase is picked at random on every lock.
    phrases: [
        'Take a breath.',
        'You did good work today.',
        'Stay curious.',
    ],
    bgFadeInMs: 700,
    textFadeInMs: 1200,
    holdMs: 2500,
    textFadeOutMs: 1200,
    bgFadeOutMs: 800,
    fontSize: '44px',
    // Distance from the bottom edge of the screen to the text.
    bottomMarginPx: 120,
};
// ---------------------------------------------------------------------------

export default class LockIntro extends Extension {
    enable() {
        this._overlay = null;
        this._timeouts = new Set();
        this._stageId = 0;

        this._activeId = Main.screenShield.connect('active-changed', () => {
            if (Main.screenShield.active)
                this._play();
            else
                this._cleanup();
        });
    }

    disable() {
        if (this._activeId) {
            Main.screenShield.disconnect(this._activeId);
            this._activeId = 0;
        }
        this._cleanup();
    }

    _later(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(id);
    }

    _play() {
        this._cleanup();

        const monitor = Main.layoutManager.primaryMonitor;
        const phrase = CONFIG.testPhrase ??
            CONFIG.phrases[Math.floor(Math.random() * CONFIG.phrases.length)];

        const overlay = new St.Widget({
            reactive: false, // never swallows input; lock behaviour is untouched
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            opacity: 0,
            layout_manager: new Clutter.BinLayout(),
            style: 'background-color: black;' +
                   `background-image: url("file://${CONFIG.wallpaper}");` +
                   'background-size: cover;',
        });

        const label = new St.Label({
            text: phrase,
            opacity: 0,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.END,
            style: `font-size: ${CONFIG.fontSize}; font-weight: 300; color: white;` +
                   'max-width: 900px; text-align: center;' +
                   `padding-bottom: ${CONFIG.bottomMarginPx}px;` +
                   'text-shadow: 0 2px 14px rgba(0,0,0,0.65);',
        });
        label.clutter_text.line_wrap = true;
        overlay.add_child(label);

        Main.layoutManager.screenShieldGroup.add_child(overlay);
        this._overlay = overlay;

        // Any key/click/touch skips the rest of the intro. The event still
        // propagates, so the lock screen reacts exactly as it normally would.
        this._stageId = global.stage.connect('captured-event', (_actor, event) => {
            const t = event.type();
            if (t === Clutter.EventType.KEY_PRESS ||
                t === Clutter.EventType.BUTTON_PRESS ||
                t === Clutter.EventType.TOUCH_BEGIN)
                this._skip(overlay);
            return Clutter.EVENT_PROPAGATE;
        });

        const alive = () => this._overlay === overlay;
        const mode = Clutter.AnimationMode.EASE_IN_OUT_QUAD;

        overlay.ease({
            opacity: 255, duration: CONFIG.bgFadeInMs, mode,
            onComplete: () => {
                if (!alive()) return;
                label.ease({
                    opacity: 255, duration: CONFIG.textFadeInMs, mode,
                    onComplete: () => {
                        if (!alive()) return;
                        this._later(CONFIG.holdMs, () => {
                            if (!alive()) return;
                            label.ease({
                                opacity: 0, duration: CONFIG.textFadeOutMs, mode,
                                onComplete: () => {
                                    if (!alive()) return;
                                    this._fadeOutOverlay(overlay);
                                },
                            });
                        });
                    },
                });
            },
        });
    }

    _fadeOutOverlay(overlay) {
        overlay.ease({
            opacity: 0, duration: CONFIG.bgFadeOutMs,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            onComplete: () => {
                if (this._overlay === overlay)
                    this._cleanup();
            },
        });
    }

    _skip(overlay) {
        if (this._overlay !== overlay)
            return;
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();
        overlay.remove_all_transitions();
        for (const child of overlay.get_children())
            child.remove_all_transitions();
        overlay.ease({
            opacity: 0, duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._overlay === overlay)
                    this._cleanup();
            },
        });
    }

    _cleanup() {
        for (const id of this._timeouts)
            GLib.source_remove(id);
        this._timeouts.clear();

        if (this._stageId) {
            global.stage.disconnect(this._stageId);
            this._stageId = 0;
        }
        if (this._overlay) {
            this._overlay.remove_all_transitions();
            this._overlay.destroy();
            this._overlay = null;
        }
    }
}
