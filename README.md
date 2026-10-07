# Skyrim styled loading screen for Ubuntu

On lock/suspend an image appears with an rss feed based loading screen tip.
Currently using: https://til.hashrocket.com/rss

[Example](lockscreen.png)

You must have GNOME 46 or a later version. For the design, read
[doc/design.md](doc/design.md).

## Install

Steps 2 and 3 are optional. Without them the lock screen shows only an image.

### Step 1 — Copy the files

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/lock-intro@local
cp extension.js metadata.json tips.toml update-tips \
   ~/.local/share/gnome-shell/extensions/lock-intro@local/
```

### Step 2 — Install the tip program (optional)

The program `myrssfeed` reads the feeds.

```bash
pipx install myrssfeed
```

### Step 3 — Set the variables (optional)

Put all the settings in one file. Use the path of your images. Do not move your
images.

```bash
mkdir -p ~/.config/environment.d
cat > ~/.config/environment.d/lock-intro.conf <<'EOF'
LOCK_INTRO_WALLPAPER=/path/to/your/images
EOF
```

For the tips, add one more line to that file. Select line A or line B.

**Line A — with an Anthropic API key.** Claude reads each item from the feed.
Claude keeps only the items that agree with the prompt in `tips.toml`. Each run
has a small cost.

```
ANTHROPIC_API_KEY=sk-ant-...
```

**Line B — with no key.** The program keeps all the items from the feed. The
program sends no data to the API.

```
LOCK_INTRO_NO_FILTER=1
```

Caution: all your programs can read the variables in this file. If you do not
want your key in this file, use line B. Then do the command `./update-tips`
yourself, with the key in your environment.

### Step 4 — Log out and log in again

GNOME Shell reads the extension and the variables only at login.

### Step 5 — Enable the extension

```bash
gnome-extensions enable lock-intro@local
```

### Step 6 — Do a test

```bash
loginctl lock-session
```

The image comes into view. Then the image goes out of view. The first tips come
20 seconds after a login. Thus the first test can show no text.

## The tips

The extension starts the program `update-tips` 20 seconds after each login, and
then one time each 6 hours. The program reads the feeds. Then the program writes
the tips to `~/.cache/lock-intro/tips.json`. The extension reads this file.

The file holds the result of the last run only. Each run replaces it. Nothing
collects. If a run finds no tips, the file is empty, and the lock screen shows
only the image.

The extension does not read the feeds. Thus a slow feed, or a failed run, cannot
stop a lock.

To get the tips immediately:

```bash
~/.local/share/gnome-shell/extensions/lock-intro@local/update-tips
```

The extension uses the new file at the next lock. You do not restart GNOME
Shell.

To stop the automatic runs, set `refreshHours` to `0` in `extension.js`.

## Configure

### Images

The variable `LOCK_INTRO_WALLPAPER` holds a path to a folder, or a path to one
image file. GNOME Shell does not read the environment of your terminal. Thus
you must put the variable in `~/.config/environment.d/`, as in step 3.

Log out and log in again after you change the variable.

The extension shows the images from a folder in a random sequence. It shows all
the images one time. Then it does the sequence again. You can add files and
remove files at any time. The next lock uses the new files.

If you do not set the variable, the extension looks in these locations in
sequence:

1. `~/Pictures/lock-intro/`
2. `~/Pictures/lock-intro.jpg`
3. No image. The lock screen shows a black background.

### Which tips

Edit `tips.toml` in the extension folder. The key `feeds` holds the feed
addresses. The key `system_prompt` holds the rules for a tip. The changes become
operative at the next run.

To see the items, and to write no data and spend no money:

```bash
./update-tips --dry-run
```

### No API key

Put `LOCK_INTRO_NO_FILTER=1` in your environment file. Then each run keeps all
the items, and sends no data to the API.

In this mode the program removes no items. To remove items, add this variable to
the same file:

```
LOCK_INTRO_SKIP=deal|\$\d|% off
```

The program removes an item if the title of the item agrees with this pattern.
As an alternative, use the option `--skip` for one run.

The necessary pattern is different for each feed. A feed that has only tips
needs no pattern. A general feed usually has advertisements.

For the other options, do this command:

```bash
./update-tips --help
```

### Times, text and layout

The block `CONFIG` is at the top of `extension.js`. This block holds the times
of the fades, the hold time, the sizes of the text, the distance from the bottom
of the screen, and `refreshHours`. It also holds `wakeIdleGateMs`. This value is
the time that you must be away. After this time, the intro comes into view
again.

Set `testPhrase` to a text to show that text at each lock. Set `testPhrase` to
`null` to show the tips again.

You must restart GNOME Shell after you change this block.

## Changes

You must restart GNOME Shell after you change `extension.js`. On X11, push
Alt+F2. Then type `r` and push Enter.

Do not disable the extension and enable it again. This procedure does not read
the new file.

You do not restart GNOME Shell after you change `tips.toml`, your images, or the
tip file.

## Troubleshooting

Is the extension installed and operative?

```bash
gnome-extensions info lock-intro@local
```

Find the errors of the extension and of the tip program. Do this command, then
lock the screen.

```bash
journalctl --user -b -f -o cat /usr/bin/gnome-shell | grep lock-intro
```

Which tips does the lock screen use?

```bash
python3 -m json.tool ~/.cache/lock-intro/tips.json | head
```

An empty tip file is not an error. The lock screen then shows only the image. If
there is also no image, the extension does nothing. You then see the usual lock
screen.
