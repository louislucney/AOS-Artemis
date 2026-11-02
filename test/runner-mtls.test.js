import assert from "node:assert/strict";
import fs from "node:fs";
import http2 from "node:http2";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createAosHttpServer } from "../dist/http-server.js";
import { createRunnerFetch } from "../dist/runner/control/tls-fetch.js";
import { MemoryStore } from "../dist/db/memory.js";

const tlsDir = path.join(process.cwd(), "test", "fixtures", "tls");
const read = (name) => fs.readFileSync(path.join(tlsDir, name), "utf8");

test("runner mTLS：服务端要求客户端证书，runner 带证书可访问", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aos-mtls-"));
  const handle = await createAosHttpServer({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot,
    store: new MemoryStore(),
    tls: {
      cert: read("server-cert.pem"),
      key: read("server-key.pem"),
      ca: read("ca-cert.pem"),
      requestClientCert: true
    }
  });
  const baseUrl = `https://127.0.0.1:${handle.port}`;
  try {
    const runnerFetch = createRunnerFetch({
      AOS_RUNNER_TLS_CA: path.join(tlsDir, "ca-cert.pem"),
      AOS_RUNNER_TLS_CERT: path.join(tlsDir, "client-cert.pem"),
      AOS_RUNNER_TLS_KEY: path.join(tlsDir, "client-key.pem")
    });
    assert.ok(runnerFetch);
    const response = await runnerFetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /ok/);
  } finally {
    await handle.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("runner mTLS：不带客户端证书握手失败", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aos-mtls-no-client-"));
  const handle = await createAosHttpServer({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot,
    store: new MemoryStore(),
    tls: {
      cert: read("server-cert.pem"),
      key: read("server-key.pem"),
      ca: read("ca-cert.pem"),
      requestClientCert: true
    }
  });
  try {
    const runnerFetch = createRunnerFetch({
      AOS_RUNNER_TLS_CA: path.join(tlsDir, "ca-cert.pem")
    });
    assert.ok(runnerFetch);
    await assert.rejects(runnerFetch(`https://127.0.0.1:${handle.port}/healthz`));
  } finally {
    await handle.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});


test("runner mTLS：HTTP/2 客户端可访问（allowHTTP1 同时保留）", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aos-h2-"));
  const handle = await createAosHttpServer({
    port: 0,
    host: "127.0.0.1",
    workspaceRoot,
    store: new MemoryStore(),
    tls: {
      cert: read("server-cert.pem"),
      key: read("server-key.pem"),
      ca: read("ca-cert.pem"),
      requestClientCert: true
    }
  });
  const client = http2.connect(`https://127.0.0.1:${handle.port}`, {
    ca: read("ca-cert.pem"),
    cert: read("client-cert.pem"),
    key: read("client-key.pem")
  });
  try {
    const response = await new Promise((resolve, reject) => {
      const request = client.request({ ":path": "/healthz" });
      const chunks = [];
      let status = 0;
      request.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
      });
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
      request.on("error", reject);
      request.end();
    });
    assert.equal(response.status, 200);
    assert.match(response.body, /ok/);
  } finally {
    client.close();
    await handle.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
