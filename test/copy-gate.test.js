import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = /降级.*内存|内存.*降级/;

function collectSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "vendor" || entry.name === "node_modules") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(abs));
    else if (entry.name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

test("copy gate: 源码不含「降级…内存」类误导表述", () => {
  const violations = [];
  for (const file of collectSourceFiles(path.join(repoRoot, "src"))) {
    const content = fs.readFileSync(file, "utf8");
    content.split("\n").forEach((line, index) => {
      if (FORBIDDEN.test(line)) {
        violations.push(`${path.relative(repoRoot, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(violations, []);
});
