import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';
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
    testPhrase: null,
    // One phrase is picked at random on every lock.
    phrases: [
        'Take a breath.',
        'You did good work today.',
        'Stay curious.',
    ],
    // Tech tips are pulled from this RSS feed and cached on disk, so the lock
    // screen never waits on the network. `phrases` is the fallback when the
    // cache is empty. Set feedUrl to null to use `phrases` only.
    feedUrl: 'https://www.howtogeek.com/feed/',
    feedRefreshHours: 6,
    // The feed carries deal/discount posts alongside the tips; skip those.
    feedSkip: /\$\d|\d+%\s*off|\bdeals?\b|\bdiscount|\bcoupon|\bsale\b/i,
    maxPhraseChars: 130,
    bgFadeInMs: 700,
    textFadeInMs: 1200,
    holdMs: 2500,
    textFadeOutMs: 1200,
    bgFadeOutMs: 800,
    fontSize: '44px',
    // Feed headlines are far longer than the built-in phrases.
    fontSizeLong: '30px',
    longPhraseChars: 55,
    // Distance from the bottom edge of the screen to the text.
    bottomMarginPx: 120,
    // How long you must be away before coming back replays the intro.
    // Stops it replaying while you sit at the lock screen typing.
    wakeIdleGateMs: 30000,
};
// ---------------------------------------------------------------------------

export default class LockIntro extends Extension {
    enable() {
        this._overlay = null;
        this._timeouts = new Set();
        this._stageId = 0;
        this._userActiveId = 0;
        this._idleGateId = 0;
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._tips = [];
        this._session = null;
        this._cancellable = null;
        this._refreshFirstId = 0;
        this._refreshId = 0;

        this._loadCache();
        this._scheduleRefresh();

        // Fires at the instant of locking. If you locked by hand you are
        // watching; if the screen locked from idle or suspend you are not,
        // which is what the wake triggers below are for.
        this._activeId = Main.screenShield.connect('active-changed', () => {
            if (Main.screenShield.active) {
                this._play();
                this._armWakeDetection();
            } else {
                this._disarmWakeDetection();
                this._cleanup();
            }
        });

        // Emitted on resume from suspend, and when a notification wakes the
        // screen. It is also emitted while the shield is being dismissed on
        // unlock, where `active` is still true and only goes false later in
        // the same function -- so decide on the next main loop iteration.
        this._wakeId = Main.screenShield.connect('wake-up-screen', () => {
            this._later(0, () => this._maybePlay());
        });

        if (Main.screenShield.active)
            this._armWakeDetection();
    }

