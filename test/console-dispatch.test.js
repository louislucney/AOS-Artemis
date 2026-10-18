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
  assert.ok(noRunner.warnings.some((warning) => warning.includes("导入后确定")));
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
  assert.match(html, /<button class="c-button c-button-primary" type="submit" disabled/);
  assert.match(html, /登录回归/);
  assert.match(html, /host-a/);
  assert.match(html, /href="\/panel\?section=dispatch" aria-current="page"|aria-current="page" href="\/panel\?section=dispatch"/);
  assert.ok(!html.includes('http-equiv="refresh"'), "表单页不自动刷新");
});
