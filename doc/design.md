# Design

Why the pieces are arranged the way they are. For installing and using it, see
the [README](../README.md).

## The split

```
extension.js ──spawns──> update-tips ──> myrssfeed ──> ~/.cache/lock-intro/tips.json
     │                                                          │
     └───────────────── reads + watches ────────────────────────┘
```

| | |
| --- | --- |
| `tips.toml` | feeds, and the prompt describing what counts as a tip |
| `update-tips` | runs myrssfeed, writes the result |
| `extension.js` | draws the overlay; spawns the updater on a timer, reads its output |

All four files install into the same directory, so the extension resolves the
updater and its config relative to `this.path` and nothing needs configuring.

The extension does no networking. An earlier version fetched the feed itself
with libsoup and parsed it with a regex, inside the compositor process. Moving
it out means a slow feed, an expired API key or a failed run cannot delay or
break a lock — the worst case is yesterday's tips.

It also makes the tip side testable on its own. `./update-tips --dry-run`
exercises the whole path without an API call, a lock screen, or a shell
restart.

`myrssfeed` is Python and wants an Anthropic API key, so it could not have
lived in the extension regardless: gnome-shell runs GJS, and the key has no
business in the compositor.

## The pool

`~/.cache/lock-intro/tips.json` is `{updated, tips: [{title, link}]}`.

It is a **snapshot, not an archive**: each run replaces it. myrssfeed runs with
`--no-state`, so every run returns every current item rather than only what is
new since last time.

An earlier version did the opposite — a state file, and a merge into a capped
rolling pool. That kept tips alive after they left the feed, which sounds like
resilience and is actually staleness: a feed that stops carrying tips would go
on showing last month's. It also dragged in the machinery that made the install
nine steps. A snapshot means an empty result shows no text, which is the honest
answer.

The file is written to a temp file and renamed into place, so the extension
never reads a half-written file. The extension watches it with a `GFileMonitor`
and reloads on change, which is why a hand-run `./update-tips` needs no shell
restart.

## Judged vs keyword filtering

Whether the feed is all tips depends on the feed. For a general tech feed it is
not, and a keyword list was the first attempt:

```
\$\d|\d+%\s*off|\bdeals?\b|\bdiscount|\bcoupon|\bsale\b
```

It catches `Get 46% off DeWalt's 192-Piece Mechanics Tool Set` and `This UGREEN
NAS is under $350 for Prime Big Deal Days`. It does not catch `Greenworks full
6-piece power tool set is now the price of one drill`, which is equally an ad
but names no price and says no "sale". Nothing reasonable in that family of
patterns would.

It is also too eager in the other direction: anything matching `deal` loses
`A better deal for your CPU scheduler`.

So the judging step exists, and the criteria live in prose in `tips.toml`
instead of in a regex.

A regex is still available in `--no-filter` mode, via `--skip` or
`LOCK_INTRO_SKIP`, because something is better than nothing when there is no
API key. It ships empty rather than carrying the pattern above as a default:
what is worth skipping is a property of the feed, the feeds are configured in
`tips.toml`, and a default tuned for one feed is dead weight on every other.
A feed that is already all tips — `til.hashrocket.com`, say — needs neither
filter.

The pattern cannot live in `tips.toml` itself: that file is myrssfeed's own
config and it rejects unknown keys. Settings that belong to this project rather
than to myrssfeed go in the environment, alongside `LOCK_INTRO_NO_FILTER`,
`LOCK_INTRO_WALLPAPER` and `LOCK_INTRO_TIPS`.

## Cost

Titles and truncated summaries only, never article bodies. Per run that is
roughly one request on Haiku with `effort = low` and reasons off, four runs a
day. Without a state file every run judges every current item, which is the
price of not accumulating; the feeds are small enough that this stays in cents
a month.

`tips.toml` holds `model`, `effort`, `batch_size` and `include_reasons` if the
balance should be different.

## When the intro plays

Three triggers, because the obvious one covers only a third of the cases.

**`screenShield::active-changed`** fires at the instant of locking. If you
pressed Super+L you are watching, and this is the whole story. If the screen
locked from idle blanking or on the way into suspend, the intro plays to a
switched-off display and is over before you return.

**`screenShield::wake-up-screen`** covers resume from suspend, where the
session was already locked before suspending so `active-changed` never fires
again. The shell also emits this signal while the shield is being *dismissed*
on unlock, at a point where `active` is still true and only goes false later in
the same function — so the handler defers one main-loop iteration before
deciding, or the intro flashes as you type your password.

**An idle-monitor watch** covers waking from idle blanking, which emits no
`screenShield` signal at all: `_onUserBecameActive` just calls `lightOff()` on
the lightboxes. The extension arms its own `add_user_active_watch`, the same
mechanism the shell uses internally.

That last one needs a gate. A bare user-active watch fires on your first
keystroke *at the lock screen*, which would replay the intro over the password
prompt. So it only arms after `wakeIdleGateMs` of idleness, and at lock time
`get_idletime()` decides whether to arm it directly (you were already away) or
wait for the gate (you just hit Super+L).

## Why edits need a shell restart

GNOME caches the imported ES module. Disabling and re-enabling the extension
re-runs `enable()` and `disable()` on the *old* class object, so code changes
do not appear. `ReloadExtension` over D-Bus was removed in GNOME 46 — it
answers `"ReloadExtension is deprecated and does not work"` — leaving a full
shell restart as the only way.

This applies to `extension.js` only. `tips.toml`, the images and the tip pool
are all read at use time.

## Rejected

**Changing the actual wallpaper and restoring it afterwards.** The overlay is a
`St.Widget` in `screenShieldGroup` with `reactive: false`, so there is no state
to restore if the shell dies mid-intro, and input reaches the lock screen
untouched. Lock timing, the password prompt and PAM are not involved anywhere.

**A systemd timer to drive the updater.** It kept the API key out of the
session environment, caught up after the machine was off, and logged failures
under its own unit. It also cost three extra files and four extra install
steps, for a program whose no-key mode has no secret to protect at all. The
extension spawns the updater on its own `GLib` timer instead, as the original
version did. The key now lives in `~/.config/environment.d/`, readable by the
user's own processes — stated in the README, with the no-key mode as the way
out.

**A built-in phrase pool to fall back on.** Earlier versions shipped three
canned phrases for when the tip pool was empty. An empty pool means there is
nothing to say, and a filler line pretending otherwise is worse than silence —
so the intro now runs image-only, and skips entirely when there is no image
either.

**Showing the feed item's `summary` instead of its title.** Summaries are
inconsistent across feeds — sometimes a sentence, sometimes the whole article.
Titles are uniformly short enough to read in the few seconds the overlay is up.
