#!/usr/bin/env node
/**
 * Process A: the MCP server. stdio transport, no UI of its own.
 *
 * Everything that injects input, writes a file or runs a command is gated:
 * the overlay (process B) must be running and must approve the call. If the
 * overlay is not reachable, those tools fail closed - we never drive the
 * machine without a visible indicator.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID, createHash } from "crypto";

import { overlay, ToolError } from "./ipc";
import { loadConfig, audit } from "./config";
import { capture, MAX_WIDTH } from "./capture";
import { displays, invalidateDisplays } from "./displays";
import * as input from "./input";
import { listWindows, focusWindow, focusedTitle } from "./windows";
import { readFile, writeFile, listDir, resolveInRoots } from "./files";
import { run } from "./platform";
import { GATED_TOOLS } from "../shared/protocol";

const GATED = new Set<string>(GATED_TOOLS);

// A drag can span several tool calls, so a button stays down between them. If
// the user hits Escape or Stop half way through one, that button must not stay
// down - especially while their own input is locked.
overlay.onInterrupt = () => void input.releaseHeld().catch(() => undefined);

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function ok(...content: Content[]) {
  return { content };
}

function err(e: unknown) {
  const te =
    e instanceof ToolError ? e : new ToolError("internal_error", e instanceof Error ? e.message : String(e));
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: te.code, message: te.message, detail: te.detail ?? null }, null, 2),
      },
    ],
  };
}

/**
 * Run one tool call: announce it to the overlay, ask permission if the config
 * says to, execute, log, and report the result back to the overlay.
 */
async function call<T>(
  tool: string,
  args: Record<string, unknown>,
  summary: string,
  fn: () => Promise<T>
): Promise<T> {
  const id = randomUUID();
  const started = Date.now();

  if (GATED.has(tool)) {
    // Fail closed: no overlay, no input.
    await overlay.ensure();
    overlay.assertRunning();

    const mode = loadConfig().modes[tool] ?? "prompt";
    if (mode === "deny") {
      audit({ id, tool, args, decision: "deny_by_config", ok: false });
      throw new ToolError(
        "permission_denied",
        `The tool "${tool}" is set to "deny" in the user's config. It cannot be used in this session. Ask the user to change modes.${tool} in config.json if they want it enabled.`
      );
    }
    if (mode === "prompt" && !overlay.sessionAllowed.has(tool)) {
      const decision = await overlay.ask(tool, args, summary);
      audit({ id, tool, args, decision });
      if (decision === "deny") {
        throw new ToolError(
          "permission_denied",
          `The user declined this ${tool} call in the overlay. Do not retry the same call; ask the user what they want instead.`
        );
      }
      if (decision === "allow_session") overlay.sessionAllowed.add(tool);
      // The user may have paused or stopped while the prompt was up.
      overlay.assertRunning();
    }
  }

  overlay.send({ t: "activity", id, tool, args, summary, ts: started });
  try {
    const result = await fn();
    overlay.send({ t: "result", id, ok: true, summary, ts: Date.now() });
    audit({ id, tool, args, ok: true, ms: Date.now() - started });
    return result;
  } catch (e: any) {
    const code = e instanceof ToolError ? e.code : "internal_error";
    overlay.send({ t: "result", id, ok: false, summary: `${summary} - failed: ${code}`, ts: Date.now() });
    audit({ id, tool, args, ok: false, error: code, message: String(e?.message ?? e), ms: Date.now() - started });
    throw e;
  }
}

/**
 * The SDK infers a zod schema type per tool; with this many tools that inference
 * blows past tsc's instantiation limit. The handlers are small and validated at
 * runtime by zod anyway, so erase the generics once here.
 * ponytail: revisit if the SDK's typings get cheaper.
 */
type Register = (
  name: string,
  cfg: { title: string; description: string; inputSchema: Record<string, unknown> },
  handler: (args: any) => Promise<unknown>
) => void;

const server = new McpServer(
  { name: "agent-overlay", version: "0.1.0" },
  {
    instructions:
      "Controls the user's physical desktop. All coordinates you pass are in the pixel space of the MOST RECENT screenshot you took, with (0,0) at its top-left corner; the server converts to physical screen coordinates and handles display scaling for you - never apply DPI maths yourself. Take a screenshot before your first click and after anything that changes the screen. A visible overlay shows the user everything you do and can stop you at any time.",
  }
);

const tool = server.registerTool.bind(server) as unknown as Register;

