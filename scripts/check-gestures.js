/**
 * Checks that input can be held down across steps and calls, and - the part
 * that actually matters - that it is always let go again.
 *   node scripts/check-gestures.js     (overlay must be RUNNING)
 *
 * Uses the MIDDLE button and small movements on purpose: a middle-drag is inert
 * almost everywhere, so the test cannot rearrange the user's desktop.
 */
const { spawn } = require("child_process");
const assert = require("assert");
const path = require("path");

const server = spawn(process.execPath, [path.join(__dirname, "..", "dist", "server", "index.js")], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buf = "";
const waiters = new Map();
server.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const w = waiters.get(m.id);
    if (w) { waiters.delete(m.id); w(m); }
  }
});

let nextId = 1;
const rpc = (method, params) =>
  new Promise((res) => {
    const id = nextId++;
    waiters.set(id, res);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

const textOf = (r) => {
  const t = r.result?.content?.find((c) => c.type === "text");
  return t ? JSON.parse(t.text) : null;
};

(async () => {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "0" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const names = (await rpc("tools/list", {})).result.tools.map((t) => t.name).sort();
  for (const need of ["mouse_down", "mouse_up", "key_down", "key_up"]) {
    assert(names.includes(need), `missing tool ${need}`);
  }
  console.log("tools:", names.join(", "));

  // Coordinates are relative to the last screenshot, so take one first.
  const shot = await rpc("tools/call", { name: "screenshot", arguments: {} });
  assert(!shot.result.isError, "screenshot failed: " + JSON.stringify(shot.result.content).slice(0, 200));

  // 1. A button held ACROSS separate tool calls - the thing that was impossible.
  const down = await rpc("tools/call", { name: "mouse_down", arguments: { x: 400, y: 400, button: "middle" } });
  assert(!down.result.isError, "mouse_down failed: " + JSON.stringify(down.result.content).slice(0, 200));
  assert.deepStrictEqual(textOf(down).held.buttons, ["middle"], "the button should be held after mouse_down");
  console.log("after mouse_down (separate call)  held:", JSON.stringify(textOf(down).held));

  const moved = await rpc("tools/call", { name: "move", arguments: { x: 460, y: 440 } });
  assert(!moved.result.isError, "move while holding failed");

  const up = await rpc("tools/call", { name: "mouse_up", arguments: { x: 460, y: 440, button: "middle" } });
  assert.deepStrictEqual(textOf(up).held.buttons, [], "the button should be released after mouse_up");
  console.log("after mouse_up                    held:", JSON.stringify(textOf(up).held));

  // 2. A whole gesture in ONE batch: press, three waypoints, release.
  const gesture = await rpc("tools/call", {
    name: "batch",
    arguments: {
      screenshot: false,
      steps: [
        { action: "mouse_down", x: 420, y: 420, button: "middle" },
        { action: "move", x: 470, y: 420 },
        { action: "move", x: 470, y: 470 },
        { action: "move", x: 420, y: 470 },
        { action: "mouse_up", x: 420, y: 470, button: "middle" },
      ],
    },
  });
  const g = textOf(gesture);
  assert(!gesture.result.isError, "gesture batch failed: " + JSON.stringify(g).slice(0, 300));
  assert.strictEqual(g.completed, 5, "all five gesture steps should run");
  console.log(`gesture batch: ${g.completed}/${g.total} steps, ended held:`, JSON.stringify(g.results.at(-1).result.held));
  assert.deepStrictEqual(g.results.at(-1).result.held.buttons, [], "nothing should still be held after the gesture");

  // 3. The safety property: a batch that fails mid-gesture must not leave the
  //    button down.
  const broken = await rpc("tools/call", {
    name: "batch",
    arguments: {
      screenshot: false,
      steps: [
        { action: "mouse_down", x: 430, y: 430, button: "middle" },
        { action: "key", combo: "definitely-not-a-key" },
      ],
    },
  });
  const b = textOf(broken);
  assert.strictEqual(broken.result.isError, true, "the broken batch should report an error");
  console.log(`failed batch: stopped at step ${b.failed_at.step} (${b.failed_at.error.code})`);

  const after = await rpc("tools/call", { name: "mouse_up", arguments: { button: "middle" } });
  assert.deepStrictEqual(textOf(after).held.buttons, [], "a failed batch must not leave a button held");
  console.log("after failed batch                held:", JSON.stringify(textOf(after).held));

  console.log("\nOK: input holds across steps and calls, and is always released.");
  server.kill();
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  server.kill();
  process.exit(1);
});
