import assert from "node:assert/strict";
import test from "node:test";

import { computeDispatchPreview, renderDispatchPage } from "../dist/console/dispatch.js";
import { MemoryStore } from "../dist/db/memory.js";

const ROOT = "/w/p";
const NOW = Date.parse("2026-10-18T12:00:00.000Z");

async function seed() {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: ROOT, name: "p" });
  const a = await store.recordCaseSet({
    rootPath: ROOT,
    source: "pen:a.pen",
    basename: "登录回归",
    features: [
      { key: "login", name: "登录", caseCount: 2, screens: [], jsonPath: "/x/a.json", mdPath: "/x/a.md", xlsxPath: "/x/a.xlsx" }
    ]
  });
  const b = await store.recordCaseSet({
    rootPath: ROOT,
    source: "figma:x",
    basename: "支付回归",
    features: [
      { key: "pay", name: "支付", caseCount: 3, screens: [], jsonPath: "/x/b.json", mdPath: "/x/b.md", xlsxPath: "/x/b.xlsx" }
    ]
  });
  await store.upsertRunner({
    rootPath: ROOT,
    name: "runner-a",
    hostname: "host-a",
    platforms: ["android"],
    devices: [],
    tools: { adb: true, idb: false, simctl: false, ideviceId: false, appium: false }
  });
  return { store, setA: a, setB: b };
}

test("computeDispatchPreview: 选份→条数与 runner 候选", async () => {
  const { store, setA } = await seed();
  const preview = await computeDispatchPreview(
    { store, env: {} },
    ROOT,
    new URLSearchParams({ source: "case-set", ref: setA.id })
  );
  assert.equal(preview.source.mode, "case-set");
  assert.equal(preview.source.caseCount, 2);
  assert.deepEqual(preview.refs, [setA.id]);
  assert.equal(preview.runnerCandidates.length, 1);
  assert.equal(preview.runnerCandidates[0].online, true, "刚心跳的 runner 视为在线");
  assert.deepEqual(preview.warnings, []);
});

test("computeDispatchPreview: 关键词匹配多份 / 无 runner 警告 / 空关键词", async () => {
  const { store } = await seed();
  const keyword = await computeDispatchPreview(
    { store, env: {}, now: () => NOW },
    ROOT,
    new URLSearchParams({ source: "keyword", keyword: "回归" })
  );
  assert.equal(keyword.source.caseCount, 5);
  assert.equal(keyword.refDetails.length, 2);

  const empty = await computeDispatchPreview(
    { store, env: {}, now: () => NOW },
    ROOT,
    new URLSearchParams({ source: "keyword", keyword: "" })
  );
  assert.ok(empty.warnings.some((warning) => warning.includes("关键词为空")));

  const noRunnerStore = new MemoryStore();
  await noRunnerStore.upsertProject({ rootPath: ROOT, name: "p" });
  const noRunner = await computeDispatchPreview(
    { store: noRunnerStore, env: {}, now: () => NOW },
    ROOT,
    new URLSearchParams({ source: "excel", excel: "/x/cases.xlsx" })
  );
  assert.ok(noRunner.warnings.some((warning) => warning.includes("无在线 runner")));
  assert.ok(noRunner.warnings.some((warning) => warning.includes("multipart 上传")));
});

test("renderDispatchPage: 四段式＋禁用派发＋表单不自动刷新", async () => {
  const { store, setA } = await seed();
  const preview = await computeDispatchPreview(
    { store, env: {}, now: () => NOW },
    ROOT,
    new URLSearchParams({ source: "case-set", ref: setA.id, platforms: "android,ios" })
  );
  const html = renderDispatchPage({
    rootPath: ROOT,
    rootLabel: "p",
    preview,
    query: { source: "case-set", ref: setA.id }
  });
  assert.match(html, /data-console="shell"/);
  assert.match(html, /① 来源/);
  assert.match(html, /② 参数/);
  assert.match(html, /③ 预览回显/);
  assert.match(html, /④ 确认/);
  assert.match(html, /id="dispatch-submit"/);
  assert.match(html, /panel\/api\/tasks/);
  assert.match(html, /data-features=/);
  assert.match(html, /id="dispatch-confirm"[\s\S]*hidden/, "两段确认摘要（默认隐藏）");
  assert.match(html, /id="dispatch-confirm-yes"/);
  assert.match(html, /id="dispatch-error"[^>]*role="alert"/, "内联错误区");
  assert.ok(!html.includes('value="excel"'), "Excel 死选项已移除");
  assert.ok(!html.includes('name="devices"'), "设备手输已移除（执行时在项目机确定）");
  assert.match(html, /aria-label="用例集份"/);
  assert.match(html, /aria-label="功能关键词"/);
  assert.match(html, /aria-label="基线"/);
  assert.match(html, /登录回归/);
  assert.match(html, /host-a/);
  assert.match(
    html,
    /aria-current="page"[^>]*href="[^"]*section=dispatch"|href="[^"]*section=dispatch"[^>]*aria-current="page"/,
    "下发为当前导航项（含项目上下文）"
  );
  assert.ok(!html.includes('http-equiv="refresh"'), "表单页不自动刷新");
});

test("renderDispatchPage: 写动作关闭时禁用派发并给可见原因", async () => {
  const { store, setA } = await seed();
  const preview = await computeDispatchPreview(
    { store, env: {} },
    ROOT,
    new URLSearchParams({ source: "case-set", ref: setA.id })
  );
  const html = renderDispatchPage({
    rootPath: ROOT,
    rootLabel: "p",
    preview,
    query: {},
    capabilities: { actions: false, usage: false, mode: "standalone" }
  });
  assert.match(html, /disabled title="写动作未启用"/);
  assert.ok(html.includes("写动作未启用：独立进程需"), "可见原因");
  assert.ok(!html.includes("id=\"dispatch-submit\""), "不渲染可点提交");
});

test("renderDispatchPage: 份名转义（存储型 XSS 回归）", async () => {
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: ROOT, name: "p" });
  const evil = await store.recordCaseSet({
    rootPath: ROOT,
    source: "figma:x",
    basename: '<img src=x onerror=alert(1)>',
    features: [
      { key: "f", name: "登录", caseCount: 1, screens: [], jsonPath: "/x/a.json", mdPath: "/x/a.md", xlsxPath: "/x/a.xlsx" }
    ]
  });
  const preview = await computeDispatchPreview(
    { store, env: {} },
    ROOT,
    new URLSearchParams({ source: "case-set", ref: evil.id })
  );
  const html = renderDispatchPage({ rootPath: ROOT, rootLabel: "p", preview, query: {} });
  assert.ok(!html.includes("<img src=x"), "份名不得原样进 HTML（rows 通道）");
  assert.ok(html.includes("&lt;img src=x"), "份名转义后可见");
});