    disable() {
        if (this._activeId) {
            Main.screenShield.disconnect(this._activeId);
            this._activeId = 0;
        }
        if (this._wakeId) {
            Main.screenShield.disconnect(this._wakeId);
            this._wakeId = 0;
        }
        this._disarmWakeDetection();
        this._idleMonitor = null;

        for (const id of [this._refreshFirstId, this._refreshId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._refreshFirstId = 0;
        this._refreshId = 0;
        this._cancellable?.cancel();
        this._cancellable = null;
        this._session = null; // in-flight callbacks bail out on this
        this._tips = [];

        this._cleanup();
    }

    // Waking from idle blanking emits no screenShield signal, so watch the
    // idle monitor the way the shell itself does.
    _armWakeDetection() {
        if (this._idleMonitor.get_idletime() >= CONFIG.wakeIdleGateMs)
            this._armUserActive();
        else
            this._armIdleGate();
    }

    _armUserActive() {
        if (this._userActiveId)
            return;
        // One-shot: fires on the first input after the user went away.
        this._userActiveId = this._idleMonitor.add_user_active_watch(() => {
            this._userActiveId = 0;
            this._maybePlay();
            this._armIdleGate();
        });
    }

    _armIdleGate() {
        if (this._idleGateId)
            return;
        this._idleGateId = this._idleMonitor.add_idle_watch(
            CONFIG.wakeIdleGateMs, () => {
                this._disarmIdleGate();
                this._armUserActive();
            });
    }

    _disarmIdleGate() {
        if (this._idleGateId) {
            this._idleMonitor.remove_watch(this._idleGateId);
            this._idleGateId = 0;
        }
    }

    _disarmWakeDetection() {
        this._disarmIdleGate();
        if (this._userActiveId) {
            this._idleMonitor.remove_watch(this._userActiveId);
            this._userActiveId = 0;
        }
    }

    // ---- tip feed --------------------------------------------------------

    _pickPhrase() {
        const pool = this._tips?.length ? this._tips : CONFIG.phrases;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    _cachePath() {
        return GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'lock-intro-tips.json']);
    }

    _loadCache() {
        try {
            const [ok, data] = GLib.file_get_contents(this._cachePath());
            if (!ok)
                return;
            const tips = JSON.parse(new TextDecoder().decode(data));
            if (Array.isArray(tips))
                this._tips = tips.filter(t => typeof t === 'string' && t);
        } catch (e) {
            // No cache yet, or it is unreadable: CONFIG.phrases is the fallback.
        }
    }

    _saveCache() {
        try {
            GLib.file_set_contents(
                this._cachePath(), JSON.stringify(this._tips));
        } catch (e) {
            console.warn(`lock-intro: could not cache tips: ${e.message}`);
        }
    }

    _scheduleRefresh() {
        if (!CONFIG.feedUrl)
            return;
        // Shortly after login, so it never delays the session starting up.
        this._refreshFirstId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW, 15, () => {
                this._refreshFirstId = 0;
                this._refreshTips();
                return GLib.SOURCE_REMOVE;
            });
        this._refreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW,
            Math.max(1, CONFIG.feedRefreshHours) * 3600, () => {
                this._refreshTips();
                return GLib.SOURCE_CONTINUE;
            });
    }

    // RSS titles arrive CDATA-wrapped and may carry entity references.
    _cleanTitle(raw) {
        const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
        return raw
            .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
            .replace(/<[^>]*>/g, '')
            .replace(/&#x([0-9a-f]+);/gi,
                (_, h) => String.fromCodePoint(parseInt(h, 16)))
            .replace(/&#(\d+);/g,
                (_, d) => String.fromCodePoint(parseInt(d, 10)))
            .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => named[n])
            .replace(/\s+/g, ' ')
            .trim();
    }

    _refreshTips() {
        if (!CONFIG.feedUrl || this._cancellable)
            return; // already fetching

        this._session ??= new Soup.Session({
            timeout: 20,
            user_agent: 'gnome-shell-lock-intro/1',
        });
        const session = this._session;
        const msg = Soup.Message.new('GET', CONFIG.feedUrl);
        this._cancellable = new Gio.Cancellable();

        session.send_and_read_async(
            msg, GLib.PRIORITY_LOW, this._cancellable, (_s, res) => {
                if (this._session !== session)
                    return; // disabled while the request was in flight
                this._cancellable = null;

                let bytes;
                try {
                    bytes = session.send_and_read_finish(res);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`lock-intro: feed fetch failed: ${e.message}`);
                    return; // keep whatever is cached
                }
                if (msg.get_status() !== Soup.Status.OK) {
                    console.warn(`lock-intro: feed returned ${msg.get_status()}`);
                    return;
                }

                const xml = new TextDecoder().decode(bytes.get_data());
                const tips = [...xml.matchAll(
                    /<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)]
                    .map(m => this._cleanTitle(m[1]))
                    .filter(t => t &&
                        t.length <= CONFIG.maxPhraseChars &&
                        !CONFIG.feedSkip.test(t));

                if (!tips.length) {
                    console.warn('lock-intro: feed had no usable tips');
                    return;
                }
                this._tips = tips;
                this._saveCache();
            });
    }

    _maybePlay() {
        if (this._overlay)
            return; // already showing; don't restart it
        if (!Main.screenShield.active || !Main.screenShield.locked)
            return; // unlocking, or blanked without locking
        this._play();
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
        const phrase = CONFIG.testPhrase ?? this._pickPhrase();

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
            style: `font-size: ${phrase.length > CONFIG.longPhraseChars
                ? CONFIG.fontSizeLong : CONFIG.fontSize};` +
                   'font-weight: 300; color: white;' +
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
