/**
 * The one invariant this project exists to hold: with no overlay running, the
 * server must refuse to inject input. Run with `node scripts/verify-fail-closed.js`.
 * Make sure the overlay is NOT running first.
 */
const { spawn } = require("child_process");
const assert = require("assert");
const path = require("path");

// AGENT_OVERLAY_NO_LAUNCH stops the server starting the overlay itself, which
// is what lets us prove the refusal path rather than the happy path.
const server = spawn(process.execPath, [path.join(__dirname, "..", "dist", "server", "index.js")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, AGENT_OVERLAY_NO_LAUNCH: "1" },
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
    const msg = JSON.parse(line);
    const w = waiters.get(msg.id);
    if (w) {
      waiters.delete(msg.id);
      w(msg);
    }
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

(async () => {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify", version: "0" },
  });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const tools = await rpc("tools/list", {});
  const names = tools.result.tools.map((t) => t.name).sort();
  console.log("tools:", names.join(", "));
  for (const need of ["screenshot", "click", "type_text", "key", "list_windows", "run_command"]) {
    assert(names.includes(need), `missing tool ${need}`);
  }

  const res = await rpc("tools/call", {
    name: "click",
    arguments: { x: 10, y: 10, button: "left", clicks: 1 },
  });
  const payload = JSON.parse(res.result.content[0].text);
  console.log("click with no overlay ->", payload.error);
  assert.strictEqual(res.result.isError, true, "click must be an error with no overlay");
  assert.strictEqual(payload.error, "overlay_unavailable", "click must fail closed with no overlay");

  const shot = await rpc("tools/call", { name: "screenshot", arguments: {} });
  const shotPayload = JSON.parse(shot.result.content[0].text);
  console.log("screenshot with no overlay ->", shotPayload.error);
  assert.strictEqual(shot.result.isError, true, "screenshot must require the overlay too");

  // batch runs many actions per call, so it is the easiest place to
  // accidentally route input around the gate. It must refuse just the same.
  const batch = await rpc("tools/call", {
    name: "batch",
    arguments: { steps: [{ action: "click", x: 10, y: 10 }, { action: "type_text", text: "hi" }], screenshot: false },
  });
  const batchPayload = JSON.parse(batch.result.content[0].text);
  console.log("batch with no overlay ->", batchPayload.failed_at?.error?.code, `(completed ${batchPayload.completed})`);
  assert.strictEqual(batch.result.isError, true, "batch must be an error with no overlay");
  assert.strictEqual(batchPayload.completed, 0, "batch must not run any step without the overlay");
  assert.strictEqual(
    batchPayload.failed_at?.error?.code,
    "overlay_unavailable",
    "batch steps must fail closed with no overlay"
  );

  console.log("\nOK: input is refused when the overlay is not running.");
  server.kill();
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  server.kill();
  process.exit(1);
});
