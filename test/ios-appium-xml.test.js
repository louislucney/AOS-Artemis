import assert from "node:assert/strict";
import test from "node:test";

import { parsePageSource } from "../dist/ios/appium/xml.js";

const PAGE_SOURCE = `<?xml version="1.0" encoding="UTF-8"?>
<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Settings" label="Settings" x="0" y="0" width="390" height="844" enabled="true" visible="true">
    <XCUIElementTypeWindow x="0" y="0" width="390" height="844">
      <XCUIElementTypeOther x="0" y="0" width="390" height="100">
        <XCUIElementTypeStaticText label="A &amp; B &quot;quoted&quot;" value="v1" x="10" y="20" width="100" height="30"/>
        <XCUIElementTypeButton name="login" label="登录" x="10.5" y="60" width="120" height="44" enabled="true"/>
        <XCUIElementTypeButton identifier="register-btn" label="注册" x="10" y="110" width="120" height="44"/>
        <XCUIElementTypeStaticText label="no geometry"/>
      </XCUIElementTypeOther>
    </XCUIElementTypeWindow>
  </XCUIElementTypeApplication>
</AppiumAUT>`;

test("appium xml: WDA page source 映射为 IosUiNode", () => {
  const nodes = parsePageSource(PAGE_SOURCE);
  assert.ok(nodes);
  assert.deepEqual(
    nodes.map((node) => node.type),
    ["Application", "Window", "Other", "StaticText", "Button", "Button"]
  );
  const application = nodes[0];
  assert.equal(application.id, "Settings");
  assert.deepEqual(application.rect, { x: 0, y: 0, width: 390, height: 844 });

  const text = nodes[3];
  assert.equal(text.label, 'A & B "quoted"');
  assert.equal(text.value, "v1");

  const button = nodes[4];
  assert.equal(button.id, "login");
  assert.equal(button.label, "登录");
  assert.equal(button.rect.x, 10.5);

  const identified = nodes[5];
  assert.equal(identified.id, "register-btn");
});

test("appium xml: 空值与畸形输入返回 null", () => {
  assert.equal(parsePageSource(""), null);
  assert.equal(parsePageSource("   "), null);
  assert.equal(parsePageSource("<a><b></a>"), null);
  assert.equal(parsePageSource(42), null);
});

test("appium xml: 无元素节点时返回空数组", () => {
  assert.deepEqual(parsePageSource("<AppiumAUT></AppiumAUT>"), []);
});
