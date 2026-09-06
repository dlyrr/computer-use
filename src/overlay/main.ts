/**
 * Process B: the overlay. Owns the tray icon, the on-screen indicator, and the
 * control socket. It is the only thing that can approve agent input, so if it
 * is not running the MCP server refuses to inject anything.
 */

import { app, BrowserWindow, Tray, Menu, dialog, ipcMain, screen, nativeImage, globalShortcut, powerMonitor, shell, desktopCapturer } from "electron";
import { spawn, ChildProcess } from "child_process";
import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { socketPath, stateDir, feed, frame, ServerMsg, OverlayMsg, Decision } from "../shared/protocol";
import { runSetup, SetupReport } from "./setup";
import { GATED_TOOLS } from "../shared/protocol";

interface LogEntry {
  id: string;
  tool: string;
  args: unknown;
  summary: string;
  ts: number;
  ok: boolean | null;
}

interface PromptState {
  id: string;
  tool: string;
  args: unknown;
  summary: string;
}

const state = {
  active: false,
  agent: "agent",
  pid: 0,
  startedAt: 0,
  paused: null as string | null,
  current: null as string | null,
  log: [] as LogEntry[],
  prompt: null as PromptState | null,
  expanded: false,
  /** User chose to hide the indicator entirely. Survives until they show it. */
  hidden: false,
};

let client: net.Socket | null = null;
let clientBuf = "";
let server: net.Server | null = null;
let tray: Tray | null = null;
let pill: BrowserWindow | null = null;
let setupWin: BrowserWindow | null = null;
let lastReport: SetupReport | null = null;
let borders: BrowserWindow[] = [];

/** True while the Escape hotkey is claimed, so we only release what we took. */
let escapeHeld = false;

// Window sizes include a 14px margin on every side for the glow.
const PILL_W = 440;
const PILL_H = 76;
const PILL_H_EXPANDED = 580;

// ------------------------------------------------------------------ plumbing

function send(msg: OverlayMsg): void {
  if (client && !client.destroyed) client.write(frame(msg));
}

function push(): void {
  const payload = {
    ...state,
    elapsed: state.active ? Date.now() - state.startedAt : 0,
    log: state.log.slice(-300),
  };
  for (const w of [pill, ...borders]) {
    if (w && !w.isDestroyed()) w.webContents.send("state", payload);
  }
  updateTray();
}

function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Computer Use\u2026", click: () => openSetup() },
      { label: "Show activity", click: () => { state.hidden = false; state.expanded = true; positionPill(); pill?.show(); push(); } },
      {
        label: "Show indicator",
        type: "checkbox",
        checked: !state.hidden,
        click: (item) => setIndicatorHidden(!item.checked),
      },
      {
        label: "Lock my input while the agent works",
        type: "checkbox",
        checked: lockInputEnabled,
        click: (item) => {
          lockInputEnabled = item.checked;
          if (!lockInputEnabled) stopInputLock();
          else if (state.active && !state.paused) startInputLock();
          refreshTrayMenu();
        },
      },
      { label: "Stop session", enabled: armed, click: () => stop() },
      {
        label: armed ? "Accepting agent sessions" : "Allow a new session",
        enabled: !armed,
        click: () => rearm(),
      },
      { type: "separator" },
      {
        label: "Start at login",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, args: [] });
          refreshTrayMenu();
        },
      },
      { label: "Open config folder", click: () => shell.openPath(stateDir()) },
      { type: "separator" },
      { label: "Quit overlay", click: () => { stop(); app.quit(); } },
    ])
  );
}

function updateTray(): void {
  if (!tray) return;
  tray.setToolTip(
    state.active
      ? `${state.agent} is controlling this computer${state.paused ? " (paused)" : ""}`
      : "agent-overlay - idle"
  );
}

// --------------------------------------------------------------- socket side

function listen(): void {
  const p = socketPath();
  if (process.platform !== "win32") {
    // A crashed previous run leaves the socket file behind; only remove it if
    // nothing is actually listening, so two overlays cannot fight.
    try {
      fs.accessSync(p);
      const probe = net.connect(p);
      probe.once("connect", () => {
        probe.destroy();
        console.error(`another overlay is already listening on ${p}`);
        app.quit();
      });
      probe.once("error", () => {
        try {
          fs.unlinkSync(p);
        } catch {
          /* nothing to clean up */
        }
        startServer(p);
      });
      return;
    } catch {
      /* no stale socket */
    }
  }
  startServer(p);
}

