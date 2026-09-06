import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { stateDir, PermissionMode, GATED_TOOLS } from "../shared/protocol";

export interface Config {
  /** Name shown in the overlay pill. */
  agentName: string;
  /** Absolute directory roots that read_file/write_file/list_dir may touch. */
  roots: string[];
  /** Per-tool permission mode. Missing tools default to "prompt". */
  modes: Record<string, PermissionMode>;
}

const DEFAULTS: Config = {
  agentName: "Claude",
  roots: [path.join(os.homedir(), "Desktop"), path.join(os.homedir(), "Documents")],
  modes: {
    click: "allow",
    move: "allow",
    drag: "allow",
    // Holding a button or a modifier is part of an ordinary drag, so it
    // inherits drag's default rather than introducing new prompts.
    mouse_down: "allow",
    mouse_up: "allow",
    key_down: "allow",
    key_up: "allow",
    scroll: "allow",
    type_text: "prompt",
    key: "allow",
    focus_window: "allow",
    run_command: "prompt",
    write_file: "prompt",
  },
};

// Re-read on every call: the Computer Use window edits this file while a
// session may be running, and a toggle there has to apply to the next tool call.
export function loadConfig(): Config {
  const file = path.join(stateDir(), "config.json");
  let user: Partial<Config> = {};
  try {
    user = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      // A broken config must not silently fall back to permissive defaults.
      throw new Error(`config at ${file} is unreadable: ${e.message}`);
    }
  }
  const cfg: Config = {
    agentName: user.agentName ?? DEFAULTS.agentName,
    roots: (user.roots ?? DEFAULTS.roots).map((r) => path.resolve(expandHome(r))),
    modes: { ...DEFAULTS.modes, ...(user.modes ?? {}) },
  };
  for (const t of GATED_TOOLS) {
    const m = cfg.modes[t];
    if (m && m !== "allow" && m !== "prompt" && m !== "deny") {
      throw new Error(`config: modes.${t} must be allow|prompt|deny, got ${JSON.stringify(m)}`);
    }
  }
  return cfg;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Append one JSON line per tool call. Best effort; never throws into a tool. */
export function audit(entry: Record<string, unknown>): void {
  try {
    const dir = stateDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "audit.log"),
      JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry }) + "\n"
    );
  } catch {
    /* disk full or read-only home: losing the log must not break the session */
  }
}
