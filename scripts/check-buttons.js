// Regression check: Button.LEFT is 0, so any truthiness test on the looked-up
// value rejects left clicks while right and middle keep working.
//   node scripts/check-buttons.js
const assert = require("assert");
const { Button } = require("@nut-tree-fork/nut-js");
const { toButton } = require("../dist/server/input");

assert.strictEqual(toButton("left"), Button.LEFT);
assert.strictEqual(toButton("right"), Button.RIGHT);
assert.strictEqual(toButton("middle"), Button.MIDDLE);
assert.throws(() => toButton("wheel"), /bad_button|Unknown button/);
assert.throws(() => toButton("toString"), /bad_button|Unknown button/);

console.log("buttons ok");
