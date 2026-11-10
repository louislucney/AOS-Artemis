import assert from "node:assert/strict";
import test from "node:test";

import { runStructuredIosCase } from "../dist/ios/structured-runner.js";

function node(id, label, value, x, y) {
  return { id, label, value, type: "Button", rect: { x, y, width: 120, height: 44 } };
}

function fakeDevice(initial, onAction = () => initial) {
  let nodes = initial;
  const calls = [];
  return {
    calls,
    serial: "sim-1",
    platform: "ios",
    capabilities: { back: "none" },
    async size() {
      return { width: 402, height: 874 };
    },
    async nodes() {
      return nodes;
    },
    async tap(x, y) {
      calls.push({ action: "tap", x, y });
      nodes = onAction(x, y, nodes);
    },
    async inputText(text, at) {
      calls.push({ action: "type", text, at });
      nodes = nodes.map((entry) =>
        entry.id === "search" ? { ...entry, value: text } : entry
      );
    },
    async swipe() {},
    async launch() {},
    async terminate() {
      return true;
    },
    async openUrl() {},
    async screenshot() {
      return Buffer.from("");
    },
    async handleAlerts() {
      return { handled: 0, tapped: [] };
    }
  };
}

test("ios structured runner: tap → expect、type 中文、wait", async () => {
  const screens = {
    login: [node("login_button", "登录", "", 20, 200)],
    home: [node("home_title", "首页", "首页", 20, 40), node("search_entry", "搜索", "", 20, 120)],
    search: [node("search", "搜索", "搜索", 10, 60)]
  };
  let current = "login";
  const calls = [];
  const device = {
    calls,
    serial: "sim-1",
    platform: "ios",
    capabilities: { back: "none" },
    async size() {
      return { width: 402, height: 874 };
    },
    async nodes() {
      return screens[current];
    },
    async tap(x, y) {
      calls.push({ action: "tap", x, y });
      if (current === "login" && x === 80 && y === 222) current = "home";
      else if (current === "home" && x === 80 && y === 142) current = "search";
    },
    async inputText(text) {
      calls.push({ action: "type", text });
      screens.search = [{ ...screens.search[0], value: text }];
    },
    async swipe() {},
    async launch() {},
    async terminate() {
      return true;
    },
    async openUrl() {},
    async screenshot() {
      return Buffer.from("");
    },
    async handleAlerts() {
      return { handled: 0, tapped: [] };
    }
  };

  const result = await runStructuredIosCase({
    device,
    sleep: async () => {},
    actions: [
      {
        stepIndex: 0,
        action: "tap",
        target: { kind: "resource-id", value: "login_button" },
        expect: { screen: "首页", hints: ["首页"] }
      },
      {
        stepIndex: 1,
        action: "tap",
        target: { kind: "text", value: "搜索" },
        expect: { hints: ["搜索"] }
      },
      {
        stepIndex: 2,
        action: "type",
        target: { kind: "resource-id", value: "search" },
        input: { kind: "text", text: "中文测试" },
        expect: { hints: ["中文测试"] }
      },
      {
        stepIndex: 3,
        action: "wait",
        timeoutMs: 10,
        expect: { hints: ["中文测试"] }
      }
    ]
  });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(result.steps.length, 4);
  assert.equal(result.steps[0].resolvedBy, "id");
  assert.ok(device.calls.some((entry) => entry.action === "type" && entry.text === "中文测试"));
});

