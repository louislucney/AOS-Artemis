import assert from "node:assert/strict";
import test from "node:test";

import { applyIdentity, assignCaseFeature, nameFeatures, splitFeatures } from "../dist/figma/features.js";

test("splitFeatures: 按页面分组（signal=page）", () => {
  const groups = splitFeatures({
    screens: [
      { name: "登录-输入", page: "登录" },
      { name: "登录-验证", page: "登录" },
      { name: "首页", page: "主流程" },
      { name: "详情", page: "主流程" }
    ],
    edges: []
  });
  assert.equal(groups.length, 2);
  const byCandidate = new Map(groups.map((group) => [group.candidateName, group]));
  assert.equal(byCandidate.get("登录").signal, "page");
  assert.deepEqual(byCandidate.get("登录").screens, ["登录-输入", "登录-验证"]);
  assert.equal(byCandidate.get("主流程").signal, "page");
  assert.deepEqual(byCandidate.get("主流程").screens, ["详情", "首页"]);
});

test("splitFeatures: 无页面时按屏幕名前缀归并", () => {
  const groups = splitFeatures({
    screens: [{ name: "登录-输入" }, { name: "登录-验证" }, { name: "首页" }],
    edges: []
  });
  assert.equal(groups.length, 2);
  const login = groups.find((group) => group.candidateName === "登录");
  assert.equal(login.signal, "name-prefix");
  assert.deepEqual(login.screens, ["登录-输入", "登录-验证"]);
  const home = groups.find((group) => group.screens.includes("首页"));
  assert.equal(home.signal, "cluster");
  assert.equal(home.candidateName, null);
});

test("splitFeatures: 前缀未覆盖屏幕按边邻居多数归并", () => {
  const groups = splitFeatures({
    screens: [
      { name: "登录-输入" },
      { name: "登录-验证" },
      { name: "首页-列表" },
      { name: "首页-详情" },
      { name: "订单" }
    ],
    edges: [
      { from: "订单", to: "登录-输入" },
      { from: "订单", to: "登录-验证" },
      { from: "订单", to: "首页-列表" }
    ]
  });
  assert.equal(groups.length, 2);
  const login = groups.find((group) => group.candidateName === "登录");
  const home = groups.find((group) => group.candidateName === "首页");
  assert.deepEqual(login.screens, ["登录-输入", "登录-验证", "订单"]);
  assert.deepEqual(home.screens, ["首页-列表", "首页-详情"]);
});

test("splitFeatures: 无页面无前缀按连通分量", () => {
  const groups = splitFeatures({
    screens: [{ name: "甲" }, { name: "乙" }, { name: "丙" }, { name: "丁" }],
    edges: [
      { from: "甲", to: "乙" },
      { from: "丙", to: "丁" }
    ]
  });
  assert.equal(groups.length, 2);
  assert.ok(groups.every((group) => group.signal === "cluster" && group.candidateName === null));
  const sets = groups.map((group) => [...group.screens].sort().join(",")).sort();
  assert.deepEqual(sets, ["丁,丙", "乙,甲"]);
});

test("splitFeatures: 单屏回退单组、空图返回空数组", () => {
  const single = splitFeatures({ screens: [{ name: "首页" }], edges: [] });
  assert.equal(single.length, 1);
  assert.equal(single[0].signal, "fallback");
  assert.deepEqual(single[0].screens, ["首页"]);
  assert.deepEqual(splitFeatures({ screens: [], edges: [] }), []);
});

function featureGroup(candidateName, screens) {
  return {
    key: "",
    name: "",
    screens,
    signal: candidateName ? "name-prefix" : "cluster",
    candidateName
  };
}

test("nameFeatures: 有候选名直接用（不调用 chat）", async () => {
  let calls = 0;
  const result = await nameFeatures([featureGroup("登录", ["登录-输入", "登录-验证"])], {
    chat: async () => {
      calls += 1;
      return '{"name":"不该被用"}';
    }
  });
  assert.equal(calls, 0);
  assert.equal(result.groups[0].name, "登录");
  assert.equal(result.warnings.length, 0);
});

test("nameFeatures: 无候选名走 LLM（fake 返回 JSON）", async () => {
  const result = await nameFeatures([featureGroup(null, ["甲", "乙"])], {
    chat: async () => '{"name":"订单流程"}'
  });
  assert.equal(result.groups[0].name, "订单流程");
  assert.equal(result.warnings.length, 0);
});

test("nameFeatures: LLM 坏 JSON 回退 功能N 并告警（按组序号编号）", async () => {
  const result = await nameFeatures(
    [featureGroup("甲", ["甲"]), featureGroup(null, ["登录-输入"])],
    { chat: async () => "不是 JSON" }
  );
  const fallback = result.groups.find((group) => group.name.startsWith("功能"));
  assert.equal(fallback.name, "功能2");
  assert.equal(result.warnings[0].code, "feature-naming-fallback");
});

test("nameFeatures: 名称清洗（引号/换行/超长截断）", async () => {
  const candidate = await nameFeatures([featureGroup('"登\n录流程超长名称测试超过十六个字符啦"', ["x"])], {});
  assert.equal(candidate.groups[0].name, "登录流程超长名称测试超过十六个字");
  const llm = await nameFeatures([featureGroup(null, ["x"])], {
    chat: async () => '{"name":"非常非常非常长的功能名称超出八字"}'
  });
  assert.equal(llm.groups[0].name, "非常非常非常长的");
});

