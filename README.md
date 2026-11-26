# dsh-terminal-workspace

An iTerm2-style terminal workspace in the DeepSeek Harness Web UI, shaped like
the terminal emulator people already use: a tab strip on top, and every tab
split into panes.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-terminal-workspace
```

Then open **Plugins** in the sidebar and turn the bundle on; a **Terminal** row
appears in the left sidebar. Enable the whole bundle rather than its single row,
and restart the app once so the client bundle is loaded.

Requires DeepSeek Harness 0.2.2-rc.1 or newer (`engines.dsh` is
`>0.2.2-rc.0 <0.3.0-0`).

## What it adds

- A **Terminal** row in the left sidebar (below *Plugins*), opening one
  **global** workspace: the same tabs and splits are there whichever
  conversation you are in.
- **Tabs**: `+` adds one, double-click a tab to rename it, the tab's × or a
  middle click closes it and ends its shell.
- **Split panes**: the two split buttons in a pane header divide that pane to
  the right or downward. Drag the gutter between two panes to resize them; the
  split ratio is remembered with the layout. On macOS the keyboard chords are
  `⌘D` (split right) and `⌘⇧D` (split down); elsewhere they are `Alt+Shift+D`
  and `Alt+Shift+E`, because `Ctrl+D` belongs to the shell.
- **One workspace for the whole app.** There is no per-conversation terminal:
  the tab strip, the splits and every shell belong to one global panel, and the
  layout is remembered across reloads.

Keyboard: `Tab` moves between controls, `Enter` opens a pane title for
renaming, `F2` renames a tab, `←`/`→`/`Home`/`End` move along the tab strip, and
the tab's × button is reachable by `Tab` once the tab is focused.

## How it relates to the built-in terminal

The plugin owns no PTY. Each pane is an xterm.js screen bound to the installed
`@deepseek-ai/dsh-api-terminal-controller` Client service (`ctx.webTerminals`),
the same service behind the shipped right-sidebar terminal tabs. That service
owns process lifetime, screen recovery and reconnection, so:

- A shell keeps running while you switch tabs or reload the page, and it
  recovers its screen when you come back.
- Closing a pane or tab ends that shell, exactly like closing a terminal tab.
- Without that service the panel says so and starts no shells.

Because the plugin drives that service rather than a private one, only one
Harness window should type into a given shell at a time; the service serializes
input across windows and marks the other attachments read-only with a
**Take control** action.

The service allocates a shell under a conversation, so the workspace keeps one
internal "anchor" conversation for its shells. That choice is made once and
never shown: the panel has no Session picker, and changing the conversation on
screen does not touch it.

## Availability

xterm.js and its fit addon are vendored under `vendor/` (MIT; see
`vendor/LICENSE.xterm` and `vendor/LICENSE.addon-fit`) and packaged into the
lazy chunk `client/client.xterm.js` by `node scripts/build-chunk.mjs`. The
panel bundle itself stays small: the emulator is fetched the first time a pane
mounts.

## After a restart

A PTY lives in the Harness process, so restarting the app ends every shell. The
plugin keeps each pane's **last screen** in `localStorage` (about 300 lines /
24k characters per pane) and replays it when the panel reopens, with a note
explaining that no shell is running. **New terminal** starts a fresh shell;
**Clear** discards the saved screen. Closing a pane or tab deletes its saved
screen.

What this restores is the *text you last saw* — output already printed, prompts,
and any commands that are still on screen. It cannot restore a running process,
so a build or a server that was in the middle of something is gone.

## Limits

- Layouts and the per-pane last screens live in `localStorage` (one workspace
  per browser profile); another browser or profile starts empty.
- The restored screen is text only: colours and cursor position come back as
  the last screen had them, not as a live terminal.
- A shell that the Host no longer knows (a Host restart) is reported and the
  pane offers **New terminal**.
- The Host's terminal count limit still applies; a pane that hits it says so.
- The terminal service reclaims a shell that has been idle for two hours with no
  attached window. An on-screen pane reattaches before that clock matters, but a
  workspace you leave for a long time may come back to an **exited** pane; the
  pane then offers **New terminal**. The shipped right-sidebar terminal holds
  its own shells against that reclamation, and this plugin deliberately does not
  touch that hold list — two plugins writing it would evict each other's.
