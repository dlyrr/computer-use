/**
 * The overlay serves one agent session at a time. This checks that the second
 * one is told so, loudly, instead of silently getting a dead connection - which
 * previously showed up as mysterious slowness rather than an error.
 *   node scripts/check-sessions.js     (overlay must be RUNNING)
 */
const net = require("net");
const { spawn } = require("child_process");
const assert = require("assert");
const path = require("path");
const { socketPath } = require("../dist/shared/protocol");

function holdOverlay() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath());
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      if (buf.includes('"accepted"')) resolve(sock);
      if (buf.includes('"refused"')) reject(new Error("overlay refused the holder: " + buf.trim()));
    });
    sock.on("error", reject);
    sock.on("connect", () => sock.write(JSON.stringify({ t: "hello", agent: "holder", pid: process.pid }) + "\n"));
    setTimeout(() => reject(new Error("overlay never accepted the holder - is it running the current build?")), 5000);
  });
}

function startServer() {
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
      let m; try { m = JSON.parse(line); } catch { continue; }
      const w = waiters.get(m.id);
      if (w) { waiters.delete(m.id); w(m); }
    }
  });
  let nextId = 1;
  const rpc = (method, params) => new Promise((res) => {
    const id = nextId++;
    waiters.set(id, res);
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { server, rpc };
}

(async () => {
  const holder = await holdOverlay();
  console.log("holder attached (simulating a second agent session already driving)");

  const { server, rpc } = startServer();
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "0" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const blocked = await rpc("tools/call", { name: "screenshot", arguments: {} });
  if (!blocked.result || !blocked.result.content) {
    console.error("unexpected response:", JSON.stringify(blocked).slice(0, 600));
    throw new Error("no result.content in the screenshot response");
  }
  const text = blocked.result.content.find((c) => c.type === "text");
  if (!text) {
    console.error("content types returned:", blocked.result.content.map((c) => c.type).join(", "));
    throw new Error("the second session got a screenshot instead of a refusal");
  }
  const payload = JSON.parse(text.text);
  console.log("second session ->", payload.error + ":", payload.message.slice(0, 90) + "...");
  assert.strictEqual(blocked.result.isError, true, "a second session must not silently succeed");
  assert.strictEqual(payload.error, "overlay_busy", "a second session must be told the overlay is busy");
  assert(/one at a time|already holds/i.test(payload.message), "the message must explain the single-session rule");

  holder.end();
  await new Promise((r) => setTimeout(r, 600));

  const after = await rpc("tools/call", { name: "screenshot", arguments: {} });
  assert(!after.result.isError, "once the other session lets go, this one must work: " + JSON.stringify(after.result.content).slice(0, 200));
  console.log("holder released -> screenshot succeeds");

  console.log("\nOK: the second session gets a clear error, and recovers on its own.");
  server.kill();
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
