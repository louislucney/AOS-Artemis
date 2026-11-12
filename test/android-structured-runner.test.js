import assert from "node:assert/strict";
import test from "node:test";

import { runStructuredCase } from "../dist/ios/structured-runner.js";

function node(id, label, value, x, y, type = "android.widget.Button") {
  return { id, label, value, type, rect: { x, y, width: 120, height: 48 } };
}

function fakeDevice(nodes, calls = [], options = {}) {
  let current = nodes;
  const updateId = options.updateId ?? "search";
  const mask = options.mask === true;
  return {
    serial: "android-1",
    platform: "android",
    capabilities: { back: "keyevent" },
    calls,
    async size() {
      return { width: 1080, height: 2400 };
    },
    async nodes() {
      return current;
    },
    async tap(x, y) {
      calls.push({ action: "tap", x, y });
    },
    async inputText(text) {
      calls.push({ action: "type", text });
      current = current.map((entry) =>
        entry.id === updateId ? { ...entry, value: mask ? "•••" : text } : entry
      );
    },
    async clearText(length) {
      calls.push({ action: "clear", length });
      current = current.map((entry) =>
        entry.id === updateId ? { ...entry, value: "" } : entry
      );
    },
    async hideKeyboard() {
      calls.push({ action: "hide-keyboard" });
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

test("android structured runner: tap/type + expect 与 iOS 共用同一套断言", async () => {
  const calls = [];
  const device = fakeDevice(
    [node("search", "搜索", "搜索", 20, 100, "android.widget.EditText")],
    calls
  );
  const result = await runStructuredCase({
    device,
    sleep: async () => {},
    actions: [
      {
        stepIndex: 0,
        action: "type",
        target: { kind: "text", value: "搜索" },
        input: { kind: "text", text: "中文测试" },
        expect: { hints: ["中文测试"] }
      }
    ]
  });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(result.steps[0].resolvedBy, "value");
  assert.ok(calls.some((entry) => entry.action === "type" && entry.text === "中文测试"));
});

test("android structured runner: 目标多候选/缺失/断言失败/不支持动作", async () => {
  const nodes = [node("a", "重复", "", 10, 10), node("b", "重复", "", 10, 100)];
  const ambiguous = await runStructuredCase({
    device: fakeDevice(nodes),
    sleep: async () => {},
    actions: [{ stepIndex: 0, action: "tap", target: { kind: "text", value: "重复" }, expect: { hints: ["重复"] } }]
  });
  assert.equal(ambiguous.status, "failed");
  assert.match(ambiguous.error, /target-ambiguous/);

  const missing = await runStructuredCase({
    device: fakeDevice(nodes),
    sleep: async () => {},
    actions: [{ stepIndex: 0, action: "tap", target: { kind: "resource-id", value: "missing" }, expect: { hints: ["x"] } }]
  });
  assert.equal(missing.status, "failed");
  assert.match(missing.error, /target-not-found/);

  const mismatch = await runStructuredCase({
    device: fakeDevice([node("a", "错误页", "", 10, 10)]),
    sleep: async () => {},
    actions: [{ stepIndex: 0, action: "tap", target: { kind: "text", value: "错误页" }, expect: { screen: "首页" } }]
  });
  assert.equal(mismatch.status, "failed");
  assert.match(mismatch.error, /screen-mismatch/);

  const unsupported = await runStructuredCase({
    device: fakeDevice(nodes),
    sleep: async () => {},
    actions: [{ stepIndex: 0, action: "back" }]
  });
  assert.equal(unsupported.status, "error");
  assert.match(unsupported.error, /unsupported-action/);
});

test("android structured runner: secretRef 执行期解析并脱敏", async () => {
  const device = fakeDevice([
    node("search", "搜索", "搜索", 20, 100, "android.widget.EditText")
  ]);
  const action = {
    stepIndex: 0,
    action: "type",
    target: { kind: "text", value: "搜索" },
    input: { kind: "secretRef", ref: "pw" },
    expect: { hints: ["s3cret"] }
  };
  const result = await runStructuredCase({
    device,
    sleep: async () => {},
    resolveSecret: (ref) => (ref === "pw" ? "s3cret" : null),
    actions: [action]
  });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(JSON.stringify(result.steps[0].actual).includes("s3cret"), false);
  assert.ok(JSON.stringify(result.steps[0].actual).includes("***"));

  const missing = await runStructuredCase({
    device,
    sleep: async () => {},
    actions: [action]
  });
  assert.equal(missing.status, "error");
  assert.match(missing.error, /secret-unresolved:pw/);
});

test("field map: secretRef 无 target → 按 alias 定位并回读校验", async () => {
  const calls = [];
  const device = fakeDevice(
    [
      node("title", "注册", "", 0, 0, "android.widget.TextView"),
      node("email", "", "", 20, 100, "android.widget.EditText")
    ],
    calls,
    { updateId: "email" }
  );
  const result = await runStructuredCase({
    device,
    sleep: async () => {},
    resolveSecretField: (ref) =>
      ref === "reg_email"
        ? {
            value: "qa@example.com",
            kind: "account",
            target: { kind: "resource-id", value: "email" },
            screen: "注册"
          }
        : null,
    actions: [
      { stepIndex: 0, action: "type", input: { kind: "secretRef", ref: "reg_email" } }
    ]
  });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(result.steps[0].verified, "ok");
  assert.ok(calls.some((entry) => entry.action === "type" && entry.text === "qa@example.com"));
});

test("field map: 输入框值不一致 → field-mismatch；屏幕不符 → field-screen-mismatch", async () => {
  const mismatch = await runStructuredCase({
    device: fakeDevice(
      [
        node("title", "注册", "", 0, 0, "android.widget.TextView"),
        node("email", "", "", 20, 100, "android.widget.EditText")
      ],
      [],
      { updateId: "none" }
    ),
    sleep: async () => {},
    resolveSecretField: () => ({
      value: "qa@example.com",
      kind: "account",
      target: { kind: "resource-id", value: "email" }
    }),
    actions: [
      {
        stepIndex: 0,
        action: "type",
        timeoutMs: 50,
        input: { kind: "secretRef", ref: "reg_email" }
      }
    ]
  });
  assert.equal(mismatch.status, "failed", JSON.stringify(mismatch));
  assert.match(mismatch.error, /field-mismatch:reg_email/);
  assert.equal(mismatch.steps[0].verified, "mismatch");

  const screenMismatch = await runStructuredCase({
    device: fakeDevice([node("email", "", "", 20, 100, "android.widget.EditText")], [], {
      updateId: "email"
    }),
    sleep: async () => {},
    resolveSecretField: () => ({
      value: "qa@example.com",
      kind: "account",
      target: { kind: "resource-id", value: "email" },
      screen: "注册"
    }),
    actions: [
      { stepIndex: 0, action: "type", input: { kind: "secretRef", ref: "reg_email" } }
    ]
  });
  assert.equal(screenMismatch.status, "failed");
  assert.match(screenMismatch.error, /field-screen-mismatch:注册/);
});

test("field map: 密码字段跳过回读；缺映射 target → target-not-found", async () => {
  const password = await runStructuredCase({
    device: fakeDevice([node("pw", "", "", 20, 100, "android.widget.EditText")], [], {
      updateId: "pw",
      mask: true
    }),
    sleep: async () => {},
    resolveSecretField: () => ({
      value: "Secret@123",
      kind: "password",
      target: { kind: "resource-id", value: "pw" }
    }),
    actions: [{ stepIndex: 0, action: "type", input: { kind: "secretRef", ref: "reg_password" } }]
  });
  assert.equal(password.status, "passed", JSON.stringify(password));
  assert.equal(password.steps[0].verified, "skipped");

  const missing = await runStructuredCase({
    device: fakeDevice([node("email", "", "", 20, 100, "android.widget.EditText")]),
    sleep: async () => {},
    resolveSecretField: () => ({ value: "qa@example.com", kind: "account" }),
    actions: [{ stepIndex: 0, action: "type", input: { kind: "secretRef", ref: "reg_email" } }]
  });
  assert.equal(missing.status, "failed");
  assert.match(missing.error, /target-not-found/);
});

test("keyboard: secretRef 默认先清空并收键盘；text 默认不清空；可显式关闭", async () => {
  const calls = [];
  const device = fakeDevice(
    [node("email", "", "old@example.com", 20, 100, "android.widget.EditText")],
    calls,
    { updateId: "email" }
  );
  const result = await runStructuredCase({
    device,
    sleep: async () => {},
    resolveSecret: () => "new@example.com",
    actions: [
      {
        stepIndex: 0,
        action: "type",
        target: { kind: "resource-id", value: "email" },
        input: { kind: "secretRef", ref: "email" }
      }
    ]
  });
  assert.equal(result.status, "passed", JSON.stringify(result));
  assert.equal(
    calls.filter((entry) => entry.action === "tap").length,
    1,
    "不再重复点击输入框"
  );
  assert.ok(
    calls.some((entry) => entry.action === "clear" && entry.length === "old@example.com".length),
    "secretRef 默认按现有值长度清空"
  );
  assert.ok(calls.some((entry) => entry.action === "hide-keyboard"), "输入后收键盘");

  const textCalls = [];
  await runStructuredCase({
    device: fakeDevice([node("email", "", "", 20, 100, "android.widget.EditText")], textCalls, {
      updateId: "email"
    }),
    sleep: async () => {},
    actions: [
      {
        stepIndex: 0,
        action: "type",
        target: { kind: "resource-id", value: "email" },
        input: { kind: "text", text: "plain" }
      }
    ]
  });
  assert.equal(textCalls.some((entry) => entry.action === "clear"), false, "text 默认不清空");

  const noHideCalls = [];
  await runStructuredCase({
    device: fakeDevice([node("email", "", "", 20, 100, "android.widget.EditText")], noHideCalls, {
      updateId: "email"
    }),
    sleep: async () => {},
    actions: [
      {
        stepIndex: 0,
        action: "type",
        target: { kind: "resource-id", value: "email" },
        input: { kind: "text", text: "plain" },
        hideKeyboard: false
      }
    ]
  });
  assert.equal(noHideCalls.some((entry) => entry.action === "hide-keyboard"), false);
});

test("android structured runner: uiautomator XML 解析 resource-id/class/bounds", async () => {
  const { parseAndroidUiNodes } = await import("../dist/device/android-actions.js");
  const nodes = parseAndroidUiNodes(
    '<hierarchy><node class="android.widget.EditText" resource-id="com.example:id/q" text="搜索" content-desc="desc" bounds="[10,20][110,80]" /></hierarchy>'
  );
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, "android.widget.EditText");
  assert.equal(nodes[0].id, "com.example:id/q");
  assert.equal(nodes[0].label, "搜索");
  assert.deepEqual(nodes[0].rect, { x: 10, y: 20, width: 100, height: 60 });
});
