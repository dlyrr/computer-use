import { ps, asArray, run } from "./platform";
import { ToolError } from "./ipc";

export interface WindowInfo {
  id: string;
  pid: number;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  focused: boolean;
  minimized: boolean;
}

export async function listWindows(): Promise<WindowInfo[]> {
  if (process.platform === "win32") {
    return asArray<any>(await ps("windows")).map((w) => ({
      id: String(w.id),
      pid: w.pid | 0,
      title: String(w.title ?? ""),
      bounds: { x: w.x | 0, y: w.y | 0, width: w.width | 0, height: w.height | 0 },
      focused: !!w.focused,
      minimized: !!w.minimized,
    }));
  }
  // Linux/X11: wmctrl -lpG gives id, desktop, pid, x, y, w, h, host, title.
  const { stdout, code, stderr } = await run("wmctrl", ["-lpG"], { timeout: 5000 });
  if (code !== 0) {
    throw new ToolError(
      "platform_error",
      `wmctrl failed (${stderr.trim() || `exit ${code}`}). Install wmctrl, and note that it requires X11; it does not work under a pure Wayland session.`
    );
  }
  const active = await activeIdLinux();
  const out: WindowInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+\S+\s?(.*)$/.exec(line);
    if (!m) continue;
    if (m[2] === "-1") continue; // sticky/panel windows
    out.push({
      id: m[1].toLowerCase(),
      pid: Number(m[3]),
      title: m[8] ?? "",
      bounds: { x: Number(m[4]), y: Number(m[5]), width: Number(m[6]), height: Number(m[7]) },
      focused: m[1].toLowerCase() === active,
      minimized: false, // wmctrl -lpG does not expose iconified state
    });
  }
  return out;
}

async function activeIdLinux(): Promise<string | null> {
  try {
    const { stdout, code } = await run("xdotool", ["getactivewindow"], { timeout: 3000 });
    if (code !== 0) return null;
    const n = Number(stdout.trim());
    return Number.isFinite(n) ? "0x" + n.toString(16).padStart(8, "0") : null;
  } catch {
    return null;
  }
}

export async function focusWindow(id: string): Promise<void> {
  const known = await listWindows();
  const target = known.find((w) => w.id.toLowerCase() === id.toLowerCase());
  if (!target) {
    throw new ToolError(
      "stale_window_id",
      `Window id ${id} no longer exists (it was closed, or the id came from an older list_windows call). Call list_windows again to get current ids.`,
      { availableIds: known.slice(0, 25).map((w) => ({ id: w.id, title: w.title })) }
    );
  }
  if (process.platform === "win32") {
    const res = await ps("focus", { Handle: Number(id) });
    const status = String(res?.status ?? "");
    if (status === "stale") {
      throw new ToolError("stale_window_id", `Window id ${id} disappeared between listing and focusing.`);
    }
    if (status !== "ok") {
      throw new ToolError(
        "focus_refused",
        `Windows refused to foreground "${target.title}". This happens when a modal dialog, UAC prompt or full-screen app holds the foreground lock. Ask the user to click the window, or retry after dismissing the dialog.`
      );
    }
    return;
  }
  const { code, stderr } = await run("wmctrl", ["-i", "-a", id], { timeout: 5000 });
  if (code !== 0) {
    throw new ToolError("focus_refused", `wmctrl could not activate ${id}: ${stderr.trim() || `exit ${code}`}`);
  }
}

/** Title of the focused window, used for plain-language activity summaries. */
export async function focusedTitle(): Promise<string | null> {
  try {
    const w = (await listWindows()).find((x) => x.focused);
    return w?.title || null;
  } catch {
    return null;
  }
}
