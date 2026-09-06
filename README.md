# agent-overlay

A local computer-use MCP server with a companion overlay that shows the user, in
real time, when an agent is driving their machine — and lets them stop it.

Two processes, deliberately separate:

| | |
|---|---|
| **Process A** — `dist/server/index.js` | The MCP server. stdio transport, no UI. Started by the MCP client (Claude Desktop, Claude Code, …). |
| **Process B** — `electron .` | The overlay. Owns the tray icon, the screen border, the status pill, the activity log and the permission modals. Started by the user, independently. |

They talk over a local socket: a **named pipe** on Windows
(`\\.\pipe\agent-overlay-<username>`), a **unix domain socket** on Linux
(`$XDG_RUNTIME_DIR/agent-overlay-<uid>.sock`, mode 0600).

**If the overlay is not running, every input-injecting tool fails closed** with
`overlay_unavailable`. There is no code path that moves the mouse, presses a
key, writes a file or runs a command without a visible indicator on screen.

---

## Install

Requires **Node 20+** for the first build. After that the app is self-contained.

```bash
git clone <this repo> agent-overlay
```

Then **double-click `start.cmd`** (Windows) or run `./start.sh` (Linux). It
installs dependencies and builds on first run, then launches the app.

That is the whole install. On first launch the app:

1. writes a default config to `~/.agent-overlay/config.json`,
2. registers the MCP server with **Claude Desktop**, backing up
   `claude_desktop_config.json` to `...json.agent-overlay.bak` first,
3. registers it with **Claude Code** via `claude mcp add --scope user`, if the
   CLI is installed,
4. offers to start itself at login.

Restart Claude Desktop afterwards so it picks up the new server. Setup re-runs on
every launch and is idempotent; **Re-run setup** in the tray menu forces it and
shows a report.

The registered command is the app's own Electron binary with
`ELECTRON_RUN_AS_NODE=1`, so nothing depends on a separate Node install once
built.

### You do not have to start the overlay by hand

If an MCP client starts the server while the overlay is not running, the server
launches the overlay itself and waits (up to 20s) for it to come up before
running the tool. If it cannot be started, the call still fails closed. Set
`AGENT_OVERLAY_NO_LAUNCH=1` to disable that and require a manual launch.

`npm start`, `npm run overlay` and `claude_desktop_config.example.json` are still
there if you would rather wire it up yourself.

## Permissions setup

Config lives at `~/.agent-overlay/config.json` (override the directory with
`AGENT_OVERLAY_HOME`). Copy `config.example.json` there.

```json
{
  "agentName": "Claude",
  "roots": ["C:\\Users\\you\\projects"],
  "modes": { "type_text": "prompt", "run_command": "prompt", "click": "allow" }
}
```

- **`roots`** — the only directories `read_file`, `write_file`, `list_dir` and
  `run_command`'s `cwd` may touch. Paths are resolved through symlinks first, so
  a link inside a root cannot escape it. Anything else returns
  `outside_allowlist`. The agent cannot widen this; only you can, by editing the
  file.
- **`modes`** — per tool, one of:
  - `allow` — runs, still shown in the pill and the log.
  - `prompt` — the overlay shows a modal with the exact call. You choose
    **Allow once**, **Allow for session**, or **Deny**. The server blocks until
    you answer.
  - `deny` — never runs; the model gets a `permission_denied` explaining that
    you set it.
- Any gated tool missing from `modes` defaults to `prompt`.

Gated tools: `click`, `move`, `drag`, `mouse_down`, `mouse_up`, `key_down`,
`key_up`, `scroll`, `type_text`, `key`, `focus_window`, `run_command`,
`write_file`.

`mouse_down`, `mouse_up`, `key_down` and `key_up` default to `allow`, since
holding a button or a modifier is part of an ordinary drag — an existing
`config.json` without those keys will not start prompting for them.

`screenshot` needs no per-call approval but *does* require the overlay to be
running — seeing your screen is part of what the indicator is there to make
visible.

### Audit log

Every tool call appends one JSON line to `~/.agent-overlay/audit.log`:

