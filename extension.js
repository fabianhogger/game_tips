import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// ---- Edit these -----------------------------------------------------------
const CONFIG = {
    // Where the intro image comes from. $LOCK_INTRO_WALLPAPER overrides this
    // and may name either a directory or a single image file.
    // NOTE: gnome-shell does not inherit your terminal's environment; set the
    // variable in ~/.config/environment.d/ so the session exports it (README).
    wallpaper: GLib.getenv('LOCK_INTRO_WALLPAPER') ??
        GLib.build_filenamev([GLib.get_home_dir(), 'Pictures', 'lock-intro']),
    // Used when the above does not exist, so a single-file setup keeps working.
    wallpaperFallback: GLib.build_filenamev([
        GLib.get_home_dir(), 'Pictures', 'lock-intro.jpg']),
    // Which files count as images when `wallpaper` is a directory. They are
    // shown in a shuffled rotation: every image appears before any repeats.
    imageExtensions: /\.(jpe?g|png|webp|bmp|tiff?|gif|avif)$/i,
    // Nothing usable in either location => plain black.
    // Set to a string to always show that text instead of a feed tip.
    // Handy for checking the fade; set back to null when you're done testing.
    testPhrase: null,
    // Tips come from the `update-tips` script next to this file, which runs
    // myrssfeed and writes the result here. The shell never fetches anything
    // itself, so no lock ever waits on a feed.
    // No file, or an empty one, means the image shows with no text at all.
    tipsPath: GLib.getenv('LOCK_INTRO_TIPS') ??
        GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'lock-intro', 'tips.json']),
    // A headline longer than this wraps into a wall of text; skip it.
    maxPhraseChars: 130,
    // How often to run update-tips, in hours. 0 never runs it, for when you
    // would rather drive it yourself from cron or by hand.
    refreshHours: 6,
    bgFadeInMs: 700,
    textFadeInMs: 1200,
    holdMs: 2500,
    textFadeOutMs: 1200,
    bgFadeOutMs: 800,
    fontSize: '44px',
    // Used instead of fontSize once a headline passes longPhraseChars.
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
        this._rotation = null;
        this._tipsMonitor = null;
        this._updater = null;
        this._refreshFirstId = 0;
        this._refreshId = 0;

        this._loadTips();
        this._watchTips();
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

        if (this._tipsMonitor) {
            this._tipsMonitor.cancel();
            this._tipsMonitor = null;
        }
        for (const id of [this._refreshFirstId, this._refreshId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._refreshFirstId = 0;
        this._refreshId = 0;
        if (this._updater) {
            this._updater.force_exit();
            this._updater = null;
        }
        this._tips = [];
        this._rotation = null;

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

    // ---- wallpaper rotation ----------------------------------------------

    // Returns a file:// URI for the next image, or null for a plain black
    // background. Resolved per lock, so dropping files in takes effect at once.
    _nextImageUri() {
        for (const path of [CONFIG.wallpaper, CONFIG.wallpaperFallback]) {
            if (!path)
                continue;
            let file = null;
            if (GLib.file_test(path, GLib.FileTest.IS_DIR))
                file = this._nextFromDir(path);
            else if (GLib.file_test(path, GLib.FileTest.EXISTS))
                file = path;
            if (file) {
                try {
                    // Escapes spaces and quotes that would break the CSS url().
                    return GLib.filename_to_uri(file, null);
                } catch (e) {
                    console.warn(`lock-intro: bad image path ${file}: ${e.message}`);
                }
            }
        }
        return null;
    }

    // Hands out each image once, in a random order, then reshuffles. Beats a
    // plain random pick, which happily shows the same image twice in a row.
    _nextFromDir(dir) {
        if (this._rotation?.dir !== dir || !this._rotation.queue.length) {
            const files = this._scanDir(dir);
            if (!files.length)
                return null;
            for (let i = files.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [files[i], files[j]] = [files[j], files[i]];
            }
            this._rotation = {dir, queue: files};
        }
        return this._rotation.queue.pop();
    }

    _scanDir(dir) {
        const files = [];
        try {
            const handle = GLib.Dir.open(dir, 0);
            let name;
            while ((name = handle.read_name()) !== null) {
                if (!CONFIG.imageExtensions.test(name))
                    continue;
                const path = GLib.build_filenamev([dir, name]);
                if (!GLib.file_test(path, GLib.FileTest.IS_DIR))
                    files.push(path);
            }
            handle.close();
        } catch (e) {
            console.warn(`lock-intro: cannot read ${dir}: ${e.message}`);
        }
        return files;
    }

    // ---- tips ------------------------------------------------------------
    //
    // The tips are written by the update-tips script next to this file, which
    // _runUpdater() spawns on a timer. Here they are only read, so a slow feed,
    // a missing API key or a failed run can never delay or break a lock.

    // null when the pool is empty: the intro then runs without text rather
    // than inventing something to say.
    _pickPhrase() {
        if (!this._tips?.length)
            return null;
        return this._tips[Math.floor(Math.random() * this._tips.length)];
    }

    _loadTips() {
        this._tips = [];
        let data;
        try {
            const [ok, bytes] = GLib.file_get_contents(CONFIG.tipsPath);
            if (!ok)
                return;
            data = JSON.parse(new TextDecoder().decode(bytes));
        } catch (e) {
            return; // not written yet: the intro runs without text
        }

        // Current format is {updated, tips: [{title, link}]}; a bare array of
        // strings was the previous one and still reads.
        const entries = Array.isArray(data) ? data : data?.tips;
        if (!Array.isArray(entries))
            return;

        this._tips = entries
            .map(e => (typeof e === 'string' ? e : e?.title))
            .filter(t => typeof t === 'string')
            .map(t => t.trim())
            .filter(t => t && t.length <= CONFIG.maxPhraseChars);
    }

    _scheduleRefresh() {
        if (!CONFIG.refreshHours)
            return;
        // A short delay first, so a login is never held up by a feed fetch.
        this._refreshFirstId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW, 20, () => {
                this._refreshFirstId = 0;
                this._runUpdater();
                return GLib.SOURCE_REMOVE;
            });
        this._refreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_LOW, CONFIG.refreshHours * 3600, () => {
                this._runUpdater();
                return GLib.SOURCE_CONTINUE;
            });
    }

    // Spawned, not done in process: the fetching and the judging live in a
    // Python script with its own dependencies, and neither belongs in the
    // compositor. Failures here only mean the tips stay as they were.
    _runUpdater() {
        if (this._updater)
            return; // the previous run has not finished

        const script = GLib.build_filenamev([this.path, 'update-tips']);
        if (!GLib.file_test(script, GLib.FileTest.IS_EXECUTABLE)) {
            console.warn(`lock-intro: ${script} is missing or not executable`);
            return;
        }

        try {
            this._updater = Gio.Subprocess.new(
                [script], Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            console.warn(`lock-intro: cannot run update-tips: ${e.message}`);
            return;
        }

        this._updater.communicate_utf8_async(null, null, (proc, res) => {
            this._updater = null;
            try {
                const [, , stderr] = proc.communicate_utf8_finish(res);
                if (!proc.get_successful()) {
                    console.warn(
                        `lock-intro: update-tips failed: ${(stderr ?? '').trim()}`);
                }
            } catch (e) {
                console.warn(`lock-intro: update-tips: ${e.message}`);
            }
        });
    }

    // Pick up a refreshed pool without waiting for the next shell restart.
    // update-tips writes through a temp file and renames, so what lands here
    // is always a complete file.
    _watchTips() {
        try {
            const file = Gio.File.new_for_path(CONFIG.tipsPath);
            this._tipsMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._tipsMonitor.connect('changed', (_monitor, _f, _other, type) => {
                if (type === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                    type === Gio.FileMonitorEvent.CREATED ||
                    type === Gio.FileMonitorEvent.MOVED_IN ||
                    type === Gio.FileMonitorEvent.DELETED)
                    this._loadTips();
            });
        } catch (e) {
            console.warn(`lock-intro: cannot watch ${CONFIG.tipsPath}: ${e.message}`);
        }
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
        const image = this._nextImageUri();

        if (!phrase && !image)
            return; // nothing to show; leave the normal lock screen alone

        const overlay = new St.Widget({
            reactive: false, // never swallows input; lock behaviour is untouched
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            opacity: 0,
            layout_manager: new Clutter.BinLayout(),
            style: 'background-color: black;' +
                   (image ? `background-image: url("${image}");` : '') +
                   'background-size: cover;',
        });

        const label = phrase ? new St.Label({
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
        }) : null;
        if (label) {
            label.clutter_text.line_wrap = true;
            overlay.add_child(label);
        }

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
                if (!label) {
                    // No text: hold the image, then fade it away.
                    this._later(CONFIG.holdMs, () => {
                        if (alive())
                            this._fadeOutOverlay(overlay);
                    });
                    return;
                }
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
