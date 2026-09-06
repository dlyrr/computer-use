import * as net from "net";
import * as path from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import {
  socketPath,
  feed,
  frame,
  ServerMsg,
  OverlayMsg,
  Decision,
} from "../shared/protocol";
import { loadConfig } from "./config";

/** Every failure surfaced to the model carries a machine-readable code. */
export class ToolError extends Error {
  constructor(public code: string, message: string, public detail?: unknown) {
    super(message);
  }
}

type Pending = (d: Decision) => void;

export interface OverlayShot {
  buf: Buffer;
  imageWidth: number;
  imageHeight: number;
  nativeWidth: number;
  nativeHeight: number;
}

type PendingShot = (r: OverlayShot | Error) => void;

class OverlayLink {
  private sock: net.Socket | null = null;
  private buf = "";
  private pending = new Map<string, Pending>();
  private pendingShots = new Map<string, PendingShot>();
  private connecting: Promise<void> | null = null;
  /** Set when the user (or the lock screen) paused the session. */
  paused: string | null = null;
  /**
   * Set when the user pressed Stop. Not terminal: the overlay decides whether
   * a new session may start, so we re-ask rather than refusing forever from a
   * flag the user has no way to clear.
   */
  stopped = false;
  /** Why the overlay last turned us away, for a useful error message. */
  private refusal: { reason: "stopped" | "busy"; detail?: string } | null = null;
  /** Set when the overlay confirms it is serving this connection. */
  private handshook = false;
  /**
   * Called when a session is paused, stopped, or the overlay goes away. Set by
   * the server so held mouse buttons and keys can be let go; a callback rather
   * than a direct import because input.ts already imports this module.
   */
  onInterrupt: (() => void) | null = null;
  /** Tools the user approved for the remainder of this session. */
  sessionAllowed = new Set<string>();

  get connected(): boolean {
    return !!this.sock && !this.sock.destroyed;
  }

  /**
   * Connect to the overlay, or throw. Called before any gated tool so that a
   * missing indicator means no input is ever injected.
   */
  async ensure(opts: { launch?: boolean } = {}): Promise<void> {
    if (this.connected) return;
    if (!this.connecting) {
      this.connecting = this.connect(opts.launch !== false).finally(() => (this.connecting = null));
    }
    return this.connecting;
  }

  /** Tried to start the overlay ourselves already this process. */
  private launched = false;

