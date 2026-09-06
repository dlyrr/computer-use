import { execFile } from "child_process";
import * as path from "path";
import { ToolError } from "./ipc";

/** Repo root, resolved from dist/server/ at runtime. */
export const ROOT = path.resolve(__dirname, "..", "..");

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; maxBuffer?: number } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeout ?? 15000, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && (err as any).killed) {
          return reject(new ToolError("timeout", `${cmd} timed out after ${opts.timeout ?? 15000}ms`));
        }
        if (err && (err as any).code === "ENOENT") {
          return reject(new ToolError("missing_dependency", `Required program "${cmd}" is not installed or not on PATH.`));
        }
        resolve({ stdout, stderr, code: err ? ((err as any).code ?? 1) : 0 });
      }
    );
  });
}

/** Run the bundled PowerShell helper and parse its JSON. Windows only. */
export async function ps(
  action: "displays" | "windows" | "focus" | "capture",
  extra: Record<string, string | number> = {}
): Promise<any> {
  const script = path.join(ROOT, "scripts", "win32.ps1");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action];
  for (const [k, v] of Object.entries(extra)) args.push(`-${k}`, String(v));
  const { stdout, stderr, code } = await run("powershell.exe", args, { timeout: 20000 });
  if (code !== 0) {
    throw new ToolError("platform_error", `win32 helper (${action}) failed: ${stderr.trim() || `exit ${code}`}`);
  }
  const text = stdout.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ToolError("platform_error", `win32 helper (${action}) returned non-JSON: ${text.slice(0, 200)}`);
  }
  return parsed;
}

/** PowerShell collapses single-element arrays into bare objects. */
export function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
