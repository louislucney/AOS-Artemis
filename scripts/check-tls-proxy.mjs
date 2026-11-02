#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import process from "node:process";

function usage() {
  console.error(`用法:
  node scripts/check-tls-proxy.mjs --url https://aos.example.com \\
    --ca runner-ca.crt --cert runner.crt --key runner.key [--servername aos.example.com]
    [--no-ocsp] [--no-mtls] [--json]

默认检查：mTLS 健康检查、无客户端证书被拒、openssl OCSP stapling。`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { url: "", ca: "", cert: "", key: "", servername: "", ocsp: true, mtls: true, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1] ?? "";
      i += 1;
      return value;
    };
    if (arg === "--url") out.url = next();
    else if (arg === "--ca") out.ca = next();
    else if (arg === "--cert") out.cert = next();
    else if (arg === "--key") out.key = next();
    else if (arg === "--servername") out.servername = next();
    else if (arg === "--no-ocsp") out.ocsp = false;
    else if (arg === "--no-mtls") out.mtls = false;
    else if (arg === "--json") out.json = true;
    else usage();
  }
  if (out.url === "" || out.ca === "" || out.cert === "" || out.key === "") usage();
  return out;
}

function result(name, ok, detail) {
  return { name, ok, detail };
}

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function health(url, tls) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      new URL("/healthz", url),
      { method: "GET", ...tls },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            alpn: response.socket?.alpnProtocol ?? null
          });
        });
      }
    );
    request.setTimeout(10_000, () => request.destroy(new Error("healthz 超时")));
    request.on("error", reject);
    request.end();
  });
}

function noClientCert(url, ca) {
  return new Promise((resolve) => {
    const request = https.request(new URL("/healthz", url), { method: "GET", ca }, (response) => {
      response.resume();
      resolve({ rejected: false, status: response.statusCode ?? 0 });
    });
    request.setTimeout(10_000, () => request.destroy(new Error("无证书探测超时")));
    request.on("error", (error) => resolve({ rejected: true, error: error.message }));
    request.end();
  });
}

function ocspStaple(url, opts) {
  const host = url.hostname;
  const port = url.port || "443";
  const args = [
    "s_client",
    "-connect",
    `${host}:${port}`,
    "-servername",
    opts.servername || host,
    "-CAfile",
    opts.ca,
    "-cert",
    opts.cert,
    "-key",
    opts.key,
    "-status"
  ];
  const run = spawnSync("openssl", args, { input: "", encoding: "utf8", timeout: 30_000 });
  if (run.error) return { ok: false, detail: `openssl 不可用：${run.error.message}` };
  const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const status = /OCSP Response Status:\s*successful/i.test(text);
  const protocol = /Protocol\s*:\s*(\S+)/i.exec(text)?.[1] ?? null;
  return {
    ok: status,
    detail: status
      ? `OCSP stapling successful${protocol ? `，${protocol}` : ""}`
      : "未发现 successful OCSP stapling（检查证书 AIA / ssl_trusted_certificate / resolver）"
  };
}

const opts = parseArgs(process.argv.slice(2));
for (const [label, file] of [
  ["--ca", opts.ca],
  ["--cert", opts.cert],
  ["--key", opts.key]
]) {
  if (!fs.existsSync(file)) {
    console.error(`check-tls-proxy: ${label} 文件不存在：${file}`);
    process.exit(2);
  }
}
const url = new URL(opts.url);
if (url.protocol !== "https:") {
  console.error(`check-tls-proxy: --url 必须是 https://（当前 ${opts.url}）`);
  process.exit(2);
}
const tls = { ca: read(opts.ca), cert: read(opts.cert), key: read(opts.key) };
const checks = [];

try {
  const healthResult = await health(url, tls);
  checks.push(result("healthz", healthResult.status === 200, `HTTP ${healthResult.status}，ALPN ${healthResult.alpn ?? "http/1.1"}`));
} catch (error) {
  checks.push(result("healthz", false, error instanceof Error ? error.message : String(error)));
}

if (opts.mtls) {
  const rejected = await noClientCert(url, tls.ca);
  checks.push(
    result(
      "mtls-enforced",
      rejected.rejected,
      rejected.rejected ? `无客户端证书被拒：${rejected.error ?? ""}` : `未拒绝（HTTP ${rejected.status}）`
    )
  );
}

if (opts.ocsp) {
  const staple = ocspStaple(url, { ...opts, servername: opts.servername });
  checks.push(result("ocsp-stapling", staple.ok, staple.detail));
}

const ok = checks.every((entry) => entry.ok);
if (opts.json) {
  console.log(JSON.stringify({ ok, url: opts.url, checks }, null, 2));
} else {
  for (const entry of checks) console.log(`${entry.ok ? "OK" : "FAIL"}  ${entry.name}  ${entry.detail}`);
}
process.exit(ok ? 0 : 2);
