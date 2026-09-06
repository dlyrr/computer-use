import { screen as nutScreen } from "@nut-tree-fork/nut-js";
import { ps, asArray, run } from "./platform";
import { ToolError } from "./ipc";

/**
 * A display in *screen coordinate space* - the same space nut-js clicks in and
 * the same space the OS reports window bounds in. On Windows with a non
 * DPI-aware process this is logical (scaled) pixels, which is exactly what the
 * input backend uses, so no DPI maths leaks out to callers.
 */
export interface Display {
  /** Index into screenshot-desktop's display list. */
  index: number;
  name: string;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

let cache: { at: number; list: Display[] } | null = null;

/** Displays can be plugged, unplugged or rescaled mid-session, so cache briefly. */
export function invalidateDisplays(): void {
  cache = null;
}

/**
 * Probing costs a ~400ms helper spawn, and it sat in front of every screenshot
 * that fell outside a 2s window. Monitors are rarely replugged mid-session, and
 * the paths that actually care - a failed capture, an explicit list_displays -
 * call invalidateDisplays() themselves, so a long TTL costs nothing.
 */
const DISPLAY_CACHE_MS = 30000;

export async function displays(): Promise<Display[]> {
  if (cache && Date.now() - cache.at < DISPLAY_CACHE_MS) return cache.list;
  const list = await probe();
  if (!list.length) {
    throw new ToolError(
      "no_display",
      "No displays were reported. The session may be running headless, or the screen is locked / all monitors are asleep."
    );
  }
  cache = { at: Date.now(), list };
  return list;
}

async function probe(): Promise<Display[]> {
  if (process.platform === "win32") {
    const raw = asArray<any>(await ps("displays"));
    return raw.map((d, i) => ({
      index: typeof d.index === "number" ? d.index : i,
      name: String(d.name ?? `display-${i}`),
      primary: !!d.primary,
      x: d.x | 0,
      y: d.y | 0,
      width: d.width | 0,
      height: d.height | 0,
    }));
  }
  // Linux: xrandr is present on every X11 desktop we support.
  try {
    const { stdout, code } = await run("xrandr", ["--listmonitors"], { timeout: 5000 });
    if (code === 0) {
      const out: Display[] = [];
      // " 0: +*eDP-1 1920/344x1080/193+0+0  eDP-1"
      const re = /^\s*(\d+):\s+(\+?\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(\d+)\+(\d+)/;
      for (const line of stdout.split("\n")) {
        const m = re.exec(line);
        if (!m) continue;
        out.push({
          index: Number(m[1]),
          name: m[3],
          primary: m[2].includes("*"),
          width: Number(m[4]),
          height: Number(m[5]),
          x: Number(m[6]),
          y: Number(m[7]),
        });
      }
      if (out.length) return out;
    }
  } catch {
    /* fall through to the single-screen fallback below */
  }
  // Wayland or no xrandr: the input backend still knows the primary screen size.
  const width = await nutScreen.width();
  const height = await nutScreen.height();
  return [{ index: 0, name: "primary", primary: true, x: 0, y: 0, width, height }];
}

export async function displayAt(index?: number): Promise<Display> {
  const list = await displays();
  if (index === undefined) return list.find((d) => d.primary) ?? list[0];
  const found = list.find((d) => d.index === index);
  if (!found) {
    throw new ToolError(
      "unknown_display",
      `No display with index ${index}. Available: ${list.map((d) => `${d.index} (${d.width}x${d.height})`).join(", ")}.`
    );
  }
  return found;
}
