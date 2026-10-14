import assert from "node:assert/strict";
import test from "node:test";

import { splitFeatures } from "../dist/figma/features.js";

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
