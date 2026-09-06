import screenshotDesktop from "screenshot-desktop";
import sharp from "sharp";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ps } from "./platform";
import { Display, displayAt, invalidateDisplays } from "./displays";
import { ToolError, overlay } from "./ipc";

export const MAX_WIDTH = 1280;

/**
 * The mapping from the pixels of the last screenshot back to screen
 * coordinates. `screenX = originX + shotX * k`.
 */
export interface ShotMap {
  display: Display;
  originX: number;
  originY: number;
  /** Screen units per screenshot pixel. */
  k: number;
  shotWidth: number;
  shotHeight: number;
}

/** Coordinates from agents always refer to the most recent screenshot. */
let last: ShotMap | null = null;

export function lastShot(): ShotMap {
  if (!last) {
    throw new ToolError(
      "no_screenshot",
      "No screenshot has been taken yet in this session. Coordinates are interpreted in screenshot pixel space, so call screenshot() first."
    );
  }
  return last;
}

/** Convert a point in screenshot pixels to screen coordinates. */
export function toScreen(x: number, y: number): { x: number; y: number } {
  const m = lastShot();
  if (x < 0 || y < 0 || x > m.shotWidth || y > m.shotHeight) {
    throw new ToolError(
      "out_of_bounds",
      `Point (${x}, ${y}) is outside the last screenshot, which is ${m.shotWidth}x${m.shotHeight} pixels. Origin is its top-left corner.`
    );
  }
  return { x: Math.round(m.originX + x * m.k), y: Math.round(m.originY + y * m.k) };
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShotResult {
  imageBase64: string;
  mimeType: string;
  map: ShotMap;
  /** Screenshot pixels per screen unit; multiply screen deltas by this. */
  scale: number;
}

/**
 * Screenshots are re-encoded as JPEG, not PNG. A 1280px-wide desktop shot is
 * ~640 KB of base64 as PNG and ~110 KB as JPEG q80, and every one of those
 * bytes crosses the stdio transport on every single screenshot. UI text stays
 * legible at this quality; raise it if fine detail ever matters more than
 * latency.
 */
const JPEG_QUALITY = 80;

export interface CaptureOptions {
  /** Update the coordinate map that click/drag/scroll resolve against. */
  track?: boolean;
  /** Let the overlay's own indicator appear in the shot. */
  includeOverlay?: boolean;
}

export async function capture(
  displayIndex?: number,
  region?: Region,
  opts: CaptureOptions = {}
): Promise<ShotResult> {
  const display = await displayAt(displayIndex);
  // A region shot exists to show detail, so it must be cropped from a
  // full-resolution grab; a whole-screen shot is downscaled anyway, so let the
  // compositor scale during the grab and skip the big intermediate entirely.
  const raw = await grab(display, region ? null : MAX_WIDTH, opts.includeOverlay === true);

  let nativeW = raw.nativeWidth;
  let nativeH = raw.nativeHeight;
  if (!nativeW || !nativeH) {
    const meta = await sharp(raw.buf).metadata();
    nativeW = meta.width ?? 0;
    nativeH = meta.height ?? 0;
  }
  if (!nativeW || !nativeH) {
    throw new ToolError("capture_failed", "The captured image had no dimensions; the display may have changed mid-capture.");
  }

  // Native pixels -> screen coordinate units (undoes OS display scaling).
  const f = display.width / nativeW;

  // The full-display screenshot space is deterministic, so `region` can be
  // expressed in it without depending on what was captured previously.
  const s0 = Math.min(1, MAX_WIDTH / nativeW);

  let cropNative = { left: 0, top: 0, width: nativeW, height: nativeH };
  if (region) {
    const left = Math.round(region.x / s0);
    const top = Math.round(region.y / s0);
    const width = Math.round(region.width / s0);
    const height = Math.round(region.height / s0);
    if (width <= 0 || height <= 0 || left < 0 || top < 0 || left + width > nativeW || top + height > nativeH) {
      throw new ToolError(
        "out_of_bounds",
        `region ${JSON.stringify(region)} does not fit inside the full-display screenshot space of ${Math.round(nativeW * s0)}x${Math.round(nativeH * s0)} pixels.`
      );
    }
    cropNative = { left, top, width, height };
  }

  const s1 = Math.min(1, MAX_WIDTH / cropNative.width);
  const outW = Math.max(1, Math.round(cropNative.width * s1));
  const outH = Math.max(1, Math.round(cropNative.height * s1));

  // The grab may already be at the output size (the overlay scaled it), in
  // which case this resize is a no-op and only the re-encode costs anything.
  let pipe = sharp(raw.buf);
  if (region) pipe = pipe.extract(cropNative);
  const img = await pipe
    .resize(outW, outH, { fit: "fill" })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();

  const map: ShotMap = {
    display,
    originX: display.x + cropNative.left * f,
    originY: display.y + cropNative.top * f,
    k: (cropNative.width * f) / outW,
    shotWidth: outW,
    shotHeight: outH,
  };
  // Polling shots (wait_for) must not move the coordinate space out from under
  // coordinates the agent already decided on.
  if (opts.track !== false) last = map;

  return { imageBase64: img.toString("base64"), mimeType: "image/jpeg", map, scale: 1 / map.k };
}

interface Grab {
  buf: Buffer;
  /** 0 when unknown, in which case the caller reads it back off the image. */
  nativeWidth: number;
  nativeHeight: number;
}

/** Set once the overlay proves it cannot capture, so we stop paying for retries. */
let overlayCaptureBroken = false;

async function grab(display: Display, maxWidth: number | null, includeOverlay: boolean): Promise<Grab> {
  // The overlay is an Electron app that is already running whenever a capture
  // is legal, and it can grab in-process. That skips a ~340ms helper spawn per
  // screenshot, so it is worth trying first and falling back on any trouble.
  if (!overlayCaptureBroken && overlay.connected) {
    try {
      const shot = await overlay.captureScreen({
        x: display.x + Math.floor(display.width / 2),
        y: display.y + Math.floor(display.height / 2),
        maxWidth,
        includeOverlay,
      });
      if (shot.buf.length) {
        return { buf: shot.buf, nativeWidth: shot.nativeWidth, nativeHeight: shot.nativeHeight };
      }
    } catch (e: any) {
      // An overlay too old to know the message will simply never answer; do
      // not keep waiting 8s per screenshot for that.
      if (/in time/.test(String(e?.message))) overlayCaptureBroken = true;
    }
  }
  return { buf: await grabViaPlatform(display), nativeWidth: 0, nativeHeight: 0 };
}

async function grabViaPlatform(display: Display): Promise<Buffer> {
  try {
    if (process.platform === "win32") {
      // Capture through the same helper that enumerates monitors, so the
      // display index always refers to the same physical screen.
      const file = path.join(os.tmpdir(), `agent-overlay-shot-${process.pid}.png`);
      await ps("capture", { Index: display.index, Out: file });
      const buf = await fs.promises.readFile(file);
      fs.promises.unlink(file).catch(() => undefined);
      return buf;
    }
    const ids = await screenshotDesktop.listDisplays();
    const target = ids[display.index] ?? ids[0];
    if (!target) throw new Error("screenshot backend reported no displays");
    return (await screenshotDesktop({ screen: target.id, format: "png" })) as Buffer;
  } catch (e: any) {
    invalidateDisplays();
    throw new ToolError(
      "capture_failed",
      `Could not capture the screen. This normally means the workstation is locked, the session is remote/headless, or the display configuration changed. Underlying error: ${e?.message ?? e}`
    );
  }
}
