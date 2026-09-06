import { mouse, keyboard, Button, Key, Point, screen as nutScreen, straightTo } from "@nut-tree-fork/nut-js";
import { toScreen } from "./capture";
import { displays } from "./displays";
import { ToolError } from "./ipc";

// Agents type faster than any human; no artificial delay between keys.
keyboard.config.autoDelayMs = 0;
mouse.config.mouseSpeed = 2000;

/**
 * The input backend and the OS window/monitor APIs do not always agree about
 * whether coordinates are logical or physical pixels. Rather than assume,
 * calibrate once: compare the backend's idea of the primary screen width with
 * the OS's. On a matching setup this is exactly 1.
 * Override with AGENT_OVERLAY_COORD_SCALE if a exotic setup needs tuning.
 */
let coordScale: number | null = null;

async function calibrate(): Promise<number> {
  if (coordScale !== null) return coordScale;
  const override = Number(process.env.AGENT_OVERLAY_COORD_SCALE);
  if (Number.isFinite(override) && override > 0) return (coordScale = override);
  try {
    const nutW = await nutScreen.width();
    const primary = (await displays()).find((d) => d.primary);
    coordScale = primary && primary.width > 0 ? nutW / primary.width : 1;
    // A wildly different ratio means one of the two is lying; trust 1:1.
    if (!Number.isFinite(coordScale) || coordScale < 0.25 || coordScale > 4) coordScale = 1;
  } catch {
    coordScale = 1;
  }
  return coordScale;
}

/** Screen coordinates -> the coordinate space the input backend expects. */
async function toBackend(p: { x: number; y: number }): Promise<Point> {
  const c = await calibrate();
  return new Point(Math.round(p.x * c), Math.round(p.y * c));
}

const BUTTONS: Record<string, Button> = {
  left: Button.LEFT,
  right: Button.RIGHT,
  middle: Button.MIDDLE,
};

/**
 * Button.LEFT is 0, so a truthiness check rejects the most common button of
 * all. Look the name up by presence, not by the value being truthy.
 */
export function toButton(button: string): Button {
  if (!Object.prototype.hasOwnProperty.call(BUTTONS, button)) {
    throw new ToolError("bad_button", `Unknown button "${button}". Use left, right or middle.`);
  }
  return BUTTONS[button];
}

/** name -> nut-js Key, built once from the enum plus human aliases. */
const KEYS: Record<string, Key> = (() => {
  const map: Record<string, Key> = {};
  for (const [name, value] of Object.entries(Key)) {
    if (typeof value === "number") map[name.toLowerCase()] = value as Key;
  }
  for (let d = 0; d <= 9; d++) map[String(d)] = map[`num${d}`];
  Object.assign(map, {
    ctrl: Key.LeftControl,
    control: Key.LeftControl,
    alt: Key.LeftAlt,
    option: Key.LeftAlt,
    shift: Key.LeftShift,
    win: Key.LeftSuper,
    super: Key.LeftSuper,
    meta: Key.LeftSuper,
    cmd: Key.LeftSuper,
    esc: Key.Escape,
    return: Key.Enter,
    del: Key.Delete,
    ins: Key.Insert,
    pgup: Key.PageUp,
    pgdn: Key.PageDown,
    pagedown: Key.PageDown,
    plus: Key.Add,
    minus: Key.Minus,
  });
  return map;
})();

export function parseCombo(combo: string): Key[] {
  const parts = combo
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) throw new ToolError("bad_key", `Empty key combo. Example: "ctrl+shift+esc".`);
  return parts.map((p) => {
    const k = KEYS[p];
    if (k === undefined) {
      throw new ToolError(
        "bad_key",
        `Unknown key "${p}" in combo "${combo}". Use names like ctrl, alt, shift, win, enter, tab, esc, f5, up, a, 7.`
      );
    }
    return k;
  });
}