```json
{"ts":"2026-09-02T10:31:04.221Z","pid":41244,"id":"a1b2…","tool":"click","args":{"x":840,"y":312,"button":"left","clicks":1},"ok":true,"ms":38}
```

Permission decisions are logged as their own line with a `decision` field.
Tray → **Open audit log folder**.

---

## OS-level access each platform needs

### Windows 11 (primary)

- Nothing to enable up front. Mouse, keyboard and screen capture work for a
  normal desktop user.
- **PowerShell must be runnable.** Window listing and focusing use the bundled
  `scripts/win32.ps1`, invoked with `-ExecutionPolicy Bypass -File`, so a
  restrictive machine-wide policy is worked around — but if PowerShell itself is
  blocked, `list_windows` returns `platform_error`.
- **Elevated windows are off limits.** A process running as a normal user cannot
  send input to a window running as administrator (UIPI). Clicks into an admin
  console or a UAC prompt are silently dropped by Windows. If the agent gets
  stuck, that is usually why. Do not run the overlay elevated to work around
  this unless you mean it.
- **Display scaling** is handled for you: the server maps screenshot pixels to
  the same logical coordinate space the input backend uses, so a 150% display
  needs no maths from the model.

### Linux (secondary, X11)

- **X11 only.** Under a pure Wayland session, synthetic input and full-screen
  capture are blocked by the compositor; log in with an "on Xorg" session.
- Install the window helpers:
  ```bash
  sudo apt install wmctrl xdotool
  ```
  Missing binaries surface as `missing_dependency`, not a silent failure.
- `screenshot-desktop` uses `imagemagick`'s `import` on Linux:
  ```bash
  sudo apt install imagemagick
  ```
- Your user must be able to talk to the X display (the normal case for a
  desktop login). Over SSH, `DISPLAY` must be set and X access granted.

---

## Overlay behaviour

### While the agent is driving

The indicator moves to the **top centre** of the screen and reads
"<agent> is using your computer.", and the screen edge glows. Both are gone the
moment the session ends: the border windows are destroyed and the indicator
returns to its corner, where it stays as a quiet idle chip. Hide it entirely
with **Show indicator** in the tray menu.

### Your input is held off while it works

Physical keyboard and mouse input is swallowed for the duration, so a stray
click cannot land in the middle of an agent action. Injected input is passed
through, which is what lets the agent keep working while you are held off.

**Press Escape to take back control** - that pauses the session and releases
your input immediately.

This is the one piece that could strand you, so it has four independent
releases, and it is a separate process (`scripts/input-lock.exe`) precisely so
that its lifetime cannot exceed the overlay's:

1. Escape releases it.
2. Ending, pausing or stopping the session releases it.
3. If the overlay dies, the helper's stdin closes and it exits - and Windows
   removes its hooks when it does.
4. A hard timeout releases it regardless.

Turn it off with **Lock my input while the agent works** in the tray menu.


- **Border glow** — a coloured, breathing border on *every* display while a
  session is active. It is always-on-top and click-through, so it is visible
  from any app without stealing focus. Blue = running, amber = paused, red = a
  permission modal is waiting.
- **Status pill** — top centre while a session runs, bottom right when idle. It
  reads "<agent> is using your computer." while driving and falls back to the
  agent name and pid when not, alongside the current action in plain language
  (`clicking at 840, 312`, `typing "hello" into Notepad`) and elapsed time.
- **Stop** — kills the session immediately: the server is told to stop, the
  socket is destroyed, and every subsequent tool call returns `session_stopped`.
  Also bound globally to **Ctrl+Alt+X**, so it works even when a full-screen app
  has the foreground.
- **Activity log** — click the chevron (or the tray icon) to expand a scrollable
  log of every tool call: timestamp, tool, plain-language summary, full
  arguments, and whether it succeeded.
- **Takeover** — press **Escape** while a session is active and the overlay
  pauses it, showing **Resume** / **End**. The server refuses injecting tools
  with `session_paused` until you resume. Screen lock and sleep pause it too.
  Escape is only grabbed globally while a session is running, and is handed back
  for the instant the agent presses Escape itself, so it behaves normally the
  rest of the time. Moving the mouse does *not* pause anything.