function startServer(p: string): void {
  server = net.createServer((sock) => {
    // Say why before hanging up. A silently closed socket is indistinguishable
    // from a successful attach, which meant a second session would quietly
    // degrade instead of reporting that it could not have the overlay.
    const refuse = (reason: "stopped" | "busy", detail: string) => {
      try {
        sock.write(frame({ t: "refused", reason, detail } as OverlayMsg));
      } catch {
        /* the peer may already be gone */
      }
      sock.end();
    };

    if (!armed) {
      refuse("stopped", "The user pressed Stop and has not re-armed the overlay.");
      return;
    }
    if (client && !client.destroyed) {
      // One agent session at a time; a second connection would make the
      // indicator ambiguous about who is driving.
      refuse("busy", `Another agent session (${state.agent || "unknown"}) is already connected.`);
      return;
    }
    client = sock;
    clientBuf = "";
    sock.setNoDelay(true);
    sock.write(frame({ t: "accepted" } as OverlayMsg));
    sock.on("data", (d) => {
      clientBuf = feed(clientBuf, d.toString("utf8"), (m) => onServerMsg(m as ServerMsg));
    });
    const gone = () => {
      if (client === sock) {
        client = null;
        endSession();
      }
    };
    sock.on("close", gone);
    sock.on("error", gone);
  });
  server.on("error", (e) => {
    console.error(`overlay could not listen on ${p}: ${e.message}`);
    app.quit();
  });
  server.listen(p, () => {
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(p, 0o600);
      } catch {
        /* best effort */
      }
    }
  });
}

function onServerMsg(m: ServerMsg): void {
  switch (m.t) {
    case "hello":
      state.active = true;
      state.agent = m.agent;
      state.pid = m.pid;
      state.startedAt = Date.now();
      state.paused = null;
      state.current = "session started";
      state.log = [];
      state.prompt = null;
      showSession();
      break;
    case "activity":
      // The agent is about to press Escape itself; stop intercepting it.
      if (m.tool === "key" && combolIncludesEscape(m.args)) releaseEscape();
      state.current = m.summary;
      state.log.push({ id: m.id, tool: m.tool, args: m.args, summary: m.summary, ts: m.ts, ok: null });
      if (state.log.length > 1000) state.log.splice(0, state.log.length - 1000);
      break;
    case "result": {
      const e = [...state.log].reverse().find((x) => x.id === m.id);
      if (e) e.ok = m.ok;
      if (!m.ok) state.current = m.summary;
      if (state.active && !state.paused) grabEscape();
      break;
    }
    case "permission":
      state.prompt = { id: m.id, tool: m.tool, args: m.args, summary: m.summary };
      showPrompt();
      break;
    case "capture":
      // Async, and deliberately not awaited: a slow grab must not stall the
      // message loop that also carries stop/pause.
      void handleCapture(m);
      return;
  }
  push();
}

/**
 * Windows lets a window opt out of screen capture entirely
 * (WDA_EXCLUDEFROMCAPTURE): it stays visible to the person sitting there but
 * does not appear in any captured frame. That is what keeps the indicator out
 * of the agent's own screenshots, so the agent sees the user's screen rather
 * than a picture of itself watching. Turned off just long enough to take a
 * shot when the agent explicitly asks to see the overlay.
 */
function setHiddenFromCapture(hidden: boolean): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.setContentProtection(hidden);
    } catch {
      /* older platform without capture exclusion; the shot just includes us */
    }
  }
}

