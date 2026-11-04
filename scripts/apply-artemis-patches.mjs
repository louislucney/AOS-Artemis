#!/usr/bin/env node
import { access, readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artemis = path.join(root, "artemis");
const patchDir = path.join(root, "patches", "artemis");

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const hookFile = path.join(artemis, "artemis", "security", "install.py");
if (await exists(hookFile)) {
  console.log(`artemis hooks already present: ${path.relative(root, hookFile)}`);
  process.exit(0);
}

const patches = (await readdir(patchDir))
  .filter((name) => name.endsWith(".patch"))
  .sort();
if (patches.length === 0) {
  console.error(`no patches found in ${patchDir}`);
  process.exit(1);
}

for (const name of patches) {
  const patchPath = path.join(patchDir, name);
  const check = spawnSync("git", ["-C", artemis, "apply", "--check", patchPath], {
    encoding: "utf8"
  });
  if (check.status !== 0) {
    console.error(`patch does not apply: ${name}\n${check.stderr || check.stdout}`);
    process.exit(1);
  }
  const apply = spawnSync("git", ["-C", artemis, "apply", patchPath], {
    encoding: "utf8"
  });
  if (apply.status !== 0) {
    console.error(`failed to apply: ${name}\n${apply.stderr || apply.stdout}`);
    process.exit(1);
  }
  const marker = await readFile(patchPath, "utf8");
  console.log(`applied ${name} (${marker.split("\n")[0]})`);
}
