import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { makeTempDir } from "./helpers.js";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function runCliHelp(args) {
  const dir = makeTempDir();
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: dir,
    timeout: 15_000,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" }
  });
  return { dir, result, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const HELP_CASES = [
  ["serve", "--help"],
  ["serve", "--http", "--help"],
  ["suite", "--help"],
  ["suite", "run", "--help"],
  ["suite", "runner", "--help"],
  ["jira", "--help"],
  ["jira", "issue", "--help"],
  ["doctor", "--help"],
  ["init", "--help"],
  ["deps", "--help"],
  ["panel", "--help"],
  ["usage", "--help"]
];

for (const argv of HELP_CASES) {
  test(`cli help: ${argv.join(" ")} → exit 0＋用法（零副作用）`, () => {
    const { result, output } = runCliHelp(argv);
    assert.equal(result.signal, null, `不应超时/被杀（signal=${result.signal}）`);
    assert.equal(result.status, 0, `output=${output.slice(0, 400)}`);
    assert.match(output, /aos-mcp/);
    assert.match(output, /(Usage:|用法:)/, `必须是对应用法文本：${output.slice(0, 200)}`);
  });
}

test("cli help: init --help 不写任何文件", () => {
  const { dir, result } = runCliHelp(["init", "--help"]);
  assert.equal(result.status, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("cli help: suite run --help 不执行套件；suite runner --help 不启动", () => {
  const run = runCliHelp(["suite", "run", "--help"]);
  assert.equal(run.result.status, 0, run.output.slice(0, 300));
  assert.equal(run.output.includes("套件:"), false, "不得走执行路径");

  const runner = runCliHelp(["suite", "runner", "--help"]);
  assert.equal(runner.result.status, 0, runner.output.slice(0, 300));
  assert.equal(runner.output.includes("[runner] 启动"), false, "不得启动常驻");
});

test("cli help: 拼写错误子命令也走 help（--help 优先于校验）", () => {
  for (const argv of [
    ["suite", "runn", "--help"],
    ["serve", "frobnicate", "--help"]
  ]) {
    const { result, output } = runCliHelp(argv);
    assert.equal(result.signal, null, argv.join(" "));
    assert.equal(result.status, 0, `${argv.join(" ")} output=${output.slice(0, 300)}`);
    assert.match(output, /aos-mcp/);
  }
});
