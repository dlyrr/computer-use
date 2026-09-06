import * as fs from "fs/promises";
import * as path from "path";
import { loadConfig } from "./config";
import { ToolError } from "./ipc";

/**
 * Resolve a user-supplied path and prove it lives under an allowlisted root.
 * Symlinks are resolved first so a link inside a root cannot escape it.
 */
export async function resolveInRoots(p: string, mustExist: boolean): Promise<string> {
  const roots = loadConfig().roots;
  if (!roots.length) {
    throw new ToolError("no_roots", "No filesystem roots are configured, so all file access is denied. Add `roots` to config.json.");
  }
  const abs = path.resolve(p);
  let real = abs;
  try {
    real = await fs.realpath(abs);
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
    if (mustExist) {
      throw new ToolError("not_found", `No such file or directory: ${abs}`);
    }
    // For a file being created, the parent directory must already be inside a root.
    real = path.join(await realpathOrSelf(path.dirname(abs)), path.basename(abs));
  }
  for (const root of roots) {
    const r = await realpathOrSelf(root);
    if (real === r || real.startsWith(r + path.sep)) return real;
  }
  throw new ToolError(
    "outside_allowlist",
    `Path ${abs} is outside every allowlisted root. Allowed roots: ${roots.join(", ")}. Edit config.json to add a root; the agent cannot widen its own access.`
  );
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

const MAX_READ = 2 * 1024 * 1024;

export async function readFile(p: string): Promise<string> {
  const abs = await resolveInRoots(p, true);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new ToolError("is_directory", `${abs} is a directory; use list_dir.`);
  if (st.size > MAX_READ) {
    throw new ToolError("too_large", `${abs} is ${st.size} bytes, over the ${MAX_READ} byte read limit.`);
  }
  return fs.readFile(abs, "utf8");
}

export async function writeFile(p: string, content: string): Promise<{ path: string; bytes: number }> {
  const abs = await resolveInRoots(p, false);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return { path: abs, bytes: Buffer.byteLength(content, "utf8") };
}

export interface DirEntry {
  name: string;
  type: "file" | "dir" | "other";
  size: number | null;
}

export async function listDir(p: string): Promise<{ path: string; entries: DirEntry[] }> {
  const abs = await resolveInRoots(p, true);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of dirents) {
    let size: number | null = null;
    if (d.isFile()) {
      try {
        size = (await fs.stat(path.join(abs, d.name))).size;
      } catch {
        size = null;
      }
    }
    entries.push({ name: d.name, type: d.isDirectory() ? "dir" : d.isFile() ? "file" : "other", size });
  }
  return { path: abs, entries };
}
