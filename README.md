 # Skyrim styled loading screen for Ubuntu


On lock/suspend an image appears with an rss feed based loading screen tip.
currently using: https://www.howtogeek.com/feed

 [Example](lockscreen.png)

## Images

Drop any number of images in `~/Pictures/lock-intro/`. They are shown in a
shuffled rotation: every image appears once before any repeats.

To use a different folder, set `LOCK_INTRO_WALLPAPER`. It accepts a directory
or a single image file. gnome-shell does not inherit your terminal's
environment, so set it where the session will export it:

```bash
mkdir -p ~/.config/environment.d
echo 'LOCK_INTRO_WALLPAPER=/path/to/your/images' > ~/.config/environment.d/lock-intro.conf
```

Log out and back in for that to take effect (a shell restart is not enough --
the variable is read from the session environment at login).

Resolution order: `$LOCK_INTRO_WALLPAPER`, then `~/Pictures/lock-intro/`, then
`~/Pictures/lock-intro.jpg`, then a plain black background.

## Applying changes

Editing `extension.js` needs a full shell restart (Alt+F2, `r` on X11).
Toggling the extension off and on does *not* reload it -- GNOME caches the
module -- and `ReloadExtension` over D-Bus was removed in GNOME 46.
