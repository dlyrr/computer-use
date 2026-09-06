/** Times the overlay's in-process grab against the PowerShell helper. */
const net = require("net");
const { execFile } = require("child_process");
const path = require("path");
const os = require("os");
const { socketPath } = require("../dist/shared/protocol");

const sock = net.connect(socketPath());
let buf = "";
const waiters = new Map();

sock.on("data", (d) => {
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

function capture(maxWidth) {
  const id = "bench-" + Math.random().toString(36).slice(2);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout - overlay never answered (old build?)")), 8000);
    waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
    sock.write(JSON.stringify({ t: "capture", id, x: 400, y: 400, maxWidth, includeOverlay: false }) + "\n");
  });
}

function psCapture() {
  const script = path.join(__dirname, "win32.ps1");
  const out = path.join(os.tmpdir(), "bench-path.png");
  return new Promise((r) => {
    const t = Date.now();
    execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", "capture", "-Index", "0", "-Out", out],
      { windowsHide: true }, () => r(Date.now() - t));
  });
}

sock.on("connect", async () => {
  sock.write(JSON.stringify({ t: "hello", agent: "bench", pid: process.pid }) + "\n");
  try {
    await capture(1280); // warm
    for (const w of [1280, 1280, null]) {
      const t = Date.now();
      const m = await capture(w);
      const ms = Date.now() - t;
      if (!m.ok) { console.log(`overlay(${w ?? "native"})  FAILED: ${m.error}`); continue; }
      const kb = Math.round(Buffer.from(m.data, "base64").length / 1024);
      console.log(`overlay(${String(w ?? "native").padEnd(6)}) ${String(ms).padStart(4)}ms  ${m.imageWidth}x${m.imageHeight}  ${kb}KB  native=${m.nativeWidth}x${m.nativeHeight}`);
    }
  } catch (e) {
    console.log("overlay capture:", e.message);
  }
  console.log(`powershell        ${await psCapture()}ms`);
  console.log(`powershell        ${await psCapture()}ms`);
  sock.end();
  process.exit(0);
});

sock.on("error", (e) => { console.log("cannot reach overlay:", e.message); process.exit(1); });