async function handleCapture(m: Extract<ServerMsg, { t: "capture" }>): Promise<void> {
  const reply = (r: Omit<Extract<OverlayMsg, { t: "capture_result" }>, "t" | "id">) =>
    client?.write(frame({ t: "capture_result", id: m.id, ...r } as OverlayMsg));

  if (readConfig().screenshots === false) {
    reply({ ok: false, error: "screenshots_not_allowed: turn on Screenshots in the Computer Use window" });
    return;
  }

  const restore = m.includeOverlay ? () => setHiddenFromCapture(true) : () => undefined;
  if (m.includeOverlay) setHiddenFromCapture(false);

  try {
    const disp = screen.getDisplayNearestPoint({ x: Math.round(m.x), y: Math.round(m.y) });
    const nativeWidth = Math.round(disp.size.width * disp.scaleFactor);
    const nativeHeight = Math.round(disp.size.height * disp.scaleFactor);

    // Ask the compositor for the size we actually want. Scaling here is done
    // by the OS during the grab, so the big intermediate never exists.
    let thumbWidth = nativeWidth;
    let thumbHeight = nativeHeight;
    if (m.maxWidth && nativeWidth > m.maxWidth) {
      thumbWidth = m.maxWidth;
      thumbHeight = Math.max(1, Math.round((nativeHeight * m.maxWidth) / nativeWidth));
    }

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: thumbWidth, height: thumbHeight },
      fetchWindowIcons: false,
    });
    const source =
      sources.find((s) => String(s.display_id) === String(disp.id)) ?? sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      reply({ ok: false, error: "desktopCapturer returned no usable frame" });
      return;
    }

    const size = source.thumbnail.getSize();
    reply({
      ok: true,
      // Near-lossless: the server re-encodes to its own quality, and this hop
      // is only crossing a local pipe.
      data: source.thumbnail.toJPEG(92).toString("base64"),
      mime: "image/jpeg",
      imageWidth: size.width,
      imageHeight: size.height,
      nativeWidth,
      nativeHeight,
    });
  } catch (e: any) {
    reply({ ok: false, error: String(e?.message ?? e) });
  } finally {
    restore();
  }
}

function endSession(): void {
  state.active = false;
  state.paused = null;
  state.prompt = null;
  state.current = null;
  state.expanded = false;
  hideSession();
  push();
}

// -------------------------------------------------------------------- windows

function viewUrl(view: "pill" | "border"): string {
  return `file://${path.join(__dirname, "index.html")}?view=${view}`;
}

