import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeAppPathUrl, resolveAppDownloadTimeoutMs } from "../dist/device/app-artifacts.js";
import {
  deviceHostEnvFromConfig,
  normalizeAdbSocket,
  probeAdbSocket,
  probeAppiumStatus,
  resolveAndroidAdbSocket,
  resolveIosHost
} from "../dist/device/device-hosts.js";
import { normalizeConfig } from "../dist/config/loader.js";
import { makeResolver } from "../dist/config/validate.js";
import { baseConfig, loadTestRuntime, makeTempProject, StubProxy } from "./helpers.js";

function configWithDeviceHosts(hosts) {
  return normalizeConfig({
    llm: { profiles: { a: { provider: "custom", model: "m" } } },
    artemis: { repo: "" },
    deviceHosts: hosts
  });
}

test("deviceHosts: config 解析与 iOS env 映射（含签名键）", () => {
  const config = configWithDeviceHosts({
    ios: {
      appiumUrl: "http://192.168.1.50:4723",
      wdaBundleId: "com.devB.wda",
      xcodeOrgId: "TEAM123",
      xcodeSigningId: "Apple Development"
    },
    android: { adbHost: "192.168.1.60:5037" }
  });
  assert.equal(config.deviceHosts.ios.appiumUrl, "http://192.168.1.50:4723");
  assert.deepEqual(deviceHostEnvFromConfig(config), {
    AOS_APPIUM_URL: "http://192.168.1.50:4723",
    AOS_IOS_WDA_BUNDLE_ID: "com.devB.wda",
    AOS_IOS_XCODE_ORG_ID: "TEAM123",
    AOS_IOS_XCODE_SIGNING_ID: "Apple Development"
  });
  assert.throws(() => normalizeConfig({ llm: { profiles: {} }, artemis: { repo: "" }, deviceHosts: [] }), /deviceHosts/);
});

test("normalizeAdbSocket: host:port / tcp:host:port，非法拒绝", () => {
  assert.equal(normalizeAdbSocket("127.0.0.1:5037"), "tcp:127.0.0.1:5037");
  assert.equal(normalizeAdbSocket("tcp:10.0.0.5:5037"), "tcp:10.0.0.5:5037");
  assert.equal(normalizeAdbSocket("  host.local:5038 "), "tcp:host.local:5038");
  assert.equal(normalizeAdbSocket("bad"), null);
  assert.equal(normalizeAdbSocket("host:0"), null);
  assert.equal(normalizeAdbSocket(""), null);
  assert.equal(normalizeAdbSocket(null), null);
});

test("resolveAndroidAdbSocket: config < dotenv < 进程 env", () => {
  const config = configWithDeviceHosts({ android: { adbHost: "10.0.0.1:5037" } });
  const fromConfig = resolveAndroidAdbSocket(config, makeResolver({}, {}));
  assert.deepEqual(fromConfig, { socket: "tcp:10.0.0.1:5037", source: "config" });
  const fromDotenv = resolveAndroidAdbSocket(config, makeResolver({ ADB_SERVER_SOCKET: "10.0.0.2:5037" }, {}));
  assert.deepEqual(fromDotenv, { socket: "tcp:10.0.0.2:5037", source: "dotenv" });
  const fromEnv = resolveAndroidAdbSocket(
    config,
    makeResolver({ ADB_SERVER_SOCKET: "10.0.0.2:5037" }, { ADB_SERVER_SOCKET: "tcp:10.0.0.3:5037" })
  );
  assert.deepEqual(fromEnv, { socket: "tcp:10.0.0.3:5037", source: "env" });
});

test("resolveIosHost: env > dotenv > config，签名键逐项回退", () => {
  const config = configWithDeviceHosts({
    ios: { appiumUrl: "http://config:4723", xcodeOrgId: "CFG_TEAM" }
  });
  const fromConfig = resolveIosHost(config, makeResolver({}, {}));
  assert.equal(fromConfig.appiumUrl, "http://config:4723");
  assert.equal(fromConfig.xcodeOrgId, "CFG_TEAM");
  assert.equal(fromConfig.source, "config");

  const layered = resolveIosHost(
    config,
    makeResolver({ AOS_APPIUM_URL: "http://dotenv:4723" }, { AOS_IOS_XCODE_ORG_ID: "ENV_TEAM" })
  );
  assert.equal(layered.appiumUrl, "http://dotenv:4723");
  assert.equal(layered.source, "dotenv");
  assert.equal(layered.xcodeOrgId, "ENV_TEAM");
});