- **Idle** — tray icon only, no screen chrome.

---

## Tools

| Tool | Gated | Notes |
|---|---|---|
| `screenshot(display?, region?, include_overlay?)` | overlay required | JPEG, max 1280px wide. Returns `shot_width`, `shot_height`, `scale`, `origin`. The overlay itself is excluded from the frame unless `include_overlay` is true. |
| `batch(steps, screenshot?, display?)` | per step | Up to 25 actions in one call, then a screenshot. Each step is gated individually. |
| `wait_for(until, region?, timeout_ms?, poll_ms?)` | overlay required | Polls until the watched area `changes` or `settles`, then returns a screenshot. Returns `outcome: changed \| settled \| timeout`. |
| `list_displays()` | no | `{index, name, primary, x, y, width, height}`. |
| `click(x, y, button, clicks)` | yes | |
| `move(x, y)` | yes | |
| `drag(from, to, button, via?, hold_ms?)` | yes | `via` adds waypoints to pass through; `hold_ms` pauses over the destination before releasing. |
| `mouse_down(x?, y?, button)` / `mouse_up(x?, y?, button)` | yes | Hold a button down across moves and across calls. Released automatically on pause, stop, batch failure or overlay loss. |
| `key_down(combo)` / `key_up(combo)` | yes | Hold modifiers for shift-click, ctrl-click, shift-drag. Released on the same events. |
| `scroll(x, y, amount, axis)` | yes | `amount` in wheel clicks; positive = down/right. |
| `type_text(text)` | yes | Literal characters only. |
| `key(combo)` | yes | Chords: `ctrl+shift+esc`, `alt+f4`, `win+d`. |
| `list_windows()` | no | `{id, pid, title, bounds, focused, minimized}`. |
| `focus_window(id)` | yes | Stale ids return `stale_window_id` with current ids attached. |
| `run_command(cmd, cwd?, timeout)` | yes | `{stdout, stderr, exit_code, timed_out}`. |
| `read_file` / `write_file` / `list_dir` | write only | Allowlisted roots. |

### Gestures that need a button held

A single `drag` is press, travel, release - which is the wrong shape for a lot
of real interactions. `mouse_down` and `mouse_up` keep the button down *between*
tool calls, so the pointer can travel through as many moves as it likes, and the
agent can stop and look at a screenshot mid-drag before deciding where to go
next. `key_down`/`key_up` do the same for modifiers.

That makes these possible, none of which a straight A-to-B drag can express:

- multi-segment drags and freehand strokes on a canvas
- drop targets that only activate when the pointer crosses them (`via`)
- drop handlers and spring-loaded tree views that need a hover (`hold_ms`)
- shift-click to extend a selection, ctrl-click to add to one
- shift-drag to constrain an angle, alt-drag to duplicate
- dragging a slider, reading the value, then continuing before releasing

A whole gesture fits in one `batch`:

```json
{"steps": [
  {"action": "mouse_down", "x": 420, "y": 420},
  {"action": "move", "x": 470, "y": 420},
  {"action": "move", "x": 470, "y": 470},
  {"action": "mouse_up", "x": 470, "y": 470}
]}
```

**Held input is always released.** A button left down would be the worst thing
this can leave behind, so it is let go on pause, on stop, if a batch step fails,
if the overlay disconnects, and on process exit.

### Latency

A round trip through the agent costs far more than any single action, so the
two things that matter are doing fewer calls and making each one cheap.

- **`batch` is the fast path.** Click, type, press enter and look is one call,
  not four. Every step still goes through the overlay gate individually, and a
  denied step stops the batch. Coordinates inside a batch are all in the pixel
  space of the screenshot taken *before* it — they are not re-based as the
  screen changes, so end the batch and look again after anything that moves the
  layout.
- **`wait_for` replaces polling by screenshot.** One call instead of "look,
  still loading, look again".
- Screenshots are captured **inside the overlay** (Electron `desktopCapturer`),
  which is already running whenever a capture is legal. That is ~200ms instead
  of ~480ms for a helper subprocess, with no process spawn. If the overlay
  cannot answer, the platform helper is used instead — same result, slower.