function makePill(): void {
  if (pill && !pill.isDestroyed()) return;
  pill = new BrowserWindow({
    width: PILL_W,
    height: PILL_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  pill.setAlwaysOnTop(true, "screen-saver");
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  try {
    pill.setContentProtection(true); // keep the indicator out of agent screenshots
  } catch {
    /* platform without capture exclusion */
  }
  pill.loadURL(viewUrl("pill"));
  pill.on("closed", () => (pill = null));
  positionPill();
}

function positionPill(): void {
  if (!pill || pill.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  const h = state.expanded ? PILL_H_EXPANDED : PILL_H;
  // Top-centre, where it cannot be missed. Idle, the pill is hidden entirely
  // and comes back only from the tray.
  const x = wa.x + Math.round((wa.width - PILL_W) / 2);
  const y = wa.y + 4;
  pill.setBounds({ x, y, width: PILL_W, height: h });
}

function rebuildBorders(): void {
  for (const w of borders) if (!w.isDestroyed()) w.destroy();
  borders = [];
  if (!state.active) return;
  for (const d of screen.getAllDisplays()) {
    const w = new BrowserWindow({
      ...d.bounds,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      enableLargerThanScreen: true,
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
    });
    w.setIgnoreMouseEvents(true, { forward: true });
    w.setAlwaysOnTop(true, "screen-saver");
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    try {
      w.setContentProtection(true); // the border must not frame the agent's own shots
    } catch {
      /* platform without capture exclusion */
    }
    w.loadURL(viewUrl("border"));
    w.once("ready-to-show", () => {
      w.showInactive();
      push();
    });
    borders.push(w);
  }
}

function showSession(): void {
  makePill();
  positionPill();
  if (!state.hidden) pill?.showInactive();
  rebuildBorders();
  grabEscape();
  startInputLock();
  startCursor();
}

/**
 * The agent has finished. The border glow goes away with the border windows,
 * and the indicator returns to its corner rather than vanishing, so there is
 * still something to click to review what happened - or to hide.
 */
function hideSession(): void {
  releaseEscape();
  stopInputLock();
  stopCursor();
  for (const w of borders) if (!w.isDestroyed()) w.destroy();
  borders = [];
  state.expanded = false;
  positionPill();
  pill?.hide();
}

/**
 * While the agent drives, the system arrow becomes the agent's arrow, so the
 * person watching can tell whose pointer is moving. Same helper pattern as
 * the input lock: a child process that restores the cursors when it dies.
 */
let cursorProc: ChildProcess | null = null;

function startCursor(): void {
  if (cursorProc || process.platform !== "win32") return;
  const exe = path.join(__dirname, "..", "..", "scripts", "agent-cursor.exe");
  const cur = path.join(__dirname, "..", "..", "scripts", "agent.cur");
  if (!fs.existsSync(exe) || !fs.existsSync(cur)) return;
  try {
    const child = spawn(exe, [cur, String(LOCK_MAX_SECONDS)], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    cursorProc = child;
    const gone = () => { if (cursorProc === child) cursorProc = null; };
    child.on("exit", gone);
    child.on("error", gone);
  } catch {
    cursorProc = null;
  }
}

function stopCursor(): void {
  const child = cursorProc;
  cursorProc = null;
  if (!child) return;
  try { child.stdin?.end(); } catch { /* already gone */ }
  setTimeout(() => { try { if (!child.killed) child.kill(); } catch { /* already gone */ } }, 500);
}

function setIndicatorHidden(hidden: boolean): void {
  state.hidden = hidden;
  if (pill && !pill.isDestroyed()) {
    if (hidden) pill.hide();
    else {
      positionPill();
      pill.showInactive();
    }
  }
  refreshTrayMenu();
  push();
}

function showPrompt(): void {
  state.expanded = true;
  makePill();
  positionPill();
  if (pill && !pill.isDestroyed()) {
    pill.show();
    pill.focus();
  }
}

// ------------------------------------------------------------------- takeover

/**
 * Escape is the user's brake. It is grabbed globally only while a session is
 * running, so it behaves normally the rest of the time, and it is handed back
 * for the moment the agent itself is pressing Escape.
 */
/**
 * While the agent is driving, the person at the keyboard is held off entirely,
 * so a stray click cannot land in the middle of an action. Escape releases it.
 *
 * The helper is a separate process for a reason: it dies when this process
 * dies, and Windows removes its hooks when it dies, so a crash here can never
 * leave the machine unusable. See scripts/input-lock.cs for the other releases.
 */
let inputLock: ChildProcess | null = null;
// Off by default: holding the person off their own keyboard is opt-in (tray menu).
let lockInputEnabled = false;
const LOCK_MAX_SECONDS = 900;

function startInputLock(): void {
  if (inputLock || !lockInputEnabled || process.platform !== "win32") return;
  const exe = path.join(__dirname, "..", "..", "scripts", "input-lock.exe");
  if (!fs.existsSync(exe)) return;
  try {
    const child = spawn(exe, [String(LOCK_MAX_SECONDS)], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    inputLock = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (chunk.includes("escape")) pause("you pressed Escape");
    });
    const gone = () => {
      if (inputLock === child) inputLock = null;
    };
    child.on("exit", gone);
    child.on("error", gone);
  } catch {
    inputLock = null;
  }
}

function stopInputLock(): void {
  const child = inputLock;
  inputLock = null;
  if (!child) return;
  // Closing stdin is the helper's own release signal; the kill is only there
  // in case it is already wedged.
  try {
    child.stdin?.end();
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      if (!child.killed) child.kill();
    } catch {
      /* already gone */
    }
  }, 500);
}

function grabEscape(): void {
  if (escapeHeld) return;
  escapeHeld = globalShortcut.register("Escape", () => pause("you pressed Escape"));
}

function releaseEscape(): void {
  if (!escapeHeld) return;
  globalShortcut.unregister("Escape");
  escapeHeld = false;
}

/** Does this key combo include Escape? Then the agent needs the real key. */
function combolIncludesEscape(args: unknown): boolean {
  const combo = (args as { combo?: unknown } | null)?.combo;
  return typeof combo === "string" && /(^|\+)\s*(esc|escape)\s*($|\+)/i.test(combo);
}

function pause(reason: string): void {
  if (!state.active || state.paused) return;
  state.paused = reason;
  state.expanded = true;
  stopInputLock();
  send({ t: "pause", reason });
  positionPill();
  pill?.showInactive();
  push();
}

function resume(): void {
  if (!state.paused) return;
  state.paused = null;
  startInputLock();
  send({ t: "resume" });
  push();
}

/**
 * Whether the overlay will accept a new agent session. Stop clears it, and
 * only the user sets it again - so Stop is a barrier the user holds, not a
 * flag buried in a process they cannot reach. Re-arming used to require
 * restarting the MCP server from the CLI, which is not a thing to ask of
 * someone who just hit a panic button.
 */
let armed = true;

function stop(): void {
  stopInputLock();
  send({ t: "stop" });
  // Revoke the socket: the server's connection is torn down, and nothing new
  // is served until the user re-arms from the tray.
  client?.destroy();
  client = null;
  armed = false;
  endSession();
  refreshTrayMenu();
}

function rearm(): void {
  armed = true;
  refreshTrayMenu();
}

// ----------------------------------------------------------------------- tray

/**
 * Render the tray icon once into a temp PNG. sharp is already a dependency, so
 * no binary asset has to live in the repo.
 */
async function appIcon(size = 32): Promise<Electron.NativeImage> {
  const file = path.join(os.tmpdir(), `agent-overlay-icon-${size}.png`);
  try {
    if (!fs.existsSync(file)) {
      const svg = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
           <circle cx="16" cy="16" r="12" fill="none" stroke="#4c8dff" stroke-width="4"/>
           <circle cx="16" cy="16" r="4" fill="#4c8dff"/>
         </svg>`
      );
      const sharp = require("sharp");
      fs.writeFileSync(file, await sharp(svg).png().toBuffer());
    }
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img;
  } catch {
    /* fall through */
  }
  // An empty image still gives a clickable tray entry rather than no tray.
  return nativeImage.createEmpty();
}

async function makeTray(): Promise<void> {
  tray = new Tray(await appIcon(32));
  refreshTrayMenu();
  tray.on("click", () => {
    if (!state.active) return void openSetup();
    state.expanded = !state.expanded;
    positionPill();
    pill?.show();
    push();
  });
  updateTray();
}

/**
 * Register the MCP server with whatever clients are installed, every launch.
 * The very first time, tell the user what happened and offer auto-start - after
 * that it is silent unless something failed.
 */
async function firstRun(): Promise<void> {
  const marker = path.join(stateDir(), "setup-done");
  const first = !fs.existsSync(marker);
  let report: SetupReport;
  try {
    report = await runSetup();
  } catch (e: any) {
    dialog.showMessageBox({ type: "error", title: "agent-overlay setup", message: "Setup failed", detail: String(e?.message ?? e) });
    return;
  }
  lastReport = report;
  refreshTrayMenu();
  const problems = [report.claudeDesktop, report.claudeCode].filter(
    (v) => v !== "registered" && v !== "already" && v !== "not-installed"
  );
  if (first) fs.writeFileSync(marker, new Date().toISOString());
  if (first || problems.length) void openSetup();
  else pushSetup();
}

// ------------------------------------------------------------ Computer Use

/**
 * The "Enable Computer Use" window: the app's face. Four permission rows, each
 * backed by something real - the input tools' modes, the screenshot gate, the
 * file/command modes, and the MCP registration - not a decorative checklist.
 */
const INPUT_TOOLS = GATED_TOOLS.filter((t) => t !== "run_command" && t !== "write_file");
const FILE_TOOLS = ["run_command", "write_file"] as const;

function configFile(): string {
  return path.join(stateDir(), "config.json");
}

function readConfig(): any {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(edit: (cfg: any) => void): void {
  const cfg = readConfig();
  cfg.modes = cfg.modes ?? {};
  edit(cfg);
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + "\n");
}

function setupState() {
  const cfg = readConfig();
  const modes: Record<string, string> = cfg.modes ?? {};
  const ok = (v: string) => v === "registered" || v === "already";
  const r = lastReport;
  const label = (v: string) => (ok(v) ? "connected" : v === "not-installed" ? "not installed" : v);
  return {
    agent: cfg.agentName ?? "Claude",
    roots: (cfg.roots ?? []).map((p: string) => path.basename(p) || p),
    input: !INPUT_TOOLS.some((t) => modes[t] === "deny"),
    screenshots: cfg.screenshots !== false,
    files: !FILE_TOOLS.some((t) => modes[t] === "deny"),
    connect: {
      on: !!r && (ok(r.claudeCode) || ok(r.claudeDesktop)),
      detail: r ? `Claude Code: ${label(r.claudeCode)} \u00b7 Claude Desktop: ${label(r.claudeDesktop)}` : "Checking\u2026",
    },
    login: app.getLoginItemSettings().openAtLogin,
  };
}

function pushSetup(): void {
  if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send("setup", setupState());
}

async function openSetup(): Promise<void> {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show();
    setupWin.focus();
    return;
  }
  setupWin = new BrowserWindow({
    width: 720,
    height: 740,
    resizable: false,
    maximizable: false,
    show: false,
    title: "Computer Use",
    backgroundColor: "#f3f0f2",
    frame: false,
    icon: await appIcon(256),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  setupWin.setMenuBarVisibility(false);
  setupWin.loadURL(`file://${path.join(__dirname, "setup.html")}`);
  setupWin.once("ready-to-show", () => setupWin?.show());
  setupWin.on("closed", () => (setupWin = null));
}

// ---------------------------------------------------------------- app wiring

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(async () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    await makeTray();
    makePill();
    // Listen before setup: the first-run dialog is modal, and a server that is
    // already waiting must not be blocked behind it.
    listen();
    void firstRun();

    // A locked or sleeping screen means the user cannot see the indicator.
    powerMonitor.on("lock-screen", () => pause("the screen locked"));
    powerMonitor.on("suspend", () => pause("the computer went to sleep"));

    // Displays can be added, removed or rescaled at any time.
    const rebuild = () => {
      positionPill();
      if (state.active) rebuildBorders();
    };
    screen.on("display-added", rebuild);
    screen.on("display-removed", rebuild);
    screen.on("display-metrics-changed", rebuild);

    // Panic stop that works even when a full-screen app has the foreground.
    // ponytail: this is the only global key we grab; full keyboard-takeover
    // detection needs a native hook, add one if mouse-only proves too coarse.
    globalShortcut.register("Control+Alt+X", () => stop());
  });

  // The overlay lives in the tray; an empty handler stops Electron's default
  // "last window closed means quit" behaviour.
  app.on("window-all-closed", () => {});

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    server?.close();
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(socketPath());
      } catch {
        /* already gone */
      }
    }
  });
}

