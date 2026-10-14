import assert from "node:assert/strict";
import test from "node:test";

import { nameFeatures, splitFeatures } from "../dist/figma/features.js";

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
