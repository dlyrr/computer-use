/**
 * First-run setup, done by the app itself so there is nothing to configure by
 * hand: write a default config, and register the MCP server with the clients
 * that are actually installed.
 *
 * Everything here is idempotent - it runs on every launch and only reports
 * what it changed.
 */

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { stateDir } from "../shared/protocol";

export interface SetupReport {
  configPath: string;
  configCreated: boolean;
  claudeDesktop: "registered" | "already" | "not-installed" | string;
  claudeCode: "registered" | "already" | "not-installed" | string;
}

/** The compiled MCP server entry point, next to this file's dist tree. */
export function serverEntry(): string {
  return path.join(__dirname, "..", "server", "index.js");
}

/**
 * How a client should launch the server. Electron run with
 * ELECTRON_RUN_AS_NODE=1 is just Node, so the app needs no separate Node
 * install and the user has one binary to point at.
 */
export function launchSpec(): { command: string; args: string[]; env: Record<string, string> } {
  return {
    command: process.execPath,
    args: [serverEntry()],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

// ------------------------------------------------------------------- config

const DEFAULT_CONFIG = {
  agentName: "Claude",
  roots: [path.join(os.homedir(), "Desktop"), path.join(os.homedir(), "Documents")],
  modes: {
    click: "allow",
    move: "allow",
    drag: "allow",
    scroll: "allow",
    key: "allow",
    focus_window: "allow",
    type_text: "prompt",
    run_command: "prompt",
    write_file: "prompt",
  },
};

function ensureConfig(): { configPath: string; created: boolean } {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  if (fs.existsSync(file)) return { configPath: file, created: false };
  fs.writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  return { configPath: file, created: true };
}

// ----------------------------------------------------------- Claude Desktop

/** Where Claude Desktop keeps its MCP config on this platform. */
function claudeDesktopConfig(): string | null {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData ? path.join(appData, "Claude", "claude_desktop_config.json") : null;
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function registerClaudeDesktop(): SetupReport["claudeDesktop"] {
  const file = claudeDesktopConfig();
  if (!file) return "not-installed";
  // Only touch the file if Claude Desktop is actually installed: its config
  // directory exists even before the first launch writes the file.
  if (!fs.existsSync(path.dirname(file))) return "not-installed";

  let cfg: any = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e: any) {
      return `could not parse ${file}: ${e.message}`;
    }
  }
  cfg.mcpServers = cfg.mcpServers ?? {};

  const spec = launchSpec();
  const wanted = { command: spec.command, args: spec.args, env: spec.env };
  const existing = cfg.mcpServers["agent-overlay"];
  if (existing && JSON.stringify(existing) === JSON.stringify(wanted)) return "already";

  cfg.mcpServers["agent-overlay"] = wanted;
  try {
    // Keep a copy of whatever was there before we edited someone else's file.
    if (fs.existsSync(file)) fs.copyFileSync(file, file + ".agent-overlay.bak");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  } catch (e: any) {
    return `could not write ${file}: ${e.message}`;
  }
  return "registered";
}

// -------------------------------------------------------------- Claude Code

function exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, windowsHide: true, shell: process.platform === "win32" }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

async function registerClaudeCode(): Promise<SetupReport["claudeCode"]> {
  const list = await exec("claude", ["mcp", "list"]);
  if (list.code !== 0 && /not recognized|not found|ENOENT/i.test(list.stderr + list.stdout)) {
    return "not-installed";
  }
  const spec = launchSpec();
  const line = list.stdout.split(/\r?\n/).find((l) => /^agent-overlay\b/.test(l));
  if (line) {
    // Registered, but maybe to an old location (a dev checkout, a previous
    // install). Re-point it rather than trusting the name.
    if (line.includes(spec.command)) return "already";
    await exec("claude", ["mcp", "remove", "-s", "user", "agent-overlay"]);
  }
  // Order matters: -e is variadic, so it has to come after the server name or
  // it swallows it as another environment variable.
  const add = await exec("claude", [
    "mcp",
    "add",
    "--scope",
    "user",
    "agent-overlay",
    "-e",
    "ELECTRON_RUN_AS_NODE=1",
    "--",
    spec.command,
    ...spec.args,
  ]);
  if (add.code !== 0) return `claude mcp add failed: ${(add.stderr || add.stdout).trim().slice(0, 200)}`;
  return "registered";
}

// ---------------------------------------------------------------------- run

export async function runSetup(): Promise<SetupReport> {
  const { configPath, created } = ensureConfig();
  return {
    configPath,
    configCreated: created,
    claudeDesktop: registerClaudeDesktop(),
    claudeCode: await registerClaudeCode(),
  };
}

export function summarize(r: SetupReport): string {
  const line = (label: string, v: string) =>
    `${label}: ${v === "already" ? "already set up" : v === "not-installed" ? "not installed" : v}`;
  return [
    r.configCreated ? `Created default config at ${r.configPath}` : `Config: ${r.configPath}`,
    line("Claude Desktop", r.claudeDesktop),
    line("Claude Code", r.claudeCode),
  ].join("\n");
}
