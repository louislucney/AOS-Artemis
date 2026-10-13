import assert from "node:assert/strict";
import test from "node:test";

import { createPanelDeepProbe } from "../dist/panel/deep.js";

function fakeRuntime({ iosAppiumInfo } = {}) {
  return {
    activeEntry: async () => ({ name: "deepseek-flash" }),
    entries: async () => [{ name: "a" }, { name: "b" }],
    setupInfo: async () => ({ required: false }),
    artemisPython: () => ({ python: "/repo/.venv/bin/python", hint: null }),
    figmaTokenInfo: async () => ({ value: "token", source: "store" }),
    jiraConfig: () => ({ configured: true, siteUrl: "https://x.atlassian.net", missing: [] }),
    proxy: { status: () => ({ running: false, pid: null, restarts: 2, lastError: null }) },
    storeKind: () => "postgres",
    storeNote: null,
    storeError: () => null,
    usageEnabled: () => true,
    modelRefreshHours: () => 12,
    modelAutoRepairEnabled: () => true,
    project: { config: { artemis: { repo: "/repo" } } },
    configDirAbs: "/proj/.artemis",
    build: { stale: false, startedAtMs: 0 },
    iosAppiumInfo
  };
}

test("panel deep: 纯读子集（默认不触发 ios 探测）", async () => {
  let probeCalls = 0;
  const runtime = fakeRuntime({
    iosAppiumInfo: async () => {
      probeCalls += 1;
      return {
        appium: { found: true, path: "appium", version: "3.8.0" },
        xcuitest: { installed: true, version: "12" },
        guidance: ["g"]
      };
    }
  });
  const probe = createPanelDeepProbe({ createRuntime: async () => runtime });
  const view = await probe.build("/proj");
  assert.ok(view);
  assert.equal(probeCalls, 0, "默认不 spawn 本地 CLI 探测");
  assert.equal(view.iosProbe, null);
  assert.equal(view.activeProfile, "deepseek-flash");
  assert.equal(view.llmEntries, 2);
  assert.deepEqual(view.store, { kind: "postgres", degraded: false, note: null, lastError: null });
  assert.deepEqual(view.artemis.child, { running: false, pid: null, restarts: 2, lastError: null });
  assert.equal(view.figma.token.present, true);
  assert.equal(view.figma.token.source, "store");
  assert.equal(view.jira.configured, true);
  assert.equal(view.build.stale, false);
  assert.equal(view.usage.enabled, true);
  assert.deepEqual(view.modelRefresh, { ttlHours: 12, autoRepair: true });

  const missing = createPanelDeepProbe({ createRuntime: async () => null });
  assert.equal(await missing.build("/nope"), null);
});

test("panel deep: iOS 探测显式触发 + 时间缓存", async () => {
  let probeCalls = 0;
  let t = Date.parse("2026-10-14T00:00:00.000Z");
  const runtime = fakeRuntime({
    iosAppiumInfo: async () => {
      probeCalls += 1;
      return {
        appium: { found: true, path: "appium", version: "3.8.0" },
        xcuitest: { installed: false, version: null },
        guidance: ["安装 xcuitest"]
      };
    }
  });
  const probe = createPanelDeepProbe({
    createRuntime: async () => runtime,
    now: () => t,
    iosProbeTtlMs: 60_000
  });

  const first = await probe.build("/proj", { iosProbe: true });
  assert.equal(probeCalls, 1);
  assert.equal(first.iosProbe.appium.found, true);
  assert.equal(first.iosProbe.error, null);

  t += 30_000;
  const cached = await probe.build("/proj", { iosProbe: true });
  assert.equal(probeCalls, 1, "TTL 内复用缓存");
  assert.equal(cached.iosProbe.probedAt, first.iosProbe.probedAt);

  t += 40_000;
  await probe.build("/proj", { iosProbe: true });
  assert.equal(probeCalls, 2, "TTL 过期后重新探测");
});

test("panel deep: 探测失败/超时如实记录（不抛出）", async () => {
  const failing = createPanelDeepProbe({
    createRuntime: async () =>
      fakeRuntime({
        iosAppiumInfo: async () => {
          throw new Error("appium 未安装");
        }
      })
  });
  const failed = await failing.build("/proj", { iosProbe: true });
  assert.match(failed.iosProbe.error, /appium 未安装/);
  assert.equal(failed.iosProbe.appium.found, false);

  const hanging = createPanelDeepProbe({
    createRuntime: async () => fakeRuntime({ iosAppiumInfo: () => new Promise(() => {}) }),
    iosProbeTimeoutMs: 20
  });
  const timedOut = await hanging.build("/proj", { iosProbe: true });
  assert.match(timedOut.iosProbe.error, /超时/);
});
