import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const script = path.join(process.cwd(), "scripts", "write-runner-tokens.mjs");

function run(file, input) {
  return execFileSync(process.execPath, [script, "--file", file], {
    input,
    encoding: "utf8"
  });
}

test("write-runner-tokens：0600 原子写入并输出主机列表", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-runner-tokens-"));
  const file = path.join(dir, "tokens.json");
  try {
    const output = run(
      file,
      JSON.stringify([
        { hostId: "h1", token: "1234567890123456" },
        { hostId: "h2", token: "abcdefghijklmnop" }
      ])
    );
    const parsed = JSON.parse(output.trim());
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.hosts, ["h1", "h2"]);
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [
      { hostId: "h1", token: "1234567890123456" },
      { hostId: "h2", token: "abcdefghijklmnop" }
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("write-runner-tokens：非法输入 exit 2 且不覆盖原文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-runner-tokens-invalid-"));
  const file = path.join(dir, "tokens.json");
  fs.writeFileSync(file, "original");
  try {
    assert.throws(() => run(file, JSON.stringify([{ hostId: "h1", token: "short" }])), {
      status: 2
    });
    assert.equal(fs.readFileSync(file, "utf8"), "original");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
