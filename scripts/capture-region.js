const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const [outDir, region, countArg = "24", intervalArg = "0.25"] =
  process.argv.slice(2);

if (!outDir || !region || !/^\d+,\d+,\d+,\d+$/.test(region)) {
  console.error(
    "Usage: node scripts/capture-region.js <out-dir> <x,y,w,h> [count] [intervalSeconds]"
  );
  process.exit(1);
}

const count = Number(countArg);
const intervalMs = Number(intervalArg) * 1000;
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

for (let i = 0; i < count; i++) {
  const name = String(i).padStart(3, "0") + ".png";
  const out = path.join(outDir, name);
  const result = spawnSync("screencapture", ["-x", "-R", region, out], {
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
  sleep(intervalMs);
}

console.log(`captured ${count} frames in ${outDir}`);