  private async connect(launch: boolean): Promise<void> {
    try {
      await this.dial();
      return;
    } catch (e) {
      if (!launch || this.launched) throw e;
    }
    // The overlay is the thing the user watches, so start it for them rather
    // than making them run a second command - then wait for it to accept us.
    this.launched = true;
    if (!launchOverlay()) await this.dial(); // rethrows the real reason
    const deadline = Date.now() + 20000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        await this.dial();
        return;
      } catch (e) {
        if (Date.now() > deadline) throw e;
      }
    }
  }

  private dial(): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = socketPath();
      const sock = net.createConnection(p);
      const fail = (e: Error) => {
        sock.destroy();
        reject(
          new ToolError(
            "overlay_unavailable",
            `The overlay app is not running and could not be started, so there is no visible indicator that an agent is controlling this machine. Input injection is refused. Ask the user to launch agent-overlay. Socket: ${p}. Cause: ${e.message}`
          )
        );
      };
      sock.once("error", fail);
      sock.once("connect", () => {
        sock.removeListener("error", fail);
        sock.setNoDelay(true);
        sock.on("data", (d) => {
          this.buf = feed(this.buf, d.toString("utf8"), (m) => this.onMsg(m as OverlayMsg));
        });
        const drop = () => {
          this.sock = null;
          this.onInterrupt?.();
          // Reject anything waiting on a decision; a dead overlay is a denial.
          for (const [, res] of this.pending) res("deny");
          this.pending.clear();
          for (const [, res] of this.pendingShots) res(new Error("the overlay disconnected mid-capture"));
          this.pendingShots.clear();
        };
        sock.on("close", drop);
        sock.on("error", drop);
        this.sock = sock;
        this.refusal = null;
        this.handshook = false;
        this.send({ t: "hello", agent: loadConfig().agentName, pid: process.pid });

        // Connecting is not the same as being served: the overlay may refuse
        // and hang up. Wait for its answer, but do not hang forever on an
        // older overlay that sends neither - treat silence as acceptance,
        // which is exactly how it behaved before this handshake existed.
        const settle = () => {
          clearInterval(poll);
          clearTimeout(grace);
          if (this.refusal) {
            const r = this.refusal;
            const help =
              r.reason === "stopped"
                ? 'The user pressed Stop in the overlay. Ask them to choose "Allow a new session" from the agent-overlay tray icon, then retry. Do not retry until they confirm.'
                : "Another agent session already holds the overlay, and it serves one at a time. Ask the user which session should be driving, or stop the other one.";
            reject(new ToolError(r.reason === "stopped" ? "session_stopped" : "overlay_busy", `${r.detail ?? ""} ${help}`.trim()));
            return;
          }
          // Hung up on without a word. Older overlays refuse this way, and
          // treating silence as acceptance is what made a second session
          // degrade quietly instead of reporting the problem.
          if (!this.handshook && !this.sock) {
            reject(
              new ToolError(
                "overlay_unavailable",
                "The overlay closed the connection immediately without saying why. It is most likely already serving another agent session, or is running an older build. Ask the user to check the agent-overlay tray icon."
              )
            );
            return;
          }
          resolve();
        };
        const poll = setInterval(() => {
          if (this.refusal || this.handshook || !this.sock) settle();
        }, 20);
        const grace = setTimeout(settle, 500);
      });
    });
  }

  private onMsg(m: OverlayMsg): void {
    switch (m.t) {
      case "decision": {
        const res = this.pending.get(m.id);
        if (res) {
          this.pending.delete(m.id);
          res(m.decision);
        }
        break;
      }
      case "stop":
        this.onInterrupt?.();
        this.stopped = true;
        this.paused = "stopped";
        this.sock?.destroy();
        this.sock = null;
        break;
      case "pause":
        this.paused = m.reason;
        this.onInterrupt?.();
        break;
      case "resume":
        this.paused = null;
        break;
      case "accepted":
        // A fresh session the user can see start; whatever stopped the last
        // one no longer applies.
        this.stopped = false;
        this.paused = null;
        this.refusal = null;
        this.handshook = true;
        break;
      case "refused":
        this.refusal = { reason: m.reason, detail: m.detail };
        break;
      case "capture_result": {
        const res = this.pendingShots.get(m.id);
        if (!res) break;
        this.pendingShots.delete(m.id);
        if (!m.ok || !m.data) {
          res(new Error(m.error || "the overlay could not capture the screen"));
          break;
        }
        res({
          buf: Buffer.from(m.data, "base64"),
          imageWidth: m.imageWidth ?? 0,
          imageHeight: m.imageHeight ?? 0,
          nativeWidth: m.nativeWidth ?? 0,
          nativeHeight: m.nativeHeight ?? 0,
        });
        break;
      }
    }
  }

  /**
   * Ask the overlay to grab a screen in-process. Rejects rather than throwing
   * a ToolError: the caller falls back to the platform helper, so a failure
   * here is a performance regression, not a user-visible error.
   */
  captureScreen(opts: {
    x: number;
    y: number;
    maxWidth: number | null;
    includeOverlay: boolean;
    timeoutMs?: number;
  }): Promise<OverlayShot> {
    if (!this.connected) return Promise.reject(new Error("overlay not connected"));
    const id = randomUUID();
    return new Promise<OverlayShot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingShots.delete(id);
        reject(new Error("the overlay did not answer the capture in time"));
      }, opts.timeoutMs ?? 8000);
      this.pendingShots.set(id, (r) => {
        clearTimeout(timer);
        r instanceof Error ? reject(r) : resolve(r);
      });
      this.send({
        t: "capture",
        id,
        x: opts.x,
        y: opts.y,
        maxWidth: opts.maxWidth,
        includeOverlay: opts.includeOverlay,
      });
    });
  }

  send(m: ServerMsg): void {
    if (this.connected) this.sock!.write(frame(m));
  }

  /** Block until the user answers the overlay modal. */
  ask(tool: string, args: unknown, summary: string): Promise<Decision> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ t: "permission", id, tool, args, summary, ts: Date.now() });
    });
  }

  /** Throw if the session is paused by user takeover or a locked screen. */
  assertRunning(): void {
    if (this.paused) {
      throw new ToolError(
        "session_paused",
        `The session is paused (${this.paused}). The user took over the keyboard/mouse or the screen locked. Wait and ask the user to press Resume in the overlay before retrying.`
      );
    }
  }
}

/**
 * Start the overlay app. When this server runs under ELECTRON_RUN_AS_NODE the
 * app binary is process.execPath, so no separate Node or Electron install is
 * needed; in a plain-node checkout fall back to the electron dev dependency.
 */
function launchOverlay(): boolean {
  // Escape hatch for verifying the fail-closed path, and for users who want the
  // overlay started only by hand.
  if (process.env.AGENT_OVERLAY_NO_LAUNCH === "1") return false;
  const appDir = path.resolve(__dirname, "..", "..");
  let exe = process.env.ELECTRON_RUN_AS_NODE ? process.execPath : "";
  if (!exe) {
    try {
      const electron = require("electron");
      if (typeof electron === "string") exe = electron;
    } catch {
      return false;
    }
  }
  if (!exe) return false;
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // the child must be the GUI app, not node
    const child = spawn(exe, [appDir], { detached: true, stdio: "ignore", env, windowsHide: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export const overlay = new OverlayLink();