/**
 * A pointer that teleports is hard to follow: you cannot tell where the agent
 * is about to act, only where it already did. So it travels - and it travels
 * the way a hand does.
 *
 * Three things make it read as human rather than as a tween:
 *
 * - Speed scales with distance. A hand flicks across the screen and creeps
 *   over the last few pixels, so duration grows with the SQUARE ROOT of the
 *   distance: a move four times as long takes only twice as long, which means
 *   the further it goes the faster it moves. (Fitts's law, roughly.)
 * - A minimum-jerk velocity profile - slow, fast, slow - which is the shape
 *   real reaching movements follow. Constant velocity is the giveaway of a
 *   machine.
 * - A slight arc and a little noise, because nobody moves in a straight line.
 *
 * Set AGENT_OVERLAY_MOUSE_SPEED to 0 to go back to teleporting.
 */
const SMOOTH = (() => {
  const v = Number(process.env.AGENT_OVERLAY_MOUSE_SPEED);
  return !Number.isFinite(v) || v !== 0;
})();

/** Below this, animating is pure latency nobody can perceive. */
const SMOOTH_MIN_DISTANCE = 12;
/** Roughly one screen tick; finer steps just burn CPU. */
const STEP_MS = 8;

/** Minimum-jerk position profile: 0 at t=0, 1 at t=1, zero velocity at both ends. */
function easeMinJerk(t: number): number {
  return t * t * t * (10 - 15 * t + 6 * t * t);
}

function travelMs(distance: number): number {
  // sqrt growth: 100px ~ 120ms, 800px ~ 260ms, 2000px ~ 390ms. Longer moves
  // take more time in total but far less time per pixel.
  return Math.min(420, Math.max(70, 40 + Math.sqrt(distance) * 8));
}

export async function move(sx: number, sy: number): Promise<{ x: number; y: number }> {
  const p = toScreen(sx, sy);
  const target = await toBackend(p);

  if (SMOOTH) {
    try {
      const from = await mouse.getPosition();
      const dx = target.x - from.x;
      const dy = target.y - from.y;
      const dist = Math.hypot(dx, dy);
      if (dist >= SMOOTH_MIN_DISTANCE) {
        const duration = travelMs(dist);
        const steps = Math.max(2, Math.round(duration / STEP_MS));

        // Bow the path out perpendicular to the direction of travel. Scaled to
        // sqrt(distance) so long sweeps curve gently instead of wildly, and
        // signed randomly so successive moves do not all bend the same way.
        const arc = (Math.random() < 0.5 ? -1 : 1) * Math.min(24, Math.sqrt(dist) * 0.6);
        const nx = dist > 0 ? -dy / dist : 0;
        const ny = dist > 0 ? dx / dist : 0;

        const started = Date.now();
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const e = easeMinJerk(t);
          // Peaks mid-flight and vanishes at both ends, so the path still
          // starts and finishes exactly where it should.
          const bow = Math.sin(Math.PI * t) * arc;
          const jitter = i < steps ? (Math.random() - 0.5) * 1.2 : 0;
          await mouse.setPosition(
            new Point(
              Math.round(from.x + dx * e + nx * bow + jitter),
              Math.round(from.y + dy * e + ny * bow + jitter)
            )
          );
          // Sleep against the clock rather than a fixed delay, so the whole
          // move still lands on time when setPosition runs slow.
          const due = started + (duration * i) / steps;
          const wait = due - Date.now();
          if (wait > 1) await new Promise((r) => setTimeout(r, wait));
        }
        // Land exactly on target - the jitter must never be the final word.
        await mouse.setPosition(target);
        return p;
      }
    } catch {
      // Fall through to the instant path rather than failing the whole call.
    }
  }
  await mouse.setPosition(target);
  return p;
}

export async function click(sx: number, sy: number, button: string, clicks: number): Promise<{ x: number; y: number }> {
  const b = toButton(button);
  const p = await move(sx, sy);
  for (let i = 0; i < clicks; i++) {
    await mouse.click(b);
  }
  return p;
}

/**
 * Buttons and keys currently held down. Holding state across separate tool
 * calls is what makes free-form dragging possible, but a button left down is
 * the worst thing this process can leave behind - especially with the user's
 * own input locked - so everything that ends or interrupts a session calls
 * releaseHeld(), and so does process exit.
 */
const heldButtons = new Set<Button>();
const heldKeys = new Set<Key>();