// --------------------------------------------------------------- renderer IPC

ipcMain.on("ui", (_e, msg: { t: string; id?: string; decision?: Decision }) => {
  switch (msg.t) {
    case "ready":
      push();
      break;
    case "decision":
      if (state.prompt && msg.id === state.prompt.id && msg.decision) {
        send({ t: "decision", id: msg.id, decision: msg.decision });
        state.prompt = null;
        // The pill grabbed focus for the modal; hand it back.
        pill?.blur();
        push();
      }
      break;
    case "stop":
      stop();
      break;
    case "resume":
      resume();
      break;
    case "end":
      stop();
      break;
    case "toggle":
      state.expanded = !state.expanded;
      positionPill();
      push();
      break;
    case "setup:ready":
      pushSetup();
      break;
    case "setup:toggle": {
      const on = !!(msg as any).on;
      const key = (msg as any).key;
      writeConfig((cfg) => {
        if (key === "input") for (const t of INPUT_TOOLS) cfg.modes[t] = on ? (t === "type_text" ? "prompt" : "allow") : "deny";
        else if (key === "files") for (const t of FILE_TOOLS) cfg.modes[t] = on ? "prompt" : "deny";
        else if (key === "screenshots") cfg.screenshots = on;
      });
      pushSetup();
      break;
    }
    case "setup:connect":
      runSetup().then(
        (r) => { lastReport = r; pushSetup(); },
        (e) => dialog.showErrorBox("Setup failed", String(e?.message ?? e))
      );
      break;
    case "setup:login":
      app.setLoginItemSettings({ openAtLogin: !!(msg as any).on, args: [] });
      refreshTrayMenu();
      pushSetup();
      break;
    case "setup:openConfig":
      shell.openPath(stateDir());
      break;
    case "setup:close":
      setupWin?.close();
      break;
    case "setup:min":
      setupWin?.minimize();
      break;
  }
});
