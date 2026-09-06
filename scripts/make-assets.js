/**
 * Render the two binary assets from SVG at build time, so none live in git:
 *   scripts/agent.cur  - the pointer shown while the agent drives (32bpp CUR)
 *   build/icon.png     - the app/installer icon
 */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");

// The pointer: Santi's black arrow with a white edge and a blue halo.
const ARROW = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 24 24">
  <defs>
    <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur stdDeviation="2.2" result="blur"/>
      <feFlood flood-color="#3f8cff" flood-opacity="1" result="col"/>
      <feComposite in="col" in2="blur" operator="in" result="blueBlur"/>
      <feComponentTransfer in="blueBlur" result="bright"><feFuncA type="linear" slope="4"/></feComponentTransfer>
      <feMerge><feMergeNode in="bright"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <path d="M4.5 3.5L10.5 20.5L13.8 13.8L20.5 10.5L4.5 3.5Z" fill="#000" stroke="#fff" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" filter="url(#glow)"/>
</svg>`;

const ICON = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 100 100">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffd1ee"/><stop offset=".48" stop-color="#d6c6ff"/><stop offset="1" stop-color="#b5e2ff"/>
  </linearGradient></defs>
  <rect x="4" y="4" width="92" height="92" rx="22" fill="url(#bg)"/>
  <path d="M30 22 L76 50 L55 56 L45 76 Z" fill="#fff" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>
</svg>`;

async function cur(out, size, hotX, hotY) {
  const { data } = await sharp(Buffer.from(ARROW(size))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rowBytes = size * 4;
  const maskRow = Math.ceil(size / 32) * 4;
  const img = Buffer.alloc(40 + rowBytes * size + maskRow * size);
  img.writeUInt32LE(40, 0);
  img.writeInt32LE(size, 4);
  img.writeInt32LE(size * 2, 8);
  img.writeUInt16LE(1, 12);
  img.writeUInt16LE(32, 14);
  img.writeUInt32LE(rowBytes * size + maskRow * size, 20);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * rowBytes; // DIB rows are bottom-up
    for (let x = 0; x < size; x++) {
      const i = src + x * 4, o = 40 + y * rowBytes + x * 4;
      img[o] = data[i + 2]; img[o + 1] = data[i + 1]; img[o + 2] = data[i]; img[o + 3] = data[i + 3];
    }
  }
  const head = Buffer.alloc(22);
  head.writeUInt16LE(2, 2); // CUR
  head.writeUInt16LE(1, 4);
  head[6] = size; head[7] = size;
  head.writeUInt16LE(hotX, 10);
  head.writeUInt16LE(hotY, 12);
  head.writeUInt32LE(img.length, 14);
  head.writeUInt32LE(22, 18);
  fs.writeFileSync(out, Buffer.concat([head, img]));
  console.log("wrote " + path.relative(root, out));
}

(async () => {
  await cur(path.join(root, "scripts", "agent.cur"), 48, 9, 7);
  fs.mkdirSync(path.join(root, "build"), { recursive: true });
  await sharp(Buffer.from(ICON(512))).png().toFile(path.join(root, "build", "icon.png"));
  console.log("wrote build/icon.png");
})().catch((e) => { console.error(e); process.exit(1); });
