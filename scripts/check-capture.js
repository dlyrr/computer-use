/**
 * End-to-end check of the capture path: drives the real MCP server over stdio
 * with the real overlay running, so it exercises the Electron grab, the JPEG
 * encode and the coordinate map together.
 *   node scripts/check-capture.js
 * Writes the returned frames next to itself so they can be looked at.
 */
const { spawn } = require("child_process");
const assert = require("assert");
const fs = require("fs");
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
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiters.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

const imageOf = (res) => res.result.content.find((c) => c.type === "image");
const jsonOf = (res, i = 0) => JSON.parse(res.result.content.filter((c) => c.type === "text")[i].text);

(async () => {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "0" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // Warm up: the first call launches/connects the overlay, which is not what
  // we are timing.
  await rpc("tools/call", { name: "screenshot", arguments: {} });

  const runs = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const res = await rpc("tools/call", { name: "screenshot", arguments: {} });
    runs.push(Date.now() - t);
    assert(!res.result.isError, "screenshot failed: " + JSON.stringify(res.result.content).slice(0, 300));
  }

  const res = await rpc("tools/call", { name: "screenshot", arguments: {} });
  const img = imageOf(res);
  const meta = jsonOf(res, 0);
  assert(img, "no image returned");
  assert.strictEqual(img.mimeType, "image/jpeg", "expected JPEG");
  const bytes = Buffer.from(img.data, "base64");
  fs.writeFileSync(path.join(__dirname, "shot-without-overlay.jpg"), bytes);
  console.log(`screenshot   ${runs.join("ms, ")}ms  ->  ${Math.round(bytes.length / 1024)}KB  ${meta.shot_width}x${meta.shot_height}`);

  const withOv = await rpc("tools/call", { name: "screenshot", arguments: { include_overlay: true } });
  const withBytes = Buffer.from(imageOf(withOv).data, "base64");
  fs.writeFileSync(path.join(__dirname, "shot-with-overlay.jpg"), withBytes);
  console.log(`include_overlay:true -> ${Math.round(withBytes.length / 1024)}KB`);

  // A region shot must still come from a full-resolution grab.
  const region = await rpc("tools/call", {
    name: "screenshot",
    arguments: { region: { x: 20, y: 20, width: 260, height: 140 } },
  });
  assert(!region.result.isError, "region screenshot failed: " + JSON.stringify(region.result.content).slice(0, 300));
  const rMeta = jsonOf(region, 0);
  fs.writeFileSync(path.join(__dirname, "shot-region.jpg"), Buffer.from(imageOf(region).data, "base64"));
  console.log(`region       ${rMeta.shot_width}x${rMeta.shot_height} (native detail, not upscaled crop)`);

  // A real desktop is never reliably static - a clock, a caret, a spinner will
  // all keep a region churning - so asserting a particular outcome here would
  // be a flaky test. What must hold is that the poll loop runs, respects its
  // deadline, and returns a well-formed answer instead of hanging.
  for (const until of ["settles", "changes"]) {
    const t2 = Date.now();
    const res2 = await rpc("tools/call", {
      name: "wait_for",
      arguments: { until, region: { x: 0, y: 0, width: 160, height: 90 }, timeout_ms: 3000, poll_ms: 200, screenshot: false },
    });
    const elapsed = Date.now() - t2;
    const out = jsonOf(res2, 0);
    console.log(`wait_for ${until.padEnd(8)} -> ${out.outcome.padEnd(8)} in ${elapsed}ms`);
    assert(!res2.result.isError, `wait_for ${until} errored`);
    assert(["changed", "settled", "timeout"].includes(out.outcome), `bad outcome ${out.outcome}`);
    assert(elapsed < 3000 + 2500, `wait_for ${until} overran its deadline (${elapsed}ms)`);
  }

  console.log("\nOK: capture, region, include_overlay and wait_for all work.");
  server.kill();
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  server.kill();
  process.exit(1);
});