export async function releaseHeld(): Promise<void> {
  for (const b of [...heldButtons]) {
    try {
      await mouse.releaseButton(b);
    } catch {
      /* nothing useful to do; keep releasing the rest */
    }
    heldButtons.delete(b);
  }
  for (const k of [...heldKeys]) {
    try {
      await keyboard.releaseKey(k);
    } catch {
      /* as above */
    }
    heldKeys.delete(k);
  }
}

export function heldSummary(): { buttons: string[]; keys: number } {
  const names: Record<number, string> = { [Button.LEFT]: "left", [Button.RIGHT]: "right", [Button.MIDDLE]: "middle" };
  return { buttons: [...heldButtons].map((b) => names[b] ?? String(b)), keys: heldKeys.size };
}

// A held button must not survive the process, whatever happens to it.
for (const sig of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sig as NodeJS.Signals, () => {
    for (const b of heldButtons) {
      try {
        void mouse.releaseButton(b);
      } catch {
        /* best effort on the way out */
      }
    }
  });
}

export async function mouseDown(sx: number | undefined, sy: number | undefined, button: string): Promise<void> {
  const b = toButton(button);
  if (sx !== undefined && sy !== undefined) await move(sx, sy);
  await mouse.pressButton(b);
  heldButtons.add(b);
}

export async function mouseUp(sx: number | undefined, sy: number | undefined, button: string): Promise<void> {
  const b = toButton(button);
  if (sx !== undefined && sy !== undefined) await move(sx, sy);
  await mouse.releaseButton(b);
  heldButtons.delete(b);
}

export async function keyDown(combo: string): Promise<void> {
  for (const k of parseCombo(combo)) {
    await keyboard.pressKey(k);
    heldKeys.add(k);
  }
}

export async function keyUp(combo: string): Promise<void> {
  for (const k of [...parseCombo(combo)].reverse()) {
    await keyboard.releaseKey(k);
    heldKeys.delete(k);
  }
}

/**
 * Press, travel, release. `via` adds waypoints, which matters more than it
 * sounds: a lot of drop targets only light up if the pointer actually passes
 * over them, and canvas or drawing tools follow the whole path rather than the
 * endpoints. `holdMs` pauses over the destination before letting go, which is
 * what slow drop handlers and tree-view spring-loading need.
 */
export async function drag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  button: string,
  opts: { via?: { x: number; y: number }[]; holdMs?: number } = {}
): Promise<void> {
  const b = toButton(button);
  await move(from.x, from.y);
  await mouse.pressButton(b);
  heldButtons.add(b);
  try {
    // A short settle after pressing: apps that start a drag on mousedown need
    // to see the press before the pointer runs away from it.
    await new Promise((r) => setTimeout(r, 40));
    for (const p of opts.via ?? []) await move(p.x, p.y);
    await move(to.x, to.y);
    if (opts.holdMs) await new Promise((r) => setTimeout(r, Math.min(5000, opts.holdMs!)));
  } finally {
    await mouse.releaseButton(b);
    heldButtons.delete(b);
  }
}

export async function scroll(sx: number, sy: number, amount: number, axis: "vertical" | "horizontal"): Promise<void> {
  await move(sx, sy);
  const n = Math.abs(Math.round(amount));
  if (!n) return;
  if (axis === "vertical") {
    await (amount > 0 ? mouse.scrollDown(n) : mouse.scrollUp(n));
  } else {
    await (amount > 0 ? mouse.scrollRight(n) : mouse.scrollLeft(n));
  }
}

export async function typeText(text: string): Promise<void> {
  await keyboard.type(text);
}

export async function pressCombo(combo: string): Promise<void> {
  const keys = parseCombo(combo);
  await keyboard.pressKey(...keys);
  try {
    // Release in reverse so modifiers outlive the key they modify.
    await keyboard.releaseKey(...[...keys].reverse());
  } catch (e: any) {
    throw new ToolError("input_failed", `Pressed "${combo}" but releasing the keys failed: ${e?.message ?? e}`);
  }
}

export async function cursorPosition(): Promise<{ x: number; y: number }> {
  const p = await mouse.getPosition();
  const c = await calibrate();
  return { x: Math.round(p.x / c), y: Math.round(p.y / c) };
}