- Whole-screen shots are scaled during the grab; `region` shots are cropped
  from a full-resolution frame so they actually show more detail.
- Frames are JPEG rather than PNG: roughly 95 KB of base64 instead of 640 KB,
  and every byte crosses the stdio transport.

`AGENT_OVERLAY_MOUSE_SPEED` (px/sec, default 3200) controls the pointer glide;
set it to `0` to make the pointer jump instantly instead.

### Coordinates

**All coordinates are in the pixel space of the most recent screenshot**, with
`(0, 0)` at its top-left corner. The server converts to physical screen
coordinates itself, including display scaling and multi-monitor offsets. Models
get DPI wrong every time, so they never see it.

- `screenshot` returns `scale` (screenshot pixels per screen unit) and `origin`
  (screen coordinate of the image's top-left pixel) if you want to reason about
  it, but you do not need to.
- Clicking before any screenshot returns `no_screenshot`.
- A point outside the last screenshot returns `out_of_bounds` with the actual
  dimensions.
- `region` is expressed in the pixel space of a *full* screenshot of that
  display — a fixed space that does not depend on what you captured before — and
  the crop is re-downscaled, so a region gives more detail. After a region shot,
  coordinates are relative to the crop.

### Errors

Every failure returns JSON, never a silent no-op:

```json
{ "error": "stale_window_id", "message": "Window id 0x00120a34 no longer exists …", "detail": { "availableIds": [] } }
```

Codes: `overlay_unavailable`, `session_stopped`, `session_paused`,
`permission_denied`, `no_screenshot`, `out_of_bounds`, `capture_failed`,
`no_display`, `unknown_display`, `stale_window_id`, `focus_refused`,
`outside_allowlist`, `not_found`, `too_large`, `is_directory`, `bad_key`,
`bad_button`, `missing_dependency`, `platform_error`, `timeout`,
`internal_error`.

---

## Verify the overlay is actually gating input

Do this once before you trust it.

**0. Automated check.** With the overlay **not** running:

```bash
node scripts/verify-fail-closed.js
```

It runs the real MCP server over stdio with `AGENT_OVERLAY_NO_LAUNCH=1` (so it
tests the refusal path, not the auto-launch path), lists the tools, and asserts
that `click` and `screenshot` both come back `overlay_unavailable`. Non-zero exit
means the invariant is broken.

**1. No overlay ⇒ no input.**

```bash
# make sure the overlay is NOT running, then:
AGENT_OVERLAY_NO_LAUNCH=1 node dist/server/index.js
```

Paste an MCP `tools/call` for `click` (or just ask your agent to click
something). It must return:

```json
{ "error": "overlay_unavailable", "message": "The overlay app is not running, so there is no visible indicator …" }
```

Nothing on screen moves. If the pointer moves, stop and file a bug — that is the
one invariant this project exists to hold.

**2. Overlay up ⇒ visible session.** Start `npm run overlay`, ask the agent for a
screenshot. A blue border must appear on every monitor and the pill must show
the agent name.

**3. Prompt mode blocks.** Set `"type_text": "prompt"`, ask the agent to type
something. The modal must appear showing the exact string, and the agent must
sit there waiting until you answer. Press **Deny** — the agent gets
`permission_denied` and nothing is typed.

**4. Stop revokes.** Start a long series of clicks, press **Stop** (or
Ctrl+Alt+X). The border disappears immediately and every following call returns
`session_stopped`.

**5. Escape pauses.** While the agent is working, press Escape. The border turns
amber, the pill offers Resume/End, and the next injecting call returns
`session_paused`.

**6. The log matches reality.** Expand the pill; every action you saw happen is
there with its arguments. Cross-check `~/.agent-overlay/audit.log`.

---

## Known limits

- **Escape is the only takeover key.** Catching arbitrary keystrokes needs a
  native global hook, so Escape is grabbed explicitly, and only while a session
  is live. Ctrl+Alt+X remains the hard stop.
- **One session at a time.** A second MCP server connecting while one is active
  is refused, so the indicator always names exactly one agent.
- **Wayland is unsupported** for input and capture, by the compositor, not by us.
- **Elevated Windows apps** cannot be driven from a non-elevated overlay.
