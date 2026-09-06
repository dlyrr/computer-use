// tsc only emits .js; the renderer HTML has to be copied next to it.
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "dist", "overlay");
fs.mkdirSync(out, { recursive: true });
for (const f of ["index.html", "setup.html"]) {
  fs.copyFileSync(path.join(root, "src", "overlay", f), path.join(out, f));
  console.log(`copied ${f} -> dist/overlay/${f}`);
}
