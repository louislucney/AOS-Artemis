import assert from "node:assert/strict";
import test from "node:test";

import {
  computeDispatchPreview,
  dispatchFormSignature,
  dispatchPreviewId,
  precheckTask,
  renderDispatchPage
} from "../dist/console/dispatch.js";
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

test("computeDispatchPreview: 重复 platforms 参数保留两端", async () => {
  const { store, setA } = await seed();
  const params = new URLSearchParams({ source: "case-set", ref: setA.id });
  params.append("platforms", "android");
  params.append("platforms", "ios");
  const preview = await computeDispatchPreview({ store, env: {}, now: () => NOW }, ROOT, params);
  assert.deepEqual(preview.platforms, ["android", "ios"]);
  const signature = dispatchFormSignature(params);
  assert.match(signature, /android,ios/);

  const html = renderDispatchPage({
    rootPath: ROOT,
    rootLabel: "p",
    preview,
    previewId: dispatchPreviewId(preview, signature, ROOT),
    formSignature: signature,
    query: {}
  });
  assert.match(html, /name="platforms" value="android" checked/, "Android 保持选中");
  assert.match(html, /name="platforms" value="ios" checked/, "iOS 保持选中");
});

test("computeDispatchPreview: runner 在线按 TTL（默认 90s）而非固定 5 分钟", async () => {
  const { store, setA } = await seed();
  const params = new URLSearchParams({ source: "case-set", ref: setA.id });
  const stale = await computeDispatchPreview(
    { store, env: {}, now: () => Date.now() + 120_000 },
    ROOT,
    params
  );
  assert.equal(stale.runnerCandidates[0].online, false, "120s 未心跳 → 失联");
  const relaxed = await computeDispatchPreview(
    { store, env: { AOS_RUNNER_TTL_MS: "300000" }, now: () => Date.now() + 120_000 },
    ROOT,
    params
  );
  assert.equal(relaxed.runnerCandidates[0].online, true, "TTL 可配后仍在线");
});

test("precheckTask: iOS 仅 darwin，不靠 kind=mac 放行", () => {
  const bad = precheckTask(
    {
      id: "h-win-mac",
      kind: "mac",
      osPlatform: "win32",
      capabilities: ["ios-simulator"],
      online: true
    },
    ["ios"]
  );
  assert.equal(bad.ok, false);
  assert.match(bad.reasons.join(" "), /iOS 需要 macOS/);
  const good = precheckTask(
    {
      id: "h-mac",
      kind: "mac",
      osPlatform: "darwin",
      capabilities: ["ios-simulator"],
      online: true
    },
    ["ios"]
  );
  assert.equal(good.ok, true);
});