test("ios structured runner: secretRef 执行期解析并在证据中脱敏", async () => {
  let nodes = [node("search", "搜索", "搜索", 10, 60)];
  const device = {
    serial: "sim-1",
    platform: "ios",
    capabilities: { back: "none" },
    async size() {
      return { width: 402, height: 874 };
    },
    async nodes() {
      return nodes;
    },
    async tap() {},
    async inputText(text) {
      nodes = [{ ...nodes[0], value: text }];
    },
    async swipe() {},
    async launch() {},
    async terminate() {
      return true;
    },
    async openUrl() {},
    async screenshot() {
      return Buffer.from("");
    },
    async handleAlerts() {
      return { handled: 0, tapped: [] };
    }
  };
  const action = {
    stepIndex: 0,
    action: "type",
    target: { kind: "resource-id", value: "search" },
    input: { kind: "secretRef", ref: "pw" },
    expect: { hints: ["s3cret中文"] }
  };
  const result = await runStructuredIosCase({
    device,
    sleep: async () => {},
    resolveSecret: (ref) => (ref === "pw" ? "s3cret中文" : null),
    actions: [action]
  });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(result.steps[0].actual.texts.includes("***"), true);
  assert.equal(JSON.stringify(result.steps[0].actual).includes("s3cret"), false);

  const missing = await runStructuredIosCase({
    device,
    sleep: async () => {},
    actions: [action]
  });
  assert.equal(missing.status, "error");
  assert.match(missing.error, /secret-unresolved:pw/);
});

test("ios structured runner: secretRef 证据脱敏覆盖逐字分隔回显", async () => {
  const secret = "UnicodeSecret123";
  const spaced = secret.split("").join("\u2006");
  let nodes = [node("search", "搜索", "搜索", 10, 60)];
  const device = {
    serial: "sim-1",
    platform: "ios",
    capabilities: { back: "none" },
    async size() {
      return { width: 402, height: 874 };
    },
    async nodes() {
      return nodes;
    },
    async tap() {},
    async inputText() {
      nodes = [{ ...nodes[0], value: spaced }];
    },
    async swipe() {},
    async launch() {},
    async terminate() {
      return true;
    },
    async openUrl() {},
    async screenshot() {
      return Buffer.from("");
    },
    async handleAlerts() {
      return { handled: 0, tapped: [] };
    }
  };
  const result = await runStructuredIosCase({
    device,
    sleep: async () => {},
    resolveSecret: () => secret,
    actions: [
      {
        stepIndex: 0,
        action: "type",
        target: { kind: "text", value: "搜索" },
        input: { kind: "secretRef", ref: "pw" }
      }
    ]
  });
  assert.equal(result.status, "passed", JSON.stringify(result));
  const evidence = JSON.stringify(result.steps[0].actual);
  assert.equal(evidence.includes(secret), false);
  assert.equal(
    evidence.replace(/[\u2000-\u200f\u2028-\u202f\u205f-\u206f\ufeff]/g, "").includes(secret),
    false
  );
  assert.ok(evidence.includes("***"));
});

test("ios structured runner: 目标多候选/缺失/断言失败/不支持动作", async () => {
  const nodes = [
    node("a", "重复", "", 10, 10),
    node("b", "重复", "", 10, 100)
  ];
  const result = await runStructuredIosCase({
    device: fakeDevice(nodes),
    sleep: async () => {},
    actions: [
      {
        stepIndex: 0,
        action: "tap",
        target: { kind: "text", value: "重复" },
        expect: { hints: ["重复"] }
      }
    ]
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /target-ambiguous/);

  const missing = await runStructuredIosCase({
    device: fakeDevice(nodes),
    sleep: async () => {},
    actions: [
      {
        stepIndex: 0,
        action: "tap",
        target: { kind: "resource-id", value: "missing" },
        expect: { hints: ["x"] }
      }
    ]
  });
  assert.equal(missing.status, "failed");
  assert.match(missing.error, /target-not-found/);

  const mismatch = await runStructuredIosCase({
    device: fakeDevice([node("a", "错误页", "", 10, 10)]),
    sleep: async () => {},
    actions: [
      {
        stepIndex: 0,
        action: "tap",
        target: { kind: "text", value: "错误页" },
        expect: { screen: "首页" }
      }
    ]
  });
  assert.equal(mismatch.status, "failed");
  assert.match(mismatch.error, /screen-mismatch/);

  const unsupported = await runStructuredIosCase({
    device: fakeDevice(nodes),
    sleep: async () => {},
    actions: [{ stepIndex: 0, action: "back" }]
  });
  assert.equal(unsupported.status, "error");
  assert.match(unsupported.error, /unsupported-action/);
});