// ---------------------------------------------------------------- screenshot

tool(
  "screenshot",
  {
    title: "Screenshot",
    description:
      `Capture one display as a JPEG and return it, downscaled to at most ${MAX_WIDTH} pixels wide.\n` +
      "Returns: the image, plus a JSON block with `shot_width`/`shot_height` (pixels of the returned image), " +
      "`scale` (screenshot pixels per screen unit; less than 1 means the image is smaller than the display), " +
      "and `origin` (the screen coordinate of the image's top-left pixel).\n" +
      "All coordinates you later pass to click/move/drag/scroll are in THIS image's pixel space with (0,0) top-left. " +
      "You never need to undo the downscale or account for display scaling - the server does it.\n" +
      "`region` is expressed in the pixel space of a FULL screenshot of the same display (that space is fixed and " +
      "independent of any earlier call), and cropping then re-downscales, so a region gives you more detail. " +
      "After a region shot, coordinates are relative to the cropped image.",
    inputSchema: {
      display: z
        .number()
        .int()
        .optional()
        .describe("Display index from list_displays. Omit for the primary display."),
      region: z
        .object({
          x: z.number().int().describe("Left edge, in full-screenshot pixels."),
          y: z.number().int().describe("Top edge, in full-screenshot pixels."),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .optional()
        .describe("Optional crop, in the pixel space of a full screenshot of this display."),
      include_overlay: z
        .boolean()
        .default(false)
        .describe(
          "The overlay indicator is excluded from screenshots by default, so you see the user's screen rather " +
            "than your own status pill sitting on top of it. Set true only when you need to read the overlay " +
            "itself - for example to see a permission prompt you are waiting on."
        ),
    },
  },
  async ({ display, region, include_overlay }) => {
    try {
      const label = region ? "taking a screenshot of a region" : "taking a screenshot";
      return await call("screenshot", { display, region }, label, async () => {
        // A screenshot is how the agent sees the user's screen: the indicator
        // must be up for that too, even though it needs no per-call approval.
        await overlay.ensure();
        const shot = await capture(display, region, { includeOverlay: include_overlay });
        return ok(
          { type: "image", data: shot.imageBase64, mimeType: shot.mimeType },
          {
            type: "text",
            text: JSON.stringify(
              {
                display: shot.map.display.index,
                shot_width: shot.map.shotWidth,
                shot_height: shot.map.shotHeight,
                scale: Number(shot.scale.toFixed(4)),
                origin: { x: Math.round(shot.map.originX), y: Math.round(shot.map.originY) },
                note: "Pass click/move/drag/scroll coordinates in this image's pixel space.",
              },
              null,
              2
            ),
          }
        );
      });
    } catch (e) {
      return err(e);
    }
  }
);

tool(
  "list_displays",
  {
    title: "List displays",
    description:
      "List attached displays. Returns an array of {index, name, primary, x, y, width, height} in screen coordinate units. " +
      "Use `index` with screenshot(). Re-run this if a screenshot fails; monitors can be plugged or unplugged mid-session.",
    inputSchema: {},
  },
  async () => {
    try {
      invalidateDisplays();
      const list = await displays();
      return ok({ type: "text", text: JSON.stringify(list, null, 2) });
    } catch (e) {
      return err(e);
    }
  }
);

// --------------------------------------------------------------------- mouse

tool(
  "click",
  {
    title: "Click",
    description:
      "Move the pointer to a point in the most recent screenshot and click. " +
      "x and y are in screenshot pixels, (0,0) top-left. Returns the screen coordinate actually clicked. " +
      "Requires a prior screenshot; fails with `no_screenshot` otherwise.",
    inputSchema: {
      x: z.number().describe("Horizontal position in screenshot pixels."),
      y: z.number().describe("Vertical position in screenshot pixels."),
      button: z.enum(["left", "right", "middle"]).default("left"),
      clicks: z.number().int().min(1).max(3).default(1).describe("1 = single, 2 = double, 3 = triple."),
    },
  },
  async ({ x, y, button, clicks }) => {
    try {
      const where = await focusedTitle();
      const verb = clicks === 2 ? "double-clicking" : "clicking";
      const summary = `${verb} at ${Math.round(x)}, ${Math.round(y)}${where ? ` in ${where}` : ""}`;
      const p = await call("click", { x, y, button, clicks }, summary, () => input.click(x, y, button, clicks));
      return ok({ type: "text", text: JSON.stringify({ clicked_screen_point: p }) });
    } catch (e) {
      return err(e);
    }
  }
);

tool(
  "move",
  {
    title: "Move pointer",
    description:
      "Move the pointer without clicking. x and y are in screenshot pixels, (0,0) top-left. " +
      "Useful for revealing hover states before a screenshot.",
    inputSchema: { x: z.number(), y: z.number() },
  },
  async ({ x, y }) => {
    try {
      const summary = `moving the pointer to ${Math.round(x)}, ${Math.round(y)}`;
      const p = await call("move", { x, y }, summary, () => input.move(x, y));
      return ok({ type: "text", text: JSON.stringify({ screen_point: p }) });
    } catch (e) {
      return err(e);
    }
  }
);

tool(
  "drag",
  {
    title: "Drag",
    description:
      "Press the button at `from`, travel to `to`, release. Points are in screenshot pixels, (0,0) top-left. " +
      "Use for sliders, selections and drag-and-drop. " +
      "`via` adds waypoints the pointer must pass through. Many drop targets only activate if the pointer " +
      "actually crosses them, and drawing tools follow the whole path, so a straight line from A to B often " +
      "does nothing useful. " +
      "`hold_ms` waits over the destination before releasing - needed by slow drop handlers and by tree views " +
      "that spring open when you hover. " +
      "For anything this cannot express, use mouse_down / move / mouse_up separately.",
    inputSchema: {
      from: z.object({ x: z.number(), y: z.number() }),
      to: z.object({ x: z.number(), y: z.number() }),
      button: z.enum(["left", "right", "middle"]).default("left"),
      via: z
        .array(z.object({ x: z.number(), y: z.number() }))
        .max(32)
        .optional()
        .describe("Waypoints to pass through, in order, between `from` and `to`."),
      hold_ms: z.number().int().min(0).max(5000).optional().describe("Pause over the destination before releasing."),
    },
  },
  async ({ from, to, button, via, hold_ms }) => {
    try {
      const summary = `dragging from ${Math.round(from.x)}, ${Math.round(from.y)} to ${Math.round(to.x)}, ${Math.round(to.y)}`;
      await call("drag", { from, to, button, via, hold_ms }, summary, () =>
        input.drag(from, to, button, { via, holdMs: hold_ms })
      );
      return ok({ type: "text", text: JSON.stringify({ ok: true }) });
    } catch (e) {
      return err(e);
    }
  }
);

tool(
  "mouse_down",
  {
    title: "Press and hold a mouse button",
    description:
      "Press a mouse button and LEAVE IT DOWN. Pair it with move (as many as you like) and then mouse_up to " +
      "build any gesture a single drag cannot express: multi-segment drags, drag-select across a canvas, " +
      "painting a stroke, nudging a slider and checking the value before letting go. " +
      "The button stays down across tool calls, so you can look at a screenshot mid-drag and decide where to go " +
      "next. ALWAYS finish with mouse_up. It is released for you if the user pauses or stops the session, or if " +
      "the overlay goes away - so a forgotten button cannot strand the mouse. " +
      "x and y are optional; omit them to press wherever the pointer already is.",
    inputSchema: {
      x: z.number().optional(),
      y: z.number().optional(),
      button: z.enum(["left", "right", "middle"]).default("left"),
    },
  },
  async ({ x, y, button }) => {
    try {
      const where = x !== undefined && y !== undefined ? ` at ${Math.round(x)}, ${Math.round(y)}` : "";
      await call("mouse_down", { x, y, button }, `holding the ${button} mouse button down${where}`, () =>
        input.mouseDown(x, y, button)
      );
      return ok({ type: "text", text: JSON.stringify({ held: input.heldSummary() }) });
    } catch (e) {
      return err(e);
    }
  }
);

tool(
  "mouse_up",
  {
    title: "Release a mouse button",
    description:
      "Release a mouse button that mouse_down is holding, optionally moving to a final point first. " +
      "x and y are optional; omit them to release where the pointer already is.",
    inputSchema: {
      x: z.number().optional(),
      y: z.number().optional(),
      button: z.enum(["left", "right", "middle"]).default("left"),
    },
  },
  async ({ x, y, button }) => {
    try {
      const where = x !== undefined && y !== undefined ? ` at ${Math.round(x)}, ${Math.round(y)}` : "";
      await call("mouse_up", { x, y, button }, `releasing the ${button} mouse button${where}`, () =>
        input.mouseUp(x, y, button)
      );
      return ok({ type: "text", text: JSON.stringify({ held: input.heldSummary() }) });
    } catch (e) {
      return err(e);
    }
  }
);

tool(
  "key_down",
  {
    title: "Hold a key down",
    description:
      "Press keys and LEAVE THEM DOWN, so they modify whatever you do next: shift+click to extend a selection, " +
      "ctrl+click to add to one, shift+drag to constrain an angle, alt+drag to duplicate. " +
      'Same combo grammar as `key` ("shift", "ctrl+alt"). Always finish with key_up; anything still held is ' +
      "released if the session is paused or stopped.",
    inputSchema: { combo: z.string().describe('Keys to hold, e.g. "shift" or "ctrl+shift".') },
  },
  async ({ combo }) => {
    try {
      input.parseCombo(combo);
      await call("key_down", { combo }, `holding ${combo}`, () => input.keyDown(combo));
      return ok({ type: "text", text: JSON.stringify({ holding: combo }) });
    } catch (e) {
      return err(e);
    }
  }
);

tool(
  "key_up",
  {
    title: "Release a held key",
    description: "Release keys held by key_down.",
    inputSchema: { combo: z.string() },
  },
  async ({ combo }) => {
    try {
      input.parseCombo(combo);
      await call("key_up", { combo }, `releasing ${combo}`, () => input.keyUp(combo));
      return ok({ type: "text", text: JSON.stringify({ released: combo }) });
    } catch (e) {
      return err(e);
    }
  }
);

tool(
  "scroll",
  {
    title: "Scroll",
    description:
      "Move the pointer to (x, y) in screenshot pixels, then scroll there. " +
      "`amount` is in wheel clicks (roughly 3 lines each): positive scrolls down (or right for horizontal), " +
      "negative scrolls up (or left).",
    inputSchema: {
      x: z.number(),
      y: z.number(),
      amount: z.number().int().describe("Wheel clicks. Positive = down/right, negative = up/left."),
      axis: z.enum(["vertical", "horizontal"]).default("vertical"),
    },
  },
  async ({ x, y, amount, axis }) => {
    try {
      const summary = `scrolling ${amount > 0 ? "down" : "up"} at ${Math.round(x)}, ${Math.round(y)}`;
      await call("scroll", { x, y, amount, axis }, summary, () => input.scroll(x, y, amount, axis));
      return ok({ type: "text", text: JSON.stringify({ ok: true }) });
    } catch (e) {
      return err(e);
    }
  }
);

// ------------------------------------------------------------------ keyboard

tool(
  "type_text",
  {
    title: "Type text",
    description:
      "Type a literal string into whatever currently has keyboard focus. Unicode is supported. " +
      "This does NOT interpret key names: to press Enter or a shortcut, use `key`. Click the target field first.",
    inputSchema: { text: z.string().max(20000).describe("The literal characters to type.") },
  },
  async ({ text }) => {
    try {
      const where = await focusedTitle();
      const preview = text.length > 40 ? text.slice(0, 40) + "..." : text;
      const summary = `typing ${JSON.stringify(preview)}${where ? ` into ${where}` : ""}`;
      await call("type_text", { text }, summary, () => input.typeText(text));
      return ok({ type: "text", text: JSON.stringify({ typed_characters: text.length }) });
    } catch (e) {
      return err(e);
    }
  }
);

tool(
  "key",
  {
    title: "Press key combo",
    description:
      'Press a key or chord, e.g. "enter", "tab", "ctrl+s", "ctrl+shift+esc", "alt+f4", "win+d". ' +
      "Parts are joined with +; modifiers are ctrl, alt, shift, win (aliases: control, option, super, meta, cmd). " +
      "Keys are pressed in order and released in reverse. One chord per call.",
    inputSchema: { combo: z.string().describe('Key combo such as "ctrl+shift+esc".') },
  },
  async ({ combo }) => {
    try {
      input.parseCombo(combo); // validate before announcing it to the user
      await call("key", { combo }, `pressing ${combo}`, () => input.pressCombo(combo));
      return ok({ type: "text", text: JSON.stringify({ pressed: combo }) });
    } catch (e) {
      return err(e);
    }
  }
);

// ------------------------------------------------------------------ wait_for

/**
 * "Is it done loading yet?" is otherwise a screenshot per guess, each one a
 * full round trip through the agent. Polling a small hash locally turns that
 * into one call that returns when the screen actually did something.
 */
async function regionFingerprint(region: { x: number; y: number; width: number; height: number } | undefined, display?: number): Promise<string> {
  // Untracked: polling must not move the coordinate space the agent is aiming at.
  const shot = await capture(display, region, { track: false });
  return createHash("sha1").update(shot.imageBase64).digest("hex");
}

tool(
  "wait_for",
  {
    title: "Wait for the screen to change",
    description:
      "Poll the screen until it changes (or stops changing), then return a screenshot. Use this instead of " +
      "guessing a delay and taking screenshots until something happens - it is one call rather than several.\n" +
      "`until: \"changes\"` returns as soon as the watched area differs from when the call started - use it for " +
      "waiting on a dialog, a menu, or a page to appear.\n" +
      "`until: \"settles\"` returns once the area has held still for two consecutive polls - use it for waiting " +
      "out a page load or an animation.\n" +
      "Narrow `region` to the part that matters (a spinner, a dialog area); a whole-screen watch trips on a " +
      "clock or a cursor blink. Region is in the pixel space of the last screenshot.\n" +
      "Returns {outcome: \"changed\"|\"settled\"|\"timeout\", waited_ms} plus the final screenshot. A timeout is " +
      "NOT an error - check `outcome` and decide.",
    inputSchema: {
      until: z.enum(["changes", "settles"]).default("changes"),
      region: z
        .object({
          x: z.number().int(),
          y: z.number().int(),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        })
        .optional()
        .describe("Area to watch, in last-screenshot pixels. Omit to watch the whole display."),
      timeout_ms: z.number().int().min(200).max(120000).default(10000),
      poll_ms: z.number().int().min(100).max(5000).default(350),
      display: z.number().int().optional(),
      screenshot: z.boolean().default(true).describe("Return a screenshot of the end state."),
    },
  },
  async ({ until, region, timeout_ms, poll_ms, display, screenshot }) => {
    try {
      return await call("wait_for", { until, region, timeout_ms }, `waiting for the screen to ${until === "changes" ? "change" : "settle"}`, async () => {
        await overlay.ensure();
        const started = Date.now();
        let previous = await regionFingerprint(region, display);
        let outcome: "changed" | "settled" | "timeout" = "timeout";
        let stableRuns = 0;

        while (Date.now() - started < timeout_ms) {
          await new Promise((r) => setTimeout(r, poll_ms));
          const now = await regionFingerprint(region, display);
          if (until === "changes") {
            if (now !== previous) {
              outcome = "changed";
              break;
            }
          } else {
            stableRuns = now === previous ? stableRuns + 1 : 0;
            if (stableRuns >= 2) {
              outcome = "settled";
              break;
            }
          }
          previous = now;
        }

        const summary = { outcome, waited_ms: Date.now() - started, until };
        if (!screenshot) return ok({ type: "text", text: JSON.stringify(summary, null, 2) });

        const shot = await capture(display);
        return ok(
          { type: "text", text: JSON.stringify(summary, null, 2) },
          { type: "image", data: shot.imageBase64, mimeType: shot.mimeType },
          {
            type: "text",
            text: JSON.stringify({
              shot_width: shot.map.shotWidth,
              shot_height: shot.map.shotHeight,
              scale: Number(shot.scale.toFixed(4)),
              origin: { x: Math.round(shot.map.originX), y: Math.round(shot.map.originY) },
              note: "Coordinates for the next call are in this image's pixel space.",
            }),
          }
        );
      });
    } catch (e) {
      return err(e);
    }
  }
);

// --------------------------------------------------------------------- batch

/**
 * A round trip through the agent costs far more than any of these actions, so
 * the slowest thing about driving a GUI one tool call at a time is the calls
 * themselves. `batch` runs a whole interaction - click, type, enter, settle,
 * look - in a single call. Every step still goes through `call()`, so the
 * overlay sees and gates each one exactly as if it had been sent on its own.
 */
const STEP_ACTIONS = [
  "click", "move", "drag", "scroll", "type_text", "key", "focus_window", "wait",
  "mouse_down", "mouse_up", "key_down", "key_up",
] as const;

async function runStep(s: Record<string, any>): Promise<unknown> {
  const need = (k: string) => {
    const v = s[k];
    if (v === undefined || v === null) {
      throw new ToolError("bad_step", `Step "${s.action}" requires "${k}".`);
    }
    return v;
  };

  switch (s.action) {
    case "click": {
      const [x, y] = [need("x"), need("y")];
      const button = s.button ?? "left";
      const clicks = s.clicks ?? 1;
      const verb = clicks === 2 ? "double-clicking" : "clicking";
      return await call("click", { x, y, button, clicks }, `${verb} at ${Math.round(x)}, ${Math.round(y)}`, () =>
        input.click(x, y, button, clicks)
      );
    }
    case "move": {
      const [x, y] = [need("x"), need("y")];
      return await call("move", { x, y }, `moving the pointer to ${Math.round(x)}, ${Math.round(y)}`, () =>
        input.move(x, y)
      );
    }
    case "drag": {
      const from = { x: need("x"), y: need("y") };
      const to = need("to");
      const button = s.button ?? "left";
      const summary = `dragging from ${Math.round(from.x)}, ${Math.round(from.y)} to ${Math.round(to.x)}, ${Math.round(to.y)}`;
      await call("drag", { from, to, button, via: s.via, hold_ms: s.hold_ms }, summary, () =>
        input.drag(from, to, button, { via: s.via, holdMs: s.hold_ms })
      );
      return { ok: true };
    }
    case "mouse_down": {
      const button = s.button ?? "left";
      const where = s.x !== undefined && s.y !== undefined ? ` at ${Math.round(s.x)}, ${Math.round(s.y)}` : "";
      await call("mouse_down", { x: s.x, y: s.y, button }, `holding the ${button} mouse button down${where}`, () =>
        input.mouseDown(s.x, s.y, button)
      );
      return { held: input.heldSummary() };
    }
    case "mouse_up": {
      const button = s.button ?? "left";
      const where = s.x !== undefined && s.y !== undefined ? ` at ${Math.round(s.x)}, ${Math.round(s.y)}` : "";
      await call("mouse_up", { x: s.x, y: s.y, button }, `releasing the ${button} mouse button${where}`, () =>
        input.mouseUp(s.x, s.y, button)
      );
      return { held: input.heldSummary() };
    }
    case "key_down": {
      const combo = need("combo");
      input.parseCombo(combo);
      await call("key_down", { combo }, `holding ${combo}`, () => input.keyDown(combo));
      return { holding: combo };
    }
    case "key_up": {
      const combo = need("combo");
      input.parseCombo(combo);
      await call("key_up", { combo }, `releasing ${combo}`, () => input.keyUp(combo));
      return { released: combo };
    }
    case "scroll": {
      const [x, y, amount] = [need("x"), need("y"), need("amount")];
      const axis = s.axis ?? "vertical";
      const summary = `scrolling ${amount > 0 ? "down" : "up"} at ${Math.round(x)}, ${Math.round(y)}`;
      await call("scroll", { x, y, amount, axis }, summary, () => input.scroll(x, y, amount, axis));
      return { ok: true };
    }
    case "type_text": {
      const text = need("text");
      const preview = text.length > 40 ? text.slice(0, 40) + "..." : text;
      await call("type_text", { text }, `typing ${JSON.stringify(preview)}`, () => input.typeText(text));
      return { typed_characters: text.length };
    }
    case "key": {
      const combo = need("combo");
      input.parseCombo(combo); // validate before announcing it to the user
      await call("key", { combo }, `pressing ${combo}`, () => input.pressCombo(combo));
      return { pressed: combo };
    }
    case "focus_window": {
      const id = String(need("id"));
      await call("focus_window", { id }, `focusing window ${id}`, () => focusWindow(id));
      return { ok: true };
    }
    case "wait": {
      // Not input, so it is not gated - it only ever slows the agent down.
      const ms = Math.min(10000, Math.max(0, s.ms ?? 400));
      await new Promise((r) => setTimeout(r, ms));
      return { waited_ms: ms };
    }
    default:
      throw new ToolError("bad_step", `Unknown step action "${s.action}".`);
  }
}

tool(
  "batch",
  {
    title: "Batch actions",
    description:
      "Run several input actions in one call, in order, then optionally take a screenshot of the result. " +
      "This is the fast path: prefer it over separate calls whenever you already know the next few actions " +
      "(click a field, type into it, press enter, look at what happened).\n" +
      "Each step is {action, ...args}: `click`/`move` take x,y (plus button, clicks); `drag` takes x,y as the " +
      "start and `to` as the end; `scroll` takes x,y,amount (plus axis); `type_text` takes text; `key` takes " +
      "combo; `focus_window` takes id; `wait` takes ms (default 400) to let the UI settle.\n" +
      "IMPORTANT: every coordinate in the batch is in the pixel space of the screenshot taken BEFORE the batch - " +
      "they are not re-based as the screen changes mid-batch. If a step moves things around, end the batch and " +
      "look before aiming at the new layout.\n" +
      "Stops at the first failing step and reports which one; steps already run are not undone. Each step is " +
      "gated by the overlay individually, so a denied step stops the batch.",
    inputSchema: {
      steps: z
        .array(
          z
            .object({
              action: z.enum(STEP_ACTIONS),
              x: z.number().optional(),
              y: z.number().optional(),
              to: z.object({ x: z.number(), y: z.number() }).optional().describe("Drag destination."),
              via: z.array(z.object({ x: z.number(), y: z.number() })).max(32).optional().describe("Drag waypoints."),
              hold_ms: z.number().int().min(0).max(5000).optional().describe("Pause before releasing a drag."),
              button: z.enum(["left", "right", "middle"]).optional(),
              clicks: z.number().int().min(1).max(3).optional(),
              amount: z.number().int().optional().describe("Scroll wheel clicks; positive is down/right."),
              axis: z.enum(["vertical", "horizontal"]).optional(),
              text: z.string().max(20000).optional(),
              combo: z.string().optional(),
              id: z.string().optional().describe("Window id, for focus_window."),
              ms: z.number().int().min(0).max(10000).optional().describe("Delay, for wait."),
            })
            .passthrough()
        )
        .min(1)
        .max(25),
      screenshot: z
        .boolean()
        .default(true)
        .describe("Take a screenshot after the last step and return it, so the result needs no second call."),
      display: z.number().int().optional().describe("Display for that final screenshot."),
    },
  },
  async ({ steps, screenshot, display }) => {
    const results: unknown[] = [];
    let failure: { step: number; action: string; error: unknown } | null = null;

    for (let i = 0; i < steps.length; i++) {
      try {
        results.push({ step: i, action: steps[i].action, result: await runStep(steps[i] as any) });
      } catch (e) {
        const te = e instanceof ToolError ? e : new ToolError("internal_error", String(e));
        failure = { step: i, action: steps[i].action, error: { code: te.code, message: te.message } };
        // Half a gesture is worse than none: never leave a button or modifier
        // stuck down because a later step failed.
        await input.releaseHeld().catch(() => undefined);
        break;
      }
    }

    const summary = {
      completed: results.length,
      total: steps.length,
      results,
      ...(failure ? { failed_at: failure } : {}),
    };

    // Report the end state even after a failure - seeing the screen is usually
    // how the agent works out why the step failed.
    if (!screenshot) {
      return { ...(failure ? { isError: true } : {}), content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    }
    try {
      await overlay.ensure();
      const shot = await capture(display);
      return {
        ...(failure ? { isError: true } : {}),
        content: [
          { type: "text" as const, text: JSON.stringify(summary, null, 2) },
          { type: "image" as const, data: shot.imageBase64, mimeType: shot.mimeType },
          {
            type: "text" as const,
            text: JSON.stringify({
              shot_width: shot.map.shotWidth,
              shot_height: shot.map.shotHeight,
              scale: Number(shot.scale.toFixed(4)),
              origin: { x: Math.round(shot.map.originX), y: Math.round(shot.map.originY) },
              note: "Coordinates for the next call are in this image's pixel space.",
            }),
          },
        ],
      };
    } catch (e) {
      return { ...(failure ? { isError: true } : {}), content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }] };
    }
  }
);

// ------------------------------------------------------------------- windows

tool(
  "list_windows",
  {
    title: "List windows",
    description:
      "List visible top-level windows. Returns [{id, pid, title, bounds:{x,y,width,height}, focused, minimized}]. " +
      "`bounds` is in screen coordinate units, not screenshot pixels. Ids are only valid while the window lives - " +
      "focus_window returns `stale_window_id` if you use an old one, so re-list rather than caching.",
    inputSchema: {},
  },
  async () => {
    try {
      const list = await listWindows();
      return ok({ type: "text", text: JSON.stringify(list, null, 2) });
    } catch (e) {
      return err(e);
    }
  }
);

tool(
  "focus_window",
  {
    title: "Focus window",
    description:
      "Bring a window to the foreground and give it keyboard focus, restoring it if minimized. " +
      "Pass an `id` from list_windows. Take a fresh screenshot afterwards - the screen has changed.",
    inputSchema: { id: z.string().describe("Window id from list_windows.") },
  },
  async ({ id }) => {
    try {
      const target = (await listWindows()).find((w) => w.id.toLowerCase() === id.toLowerCase());
      const summary = `focusing ${target ? target.title : `window ${id}`}`;
      await call("focus_window", { id }, summary, () => focusWindow(id));
      return ok({ type: "text", text: JSON.stringify({ focused: id }) });
    } catch (e) {
      return err(e);
    }
  }
);

// ------------------------------------------------------------------ commands

tool(
  "run_command",
  {
    title: "Run command",
    description:
      "Run a shell command on the user's machine and wait for it to exit. " +
      "Returns {stdout, stderr, exit_code, timed_out}. Output over 8 MB is truncated. " +
      "`cwd` must be inside an allowlisted root. This runs with the user's full privileges - prefer it over " +
      "driving a terminal window with keystrokes.",
    inputSchema: {
      cmd: z.string().describe("The command line, run through the platform shell."),
      cwd: z.string().optional().describe("Working directory. Must be inside an allowlisted root."),
      timeout: z
        .number()
        .int()
        .min(100)
        .max(600000)
        .default(30000)
        .describe("Milliseconds before the command is killed."),
    },
  },
  async ({ cmd, cwd, timeout }) => {
    try {
      const dir = cwd ? await resolveInRoots(cwd, true) : undefined;
      const preview = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
      const res = await call("run_command", { cmd, cwd: dir, timeout }, `running: ${preview}`, async () => {
        const shell = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
        const args =
          process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", cmd] : ["-c", cmd];
        try {
          return await run(shell, args, { cwd: dir, timeout });
        } catch (e) {
          if (e instanceof ToolError && e.code === "timeout") {
            return { stdout: "", stderr: e.message, code: 124, timedOut: true };
          }
          throw e;
        }
      });
      return ok({
        type: "text",
        text: JSON.stringify(
          {
            stdout: res.stdout,
            stderr: res.stderr,
            exit_code: res.code,
            timed_out: (res as { timedOut?: boolean }).timedOut ?? false,
          },
          null,
          2
        ),
      });
    } catch (e) {
      return err(e);
    }
  }
);

// ---------------------------------------------------------------- filesystem

tool(
  "read_file",
  {
    title: "Read file",
    description:
      "Read a UTF-8 text file. Only paths under the configured allowlist roots are readable; anything else returns " +
      "`outside_allowlist` and lists the roots. Files over 2 MB return `too_large`.",
    inputSchema: {
      path: z.string().describe("Absolute or relative path. Relative resolves against the server's cwd."),
    },
  },
  async ({ path: p }) => {
    try {
      const text = await readFile(p);
      return ok({ type: "text", text });
    } catch (e) {
      return err(e);
    }
  }
);

tool(
  "write_file",
  {
    title: "Write file",
    description:
      "Write a UTF-8 text file, creating parent directories as needed and overwriting any existing content. " +
      "Restricted to the allowlist roots. Returns {path, bytes} with the resolved absolute path.",
    inputSchema: { path: z.string(), content: z.string() },
  },
  async ({ path: p, content }) => {
    try {
      const res = await call("write_file", { path: p, bytes: content.length }, `writing ${p}`, () =>
        writeFile(p, content)
      );
      return ok({ type: "text", text: JSON.stringify(res) });
    } catch (e) {
      return err(e);
    }
  }
);

tool(
  "list_dir",
  {
    title: "List directory",
    description:
      "List a directory. Returns {path, entries:[{name, type: file|dir|other, size}]}; `size` is bytes for files " +
      "and null otherwise. Restricted to the allowlist roots.",
    inputSchema: { path: z.string() },
  },
  async ({ path: p }) => {
    try {
      const res = await listDir(p);
      return ok({ type: "text", text: JSON.stringify(res, null, 2) });
    } catch (e) {
      return err(e);
    }
  }
);

// ----------------------------------------------------------------- lifecycle

async function main() {
  loadConfig(); // fail fast on a broken config rather than at first tool call
  // Best effort: if the overlay is already up, the session shows immediately.
  // Do not start it here - that waits on a GUI before the client's handshake.
  await overlay.ensure({ launch: false }).catch(() => {});
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`agent-overlay server failed to start: ${e?.stack ?? e}\n`);
  process.exit(1);
});
