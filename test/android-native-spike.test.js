import assert from "node:assert/strict";
import test from "node:test";

import {
  base64Text,
  parseUiXml,
  percentile,
  visibleTexts
} from "../scripts/android-native-spike.mjs";

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node text="可见文字" content-desc="可见描述" resource-id="app:id/title" class="android.widget.TextView" visible-to-user="true" bounds="[0,0][500,100]" />
  <node text="屏外文字" content-desc="" resource-id="app:id/offscreen" class="android.widget.TextView" visible-to-user="true" bounds="[0,3000][500,3100]" />
  <node text="不可见文字" content-desc="" resource-id="app:id/hidden" class="android.widget.TextView" visible-to-user="false" bounds="[0,0][500,100]" />
  <node text="中文 &amp; 符号" content-desc="" resource-id="app:id/input" class="android.widget.EditText" visible-to-user="true" bounds="[0,100][500,200]" />
</hierarchy>`;

test("android native spike: 解析 XML 并只保留可见文本", () => {
  const nodes = parseUiXml(XML);
  assert.equal(nodes.length, 4);
  assert.equal(nodes[0].resourceId, "app:id/title");
  assert.equal(nodes[3].text, "中文 & 符号");
  const texts = visibleTexts(nodes, { width: 1080, height: 1920 });
  assert.ok(texts.has("可见文字"));
  assert.ok(texts.has("可见描述"));
  assert.ok(texts.has("中文 & 符号"));
  assert.ok(!texts.has("屏外文字"), "屏外节点不纳入可见文本");
  assert.ok(!texts.has("不可见文字"), "visible-to-user=false 不纳入");
});

test("android native spike: percentile 与 base64 中文输入", () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 5);
  assert.equal(Buffer.from(base64Text("中文测试"), "base64").toString("utf8"), "中文测试");
});