test("dispatchPreviewId: 绑定目标 host 与项目路径", () => {
  const preview = {
    refs: ["set-a"],
    selectedHostId: "h-a",
    source: { mode: "case-set", label: "a", caseCount: 1 }
  };
  const base = dispatchPreviewId(preview, "sig", "/w/p");
  assert.notEqual(
    dispatchPreviewId({ ...preview, selectedHostId: "h-b" }, "sig", "/w/p"),
    base,
    "换 host 必须换 previewId"
  );
  assert.notEqual(
    dispatchPreviewId(preview, "sig", "/w/q"),
    base,
    "换项目路径必须换 previewId"
  );
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
  assert.ok(
    !empty.warnings.some((warning) => warning.includes("关键词为空")),
    "空关键词不再 warnings 双提示（③ 空态横幅承担）"
  );

  const noRunnerStore = new MemoryStore();
  await noRunnerStore.upsertProject({ rootPath: ROOT, name: "p" });
  const noRunner = await computeDispatchPreview(
    { store: noRunnerStore, env: {}, now: () => NOW },
    ROOT,
    new URLSearchParams({ source: "excel", excel: "/x/cases.xlsx" })
  );
  assert.ok(
    !noRunner.warnings.some((warning) => warning.includes("无在线执行机")),
    "无在线执行机降级为预览信息行（不再 warning 堆叠）"
  );
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
  assert.match(html, /id="dispatch-status"[^>]*role="status"/, "提交中状态位");
  assert.match(html, /aosInlineConfirm\(go,/, "单次确认（站内）替代两段确认");
  assert.match(html, /提交中…/, "提交中反馈");
  assert.match(html, /data-count=/, "份选项携带条数");
  assert.match(html, /请至少选择目标端/, "端为空前置校验");
  assert.match(html, /id="dispatch-error"[^>]*role="alert"/, "内联错误区");
  assert.match(html, /id="dispatch-stale"/, "预览过期横幅");
  assert.match(html, /id="dispatch-preview-data"/, "预览数据岛（previewId＋表单签名）");
  assert.match(html, /refreshStale/, "字段变更→过期即禁用确认");
  assert.match(html, /island\.previewId/, "POST 携带 previewId（服务端复算比对）");
  assert.ok(!html.includes('value="excel"'), "Excel 死选项已移除");
  assert.ok(!html.includes('name="devices"'), "设备手输已移除（执行时在项目机确定）");
  assert.match(html, /aria-label="用例集"/);
  assert.match(html, /aria-label="功能关键词"/);
  assert.match(html, /aria-label="基线"/);
  assert.match(html, /登录回归/);
  assert.match(html, /host-a/);
  assert.match(
    html,
    /aria-current="page"[^>]*href="[^"]*section=create"|href="[^"]*section=create"[^>]*aria-current="page"/,
    "新建测试为当前导航项（含项目上下文）"
  );
  assert.match(html, /class="c-flow-switch"/, "套件回归/网页测试分流");
  assert.match(html, /MCP 原生接入/, "MCP 原生入口常驻");
  assert.match(html, /class="c-flow-callout"/, "安装包下发指引常驻");
  assert.match(html, /要下发安装包（APK\/IPA）/, "安装包引导文案");
  assert.match(html, /section=assets&amp;tab=case-sets#library-import/, "Excel 用例导入指引");
  assert.ok(!html.includes('http-equiv="refresh"'), "表单页不自动刷新");
});

test("renderDispatchPage: 预览合同（预览数据岛与服务端同源）", async () => {
  const { store, setA } = await seed();
  const params = new URLSearchParams({ source: "case-set", ref: setA.id, platforms: "android" });
  const preview = await computeDispatchPreview({ store, env: {}, now: () => NOW }, ROOT, params);
  const formSignature = dispatchFormSignature(params);
  const previewId = dispatchPreviewId(preview, formSignature, ROOT);
  const html = renderDispatchPage({
    rootPath: ROOT,
    rootLabel: "p",
    preview,
    previewId,
    formSignature,
    query: { source: "case-set", ref: setA.id }
  });
  assert.ok(html.includes(`"previewId":"${previewId}"`), "岛内 previewId 与服务端同源");
  assert.ok(html.includes(`"formSignature":"${formSignature}"`), "岛内表单签名（客户端复算同式）");
  assert.match(html, /"ready":true/, "非空预览 → ready");
  assert.match(html, /"runnerOnline":true/, "执行机在线标记入岛");
  assert.match(html, /refsDetail/, "份明细入岛（单次确认摘要）");
  assert.match(html, /id="dispatch-field-ref"/, "份字段容器（来源联动）");
  assert.match(html, /id="dispatch-field-keyword"/, "关键词字段容器（来源联动）");
  assert.match(html, /go\.disabled=blocked;/, "过期/空预览均禁用确认");
  assert.match(html, /formSignature\(\)!==island\.formSignature/, "字段变更→过期判定");
  assert.match(html, /id="dispatch-stale"/, "过期横幅（role=status）");
  assert.match(html, /role="status"[^>]*hidden|hidden[^>]*role="status"/, "默认隐藏");
});

test("renderDispatchPage: 空预览（未引用份）→ ready:false＋空态横幅＋确认禁用＋来源显隐", async () => {
  const { store } = await seed();
  const params = new URLSearchParams({ source: "case-set", platforms: "android" });
  const preview = await computeDispatchPreview({ store, env: {}, now: () => NOW }, ROOT, params);
  const formSignature = dispatchFormSignature(params);
  const html = renderDispatchPage({
    rootPath: ROOT,
    rootLabel: "p",
    preview,
    previewId: dispatchPreviewId(preview, formSignature, ROOT),
    formSignature,
    query: {}
  });
  assert.match(html, /"ready":false/, "空引用预览标记");
  assert.match(html, /id="dispatch-empty"/, "空态横幅（③ 卡）");
  assert.match(html, /refField\.hidden=mode==='keyword'/, "来源 radio 联动显隐字段");
  assert.match(html, /预览为空：先选择用例集或输入关键词/, "点击拦截文案区分空/过期");
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

test("renderDispatchPage: 角色 scope 关闭派发时禁用提交", async () => {
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
    capabilities: {
      actions: true,
      usage: true,
      mode: "http",
      role: "viewer",
      scopes: { dispatch: false }
    }
  });
  assert.match(html, /disabled title="写动作未启用"/);
  assert.ok(!html.includes('id="dispatch-submit"'), "scope 关闭不渲染可点提交");
});

test("computeDispatchPreview: 目标主机未登记项目时仍从 owner store 读 case set", async () => {
  const store = new MemoryStore();
  const rootPath = "/w/owner-project";
  await store.upsertHost({ id: "host-a", hostname: "host-a" });
  await store.upsertHost({ id: "host-b", hostname: "host-b" });
  const owner = store.scopeHost("host-a");
  await owner.upsertProject({ rootPath, name: "owner", hostId: "host-a" });
  await owner.recordCaseSet({
    rootPath,
    source: "pen:owner.pen",
    basename: "owner 回归",
    features: [
      {
        key: "login",
        name: "登录",
        caseCount: 2,
        screens: [],
        jsonPath: "/x/a.json",
        mdPath: "/x/a.md",
        xlsxPath: "/x/a.xlsx"
      }
    ]
  });

  const preview = await computeDispatchPreview(
    {
      store,
      env: {},
      storeForHost: (hostId) => store.scopeHost(hostId)
    },
    rootPath,
    new URLSearchParams({ host: "host-b" })
  );

  assert.equal(preview.hostBlocked, true, "目标主机不能执行套件");
  assert.match(preview.warnings.join(" "), /未登记项目/);
  assert.equal(preview.setOptions.length, 1, "来源仍可见");
  assert.equal(preview.setOptions[0].label, "owner 回归");
  assert.deepEqual(preview.sourceStore, {
    tier: "owner",
    hostId: "host-a",
    error: null
  });

  const html = renderDispatchPage({
    rootPath,
    rootLabel: "owner",
    preview,
    query: {}
  });
  assert.match(html, /owner 回归/, "来源渲染可见");
  assert.doesNotMatch(html, /<select name="ref"[^>]*disabled/, "来源下拉不因目标主机未登记而禁用");
  assert.match(html, /来源仍可查看/, "说明该主机不能执行但来源可见");
});

test("computeDispatchPreview: owner 来源读取失败显式示因，不伪装成空", async () => {
  const store = new MemoryStore();
  const rootPath = "/w/owner-failure";
  await store.upsertHost({ id: "host-a", hostname: "host-a" });
  await store.upsertHost({ id: "host-b", hostname: "host-b" });
  const owner = store.scopeHost("host-a");
  await owner.upsertProject({ rootPath, name: "owner", hostId: "host-a" });
  const failing = new Proxy(owner, {
    get(target, property, receiver) {
      if (property === "listCaseSets") {
        return async () => {
          throw new Error("store down");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });

  const preview = await computeDispatchPreview(
    {
      store,
      env: {},
      storeForHost: (hostId) => (hostId === "host-a" ? failing : store.scopeHost(hostId))
    },
    rootPath,
    new URLSearchParams({ host: "host-b" })
  );

  assert.deepEqual(preview.setOptions, []);
  assert.match(preview.warnings.join(" "), /来源读取失败/);
  assert.equal(preview.sourceStore.tier, "owner");
  assert.equal(preview.sourceStore.error, "source-read-failed");
});

test("dispatch preview: 可选安装包并进入表单/签名", async () => {
  const { store, setA } = await seed();
  const pkg = await store.createWebAsset({
    rootPath: ROOT,
    kind: "package",
    filename: "app-release.apk",
    sha256: "a".repeat(64),
    size: 1234,
    storagePath: "/w/p/.artemis/web/assets/package/app.apk"
  });
  const params = new URLSearchParams({
    source: "case-set",
    ref: setA.id,
    platforms: "android",
    appAssetId: pkg.id
  });
  const preview = await computeDispatchPreview({ store, env: {} }, ROOT, params);
  assert.equal(preview.appAssetId, pkg.id);
  assert.equal(preview.appPackages.length, 1);
  assert.equal(preview.appPackages[0].filename, "app-release.apk");
  const html = renderDispatchPage({
    rootPath: ROOT,
    rootLabel: "p",
    preview,
    previewId: dispatchPreviewId(preview, dispatchFormSignature(params), ROOT),
    formSignature: dispatchFormSignature(params),
    query: Object.fromEntries(params)
  });
  assert.match(html, /name="appAssetId"/);
  assert.match(html, /app-release\.apk/);
  assert.match(html, /执行机在跑用例前安装/);
  assert.match(dispatchFormSignature(params), new RegExp(pkg.id));
});

test("dispatch preview: 未知安装包给警告且不选中", async () => {
  const { store, setA } = await seed();
  const params = new URLSearchParams({
    source: "case-set",
    ref: setA.id,
    appAssetId: "missing-asset"
  });
  const preview = await computeDispatchPreview({ store, env: {} }, ROOT, params);
  assert.equal(preview.appAssetId, null);
  assert.match(preview.warnings.join(" "), /安装包不存在|安装包.*已删除/);
});
