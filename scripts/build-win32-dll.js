/**
 * Precompile scripts/win32.cs to scripts/win32.dll.
 *
 * PowerShell's `Add-Type` with an inline source string runs the C# compiler on
 * every invocation - roughly 95ms of the ~400ms each helper call cost, paid
 * again for every screenshot, window list and focus. Compiling once at build
 * time removes that. If no compiler is present the script still works: it
 * falls back to compiling win32.cs at runtime, exactly as before.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

if (process.platform !== "win32") process.exit(0);

const dir = __dirname;
const cs = path.join(dir, "win32.cs");
const dll = path.join(dir, "win32.dll");

const roots = [
  path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];
const csc = roots.find((p) => fs.existsSync(p));

if (!csc) {
  console.log("no csc.exe found; win32.ps1 will compile at runtime (slower, still correct)");
  process.exit(0);
}

function build(source, output, extraArgs, onFail) {
  if (!fs.existsSync(source)) return;
  if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs) {
    console.log(path.basename(output) + " is current");
    return;
  }
  try {
    execFileSync(csc, ["/nologo", "/optimize+", `/out:${output}`, ...extraArgs, source], { stdio: "pipe" });
    console.log("built " + path.basename(output));
  } catch (e) {
    try { fs.unlinkSync(output); } catch {}
    console.log(
      path.basename(output) + " build failed: " + String(e.stderr || e.message).trim().split("\n")[0] + onFail
    );
  }
}

build(
  cs,
  dll,
  ["/target:library", "/reference:System.Windows.Forms.dll", "/reference:System.Drawing.dll"],
  " - falling back to runtime compile"
);

// The input lock is a separate EXE on purpose: low-level hooks need their own
// message loop, and its lifetime is the lock's lifetime.
build(
  path.join(dir, "input-lock.cs"),
  path.join(dir, "input-lock.exe"),
  ["/target:exe"],
  " - input locking will be unavailable"
);

build(
  path.join(dir, "agent-cursor.cs"),
  path.join(dir, "agent-cursor.exe"),
  ["/target:winexe"],
  " - the agent cursor will be unavailable"
);
