/**
 * Wire protocol between the MCP server (process A) and the overlay (process B).
 *
 * Transport: newline-delimited JSON over a named pipe (Windows) or a unix
 * domain socket (Linux). The overlay is the listener; the server is the client.
 * If the server cannot connect, every input-injecting tool must fail closed.
 */

import * as os from "os";
import * as path from "path";

/** Absolute address of the control socket for the current user. */
export function socketPath(): string {
  if (process.platform === "win32") {
    // Named pipes are per-machine; scope by username so two accounts do not collide.
    return String.raw`\\.\pipe\agent-overlay-` + (process.env.USERNAME || "user");
  }
  const runtime = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(runtime, `agent-overlay-${process.getuid?.() ?? 0}.sock`);
}

/** Directory holding config.json and audit.log. */
export function stateDir(): string {
  return process.env.AGENT_OVERLAY_HOME || path.join(os.homedir(), ".agent-overlay");
}

export type PermissionMode = "allow" | "prompt" | "deny";
export type Decision = "allow" | "allow_session" | "deny";

/** Messages sent server -> overlay. */
export type ServerMsg =
  | { t: "hello"; agent: string; pid: number }
  /** A tool call started. `summary` is plain language for the status pill. */
  | { t: "activity"; id: string; tool: string; args: unknown; summary: string; ts: number }
  /** A tool call finished. */
  | { t: "result"; id: string; ok: boolean; summary: string; ts: number }
  /** Blocking permission request; overlay must answer with a `decision`. */
  | { t: "permission"; id: string; tool: string; args: unknown; summary: string; ts: number }
  /**
   * Ask the overlay to grab a screen. The overlay is an Electron app that is
   * already running and already has the display server open, so it can capture
   * in-process - far cheaper than the server spawning a helper per screenshot.
   * The display is identified by a point inside it rather than an id, because
   * the two processes enumerate monitors through different APIs.
   */
  | { t: "capture"; id: string; x: number; y: number; maxWidth: number | null; includeOverlay: boolean };

/** Messages sent overlay -> server. */
export type OverlayMsg =
  | { t: "decision"; id: string; decision: Decision }
  /** User pressed Stop. Server must abort and disconnect. */
  | { t: "stop" }
  /** User pressed Escape, or the screen locked. Injecting tools fail until resume. */
  | { t: "pause"; reason: string }
  | { t: "resume" }
  /**
   * Sent immediately on a connection the overlay is willing to serve. The
   * server waits for this so it can tell "attached" apart from "attached and
   * then hung up on", which used to look identical.
   */
  | { t: "accepted" }
  /**
   * Sent instead of `accepted` when the overlay will not serve this
   * connection, immediately before it closes. `stopped` means the user pressed
   * Stop and has not re-armed; `busy` means another agent session already
   * holds the overlay.
   */
  | { t: "refused"; reason: "stopped" | "busy"; detail?: string }
  /** Answer to a `capture`. `data` is base64; dimensions describe the image. */
  | {
      t: "capture_result";
      id: string;
      ok: boolean;
      data?: string;
      mime?: string;
      /** Size of the returned image, which may be pre-scaled. */
      imageWidth?: number;
      imageHeight?: number;
      /** True pixel size of the display, needed for coordinate mapping. */
      nativeWidth?: number;
      nativeHeight?: number;
      error?: string;
    };

/** Split a stream chunk into complete NDJSON messages. Returns leftover tail. */
export function feed(buffer: string, chunk: string, onMsg: (m: any) => void): string {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      onMsg(JSON.parse(line));
    } catch {
      // A malformed frame is not fatal to the connection; drop it.
    }
  }
  return buffer;
}

export function frame(msg: ServerMsg | OverlayMsg): string {
  return JSON.stringify(msg) + "\n";
}

/** Tools that inject input, write files, or run commands. All are gated. */
export const GATED_TOOLS = [
  "click",
  "move",
  "drag",
  "mouse_down",
  "mouse_up",
  "key_down",
  "key_up",
  "scroll",
  "type_text",
  "key",
  "focus_window",
  "run_command",
  "write_file",
] as const;

export type GatedTool = (typeof GATED_TOOLS)[number];