test("probeAppiumStatus: /status 可达/不可达/异常三态", async () => {
  const ok = await probeAppiumStatus("http://host:4723/", {
    fetchImpl: async (url) => {
      assert.equal(url, "http://host:4723/status");
      return new Response("{}", { status: 200 });
    }
  });
  assert.equal(ok.ok, true);
  const http500 = await probeAppiumStatus("http://host:4723", {
    fetchImpl: async () => new Response("nope", { status: 500 })
  });
  assert.equal(http500.ok, false);
  assert.match(http500.detail, /HTTP 500/);
  const thrown = await probeAppiumStatus("http://host:4723", {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    }
  });
  assert.equal(thrown.ok, false);
  assert.match(thrown.detail, /ECONNREFUSED/);
});

test("probeAdbSocket: adb host:version 握手（OKAY）/端口不通", async () => {
  const server = net.createServer((socket) => {
    // 探针收到 OKAY 后会主动断开；服务端 socket 需吞掉随之而来的 ECONNRESET。
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      assert.equal(chunk.toString("utf-8"), "000Chost:version");
      socket.write("OKAY0004");
      socket.write("0001");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const ok = await probeAdbSocket(`tcp:127.0.0.1:${port}`);
  assert.equal(ok.ok, true, ok.detail);
  await new Promise((resolve) => server.close(resolve));

  const refused = await probeAdbSocket(`tcp:127.0.0.1:${port}`, { timeoutMs: 1_000 });
  assert.equal(refused.ok, false);
  assert.equal(await probeAdbSocket("bad").then((result) => result.ok), false);
});

test("runtime: Android app_path URL 落项目缓存并转本地路径转发（ADR-0011）", async () => {
  const dir = makeTempProject({ config: baseConfig() });
  const server = http.createServer((req, res) => res.end("APKDATA"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/app.apk`;
  const proxy = new StubProxy({ running: true });
  const { runtime } = await loadTestRuntime(dir, { proxy });

  await runtime.proxy.callTool("mobile_run_task", {
    task_desc: "安装远端 APK",
    device_serial: "emulator-5554",
    app_path: url
  });
  const forwarded = proxy.calls.find((call) => call.name === "mobile_run_task");
  assert.ok(forwarded, "转发到 artemis");
  const expectedDir = path.join(dir, ".artemis", "cache", "apps");
  assert.equal(path.dirname(forwarded.args.app_path), expectedDir);
  assert.equal(fs.readFileSync(forwarded.args.app_path, "utf-8"), "APKDATA");
  assert.equal(forwarded.args.task_desc, "安装远端 APK");
  await new Promise((resolve) => server.close(resolve));

  // 下载失败：显式错误返回，不转发
  proxy.calls.length = 0;
  const failed = await runtime.proxy.callTool("mobile_run_task", {
    task_desc: "坏 URL",
    device_serial: "emulator-5554",
    app_path: "https://127.0.0.1:9/never.apk"
  });
  assert.equal(failed.isError, true);
  assert.match(JSON.parse(failed.content[0].text).error, /app_path 远端产物不可用/);
  assert.equal(proxy.calls.length, 0);
});

test("materializeAppPathUrl: 下载缓存复用、404 与超时回退", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-app-cache-"));
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.url === "/missing.apk") {
      res.statusCode = 404;
      res.end("nope");
      return;
    }
    res.end("APKDATA");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/build/app.apk`;

  const first = await materializeAppPathUrl({ appPath: url, cacheDir });
  assert.equal(first.ok, true);
  assert.equal(first.cached, false);
  assert.equal(fs.readFileSync(first.path, "utf-8"), "APKDATA");
  assert.match(path.basename(first.path), /\.apk$/);

  const second = await materializeAppPathUrl({ appPath: url, cacheDir });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true);
  assert.equal(second.path, first.path);
  assert.equal(hits, 1, "重复调用命中缓存，不再下载");

  const missing = await materializeAppPathUrl({
    appPath: `http://127.0.0.1:${port}/missing.apk`,
    cacheDir
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /HTTP 404/);

  await new Promise((resolve) => server.close(resolve));
  const unreachable = await materializeAppPathUrl({
    appPath: `http://127.0.0.1:${port}/x.apk`,
    cacheDir,
    timeoutMs: 1_000
  });
  assert.equal(unreachable.ok, false);

  assert.equal(resolveAppDownloadTimeoutMs({}), 600_000);
  assert.equal(resolveAppDownloadTimeoutMs({ AOS_APP_DOWNLOAD_TIMEOUT_MS: "1234" }), 1234);
  assert.equal(resolveAppDownloadTimeoutMs({ AOS_APP_DOWNLOAD_TIMEOUT_MS: "0" }), 600_000);
});
