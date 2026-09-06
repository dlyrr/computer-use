/**
 * Checks what the overlay does around a session, without needing to look at
 * pixels (the indicator is deliberately excluded from screen capture now).
 *   node scripts/check-session-ui.js     (overlay must be RUNNING)
 *
 * Briefly locks input while the fake session is "active" - that is the feature
 * under test. Escape releases it, and it releases itself when this exits.
 */
const net = require("net");
const { execFileSync } = require("child_process");
const assert = require("assert");
const { socketPath } = require("../dist/shared/protocol");

const ps = (cmd) =>
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();

// Reuse the helper the server already uses, rather than hand-rolling Win32
// interop through a PowerShell string (which is a quoting minefield).
const pillBounds = () => {
  const out = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "scripts/win32.ps1", "-Action", "windows"],
    { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  );
  const list = JSON.parse(out);
  // The border windows share the title and are full-screen, so match on the
  // pill's width - otherwise a border at 0,0 masquerades as "moved to the top".
  const w = (Array.isArray(list) ? list : [list]).find(
    (x) => String(x.title) === "agent-overlay" && Number(x.width) === 400
  );
  return w ? { x: w.x, y: w.y, width: w.width, height: w.height } : null;
};

const lockRunning = () =>
  ps(`@(Get-Process input-lock -ErrorAction SilentlyContinue).Count`) !== "0";

const screenH = () => Number(ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height`));

(async () => {
  const h = screenH();
  const fmt = (b) => (b ? `${b.x},${b.y} ${b.width}x${b.height}` : "hidden");
  console.log(`before session: pill=${fmt(pillBounds())}  lock=${lockRunning()}`);
  assert.strictEqual(lockRunning(), false, "input must not be locked before a session");

  const sock = net.connect(socketPath());
  await new Promise((res, rej) => {
    sock.on("error", rej);
    sock.on("data", (d) => {
      if (d.toString().includes("accepted")) res();
      if (d.toString().includes("refused")) rej(new Error("overlay refused: " + d.toString().trim()));
    });
    sock.on("connect", () => sock.write(JSON.stringify({ t: "hello", agent: "Claude", pid: process.pid }) + "\n"));
    setTimeout(() => rej(new Error("overlay never accepted")), 5000);
  });
  await new Promise((r) => setTimeout(r, 1500));

  const during = pillBounds();
  const duringLocked = lockRunning();
  console.log(`during session: pill=${fmt(during)}  lock=${duringLocked}`);
  assert(during, "the indicator should be on screen during a session");
  assert(during.y < h / 2, `indicator should move to the top during a session (y was ${during.y} of ${h})`);
  assert.strictEqual(duringLocked, true, "input should be locked while the agent is driving");

  sock.end();
  await new Promise((r) => setTimeout(r, 1800));

  const after = pillBounds();
  const afterLocked = lockRunning();
  console.log(`after session:  pill=${fmt(after)}  lock=${afterLocked}`);
  assert.strictEqual(afterLocked, false, "input MUST be released when the session ends");
  assert(after, "the indicator should stay on screen after a session, not vanish");
  assert(after.y > h / 2, `indicator should return to the bottom corner (y was ${after.y} of ${h})`);

  console.log("\nOK: indicator moves to the top and back, and input locks and releases with the session.");
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
