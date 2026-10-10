import assert from "node:assert/strict";
import test from "node:test";

import { croppedScreenshotHash, screenSignature } from "../dist/ios/noop.js";
import { buildHistorySections } from "../dist/ios/task-runner.js";
import { createImage, fillRect, toPng } from "./helpers.js";

function node(type, label, x, y, width, height, id = "") {
  return { type, label, value: "", id, rect: { x, y, width, height } };
}

test("screenSignature：忽略系统状态栏与空节点，内容变化即变化", () => {
  const base = [
    node("StatusBar", "9:41", 0, 0, 402, 50, "status-bar"),
    node("Button", "搜索", 100, 200, 80, 40),
    node("StaticText", "标题", 0, 100, 402, 30)
  ];
  const changedClock = [
    node("StatusBar", "10:41", 0, 0, 402, 50, "status-bar"),
    node("Button", "搜索", 100, 200, 80, 40),
    node("StaticText", "标题", 0, 100, 402, 30)
  ];
  assert.equal(screenSignature(base, 874), screenSignature(changedClock, 874));

  const changedButton = [
    node("StatusBar", "9:41", 0, 0, 402, 50, "status-bar"),
    node("Button", "返回", 100, 200, 80, 40),
    node("StaticText", "标题", 0, 100, 402, 30)
  ];
  assert.notEqual(screenSignature(base, 874), screenSignature(changedButton, 874));

  const topBandOnly = [node("Other", "摄像头", 100, 10, 80, 20, "notch")];
  assert.equal(screenSignature(topBandOnly, 874), screenSignature([], 874));
});

test("croppedScreenshotHash：裁上下系统带；带外变化不影响、带内变化影响", () => {
  const plain = createImage(20, 100);
  const topChanged = createImage(20, 100);
  fillRect(topChanged, 0, 0, 20, 4, [255, 0, 0, 255]);
  const bottomChanged = createImage(20, 100);
  fillRect(bottomChanged, 0, 97, 20, 3, [0, 255, 0, 255]);
  const middleChanged = createImage(20, 100);
  fillRect(middleChanged, 0, 50, 20, 2, [0, 0, 255, 255]);

  const baseHash = croppedScreenshotHash(Buffer.from(toPng(plain)));
  assert.equal(croppedScreenshotHash(Buffer.from(toPng(topChanged))), baseHash);
  assert.equal(croppedScreenshotHash(Buffer.from(toPng(bottomChanged))), baseHash);
  assert.notEqual(croppedScreenshotHash(Buffer.from(toPng(middleChanged))), baseHash);
  assert.equal(croppedScreenshotHash(Buffer.from("not a png")), null);
});

test("buildHistorySections：近期明细 + 更早动作链摘要（跳屏标注与超限压缩）", () => {
  const steps = Array.from({ length: 10 }, (_, index) => ({
    step: index + 1,
    thought: `第${index + 1}步思考。继续`,
    action: "tap",
    params: { x: 1, y: 1 },
    outcome: "ok",
    ...(index === 2 ? { screen: "首页 | 搜索" } : {})
  }));
  const { recent, digest } = buildHistorySections(steps, 4);
  assert.equal(recent.length, 4);
  assert.match(recent[0], /\[7\] 第7步思考/);
  assert.match(digest, /1\) 第1步思考/);
  assert.match(digest, /3\) 第3步思考.*（屏幕: 首页 \| 搜索）/);

  const compacted = buildHistorySections(steps, 4, 80);
  assert.match(compacted.digest, /步略，动作链已压缩/);
});
