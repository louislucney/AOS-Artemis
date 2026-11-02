#!/usr/bin/env node
import { chmodSync, renameSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function fail(message) {
  console.error(`write-runner-tokens: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  let file = process.env.AOS_RUNNER_HOST_TOKENS_FILE ?? "";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file") {
      file = argv[i + 1] ?? "";
      i += 1;
    } else if (arg.startsWith("--file=")) {
      file = arg.slice("--file=".length);
    } else {
      fail(`未知参数：${arg}`);
    }
  }
  if (file.trim() === "") fail("缺少 --file 或 AOS_RUNNER_HOST_TOKENS_FILE");
  return path.resolve(file.trim());
}

function validate(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    fail("必须是 [{hostId,token}] 且至少一项");
  }
  const seen = new Set();
  const entries = parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) fail(`第 ${index + 1} 项不是对象`);
    const hostId = typeof item.hostId === "string" ? item.hostId.trim() : "";
    const token = typeof item.token === "string" ? item.token.trim() : "";
    if (hostId === "") fail(`第 ${index + 1} 项 hostId 为空`);
    if (token.length < 16) fail(`第 ${index + 1} 项 token 少于 16 字符`);
    if (seen.has(hostId)) fail(`hostId 重复：${hostId}`);
    seen.add(hostId);
    return { hostId, token };
  });
  return entries;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const file = parseArgs(process.argv.slice(2));
const entries = validate(await readStdin());
const tmp = `${file}.tmp-${process.pid}`;
try {
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
} catch (error) {
  try {
    rmSync(tmp, { force: true });
  } catch {
    // ignore
  }
  fail(`写入失败：${error instanceof Error ? error.message : String(error)}`);
}
console.log(JSON.stringify({ ok: true, file, hosts: entries.map((entry) => entry.hostId) }));