test("nameFeatures: chat 抛错不阻断", async () => {
  const result = await nameFeatures([featureGroup(null, ["x"])], {
    chat: async () => {
      throw new Error("boom");
    }
  });
  assert.equal(result.groups[0].name, "功能1");
  assert.equal(result.warnings[0].code, "feature-naming-fallback");
});

function namedGroup(name, screens, key = "") {
  return { key, name, screens, signal: "name-prefix", candidateName: name };
}

test("applyIdentity: 重叠 ≥0.5 继承 key 与名（名称冻结）", () => {
  const result = applyIdentity(
    [namedGroup("登录流程", ["登录-输入", "登录-验证"])],
    [{ key: "f-login-aaaa1111", name: "登录", screens: ["登录-输入", "登录-验证", "登录-找回"] }]
  );
  assert.equal(result.groups[0].key, "f-login-aaaa1111");
  assert.equal(result.groups[0].name, "登录");
  assert.equal(result.warnings.length, 0);
});

test("applyIdentity: 无匹配生成新 key 并告警", () => {
  const result = applyIdentity(
    [namedGroup("支付流程", ["支付-确认", "支付-结果"])],
    [{ key: "f-login-aaaa1111", name: "登录", screens: ["登录-输入"] }]
  );
  assert.match(result.groups[0].key, /^f-支付流程-[0-9a-f]{8}$/);
  assert.equal(result.warnings[0].code, "feature-identity-new");
});

test("applyIdentity: 并列最高不合并（新 key）", () => {
  const result = applyIdentity(
    [namedGroup("流程A", ["甲", "乙"])],
    [
      { key: "f-a-11111111", name: "甲组", screens: ["甲", "乙"] },
      { key: "f-b-22222222", name: "乙组", screens: ["甲", "乙"] }
    ]
  );
  assert.notEqual(result.groups[0].key, "f-a-11111111");
  assert.notEqual(result.groups[0].key, "f-b-22222222");
  assert.equal(result.warnings[0].code, "feature-identity-new");
});

test("applyIdentity: 同一 prior 不被两组重复继承", () => {
  const result = applyIdentity(
    [namedGroup("甲流程", ["甲", "乙"]), namedGroup("乙流程", ["乙", "丙"])],
    [{ key: "f-shared-33333333", name: "共享", screens: ["甲", "乙", "丙"] }]
  );
  assert.equal(result.groups[0].key, "f-shared-33333333");
  assert.notEqual(result.groups[1].key, "f-shared-33333333");
  assert.equal(result.warnings[0].code, "feature-identity-new");
});

test("applyIdentity: 同一 key 的重复 prior 不误判并列（取最高重叠）", () => {
  const result = applyIdentity(
    [namedGroup("登录流程", ["登录-输入", "登录-验证"])],
    [
      { key: "f-login-aaaa1111", name: "登录", screens: ["登录-输入", "登录-验证", "登录-找回"] },
      { key: "f-login-aaaa1111", name: "登录", screens: ["登录-输入", "登录-验证"] }
    ]
  );
  assert.equal(result.groups[0].key, "f-login-aaaa1111");
  assert.equal(result.groups[0].name, "登录");
  assert.equal(result.warnings.length, 0);
});

test("splitFeatures: 页面分组下无 page 屏幕按邻居归并、无邻居单独成组", () => {
  const groups = splitFeatures({
    screens: [
      { name: "登录-输入", page: "登录" },
      { name: "登录-验证", page: "登录" },
      { name: "首页", page: "主流程" },
      { name: "详情", page: "主流程" },
      { name: "弹窗-分享" },
      { name: "孤立" }
    ],
    edges: [{ from: "弹窗-分享", to: "登录-输入" }]
  });
  assert.equal(groups.length, 3);
  const login = groups.find((group) => group.candidateName === "登录");
  assert.deepEqual(login.screens, ["弹窗-分享", "登录-输入", "登录-验证"]);
  const standalone = groups.find((group) => group.screens.includes("孤立"));
  assert.equal(standalone.signal, "cluster");
  assert.equal(standalone.candidateName, null);
});

test("assignCaseFeature: 并列决胜仅在并列组内（首屏在次相关组时不越级）", () => {
  const groups = [
    { key: "f-a", name: "A", screens: ["a1"], signal: "cluster", candidateName: null },
    { key: "f-b", name: "B", screens: ["b1", "b2"], signal: "cluster", candidateName: null },
    { key: "f-c", name: "C", screens: ["c1", "c2"], signal: "cluster", candidateName: null }
  ];
  assert.equal(
    assignCaseFeature(["a1", "b1", "b2", "c1", "c2"], groups),
    "f-b",
    "首屏在次相关组时不越级，取并列组字典序首者"
  );
  assert.equal(assignCaseFeature(["c1", "b1", "b2", "c2"], groups), "f-c", "首屏在并列组内取该组");
});

test("assignCaseFeature: 多数归属；并列取首屏；无命中 null", () => {
  const groups = [
    { key: "f-login", name: "登录", screens: ["登录-输入", "登录-验证"], signal: "name-prefix", candidateName: "登录" },
    { key: "f-home", name: "首页", screens: ["首页", "详情"], signal: "name-prefix", candidateName: "首页" }
  ];
  assert.equal(assignCaseFeature(["登录-输入", "登录-验证", "首页"], groups), "f-login");
  assert.equal(assignCaseFeature(["登录-输入", "首页"], groups), "f-login");
  assert.equal(assignCaseFeature(["无关屏"], groups), null);
});
