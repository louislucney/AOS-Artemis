import assert from "node:assert/strict";
import test from "node:test";

import { looksVisionCapable, pngDimensions, resolveVisionTarget, visionAlwaysEnabled } from "../dist/ios/vision.js";
import { createImage, toJpeg, toPng } from "./helpers.js";

const PNG_BYTES = Buffer.from(toPng(createImage(4, 4)));
const JPG_BYTES = Buffer.from(toJpeg(createImage(4, 4)));

function entry(overrides = {}) {
  return {
    name: "vision-entry",
    provider: "custom",
    model: "qwen-vl-max",
    baseUrl: "https://vision.example.com/v1",
    apiKey: "vk",
    keyEnvName: null,
    fallback: null,
    nodeOverrides: null,
    source: "store",
    isActive: false,
    ...overrides
  };
}

test("looksVisionCapable: 常见多模态命名命中，纯文本不命中", () => {
  assert.equal(looksVisionCapable("qwen-vl-max"), true);
  assert.equal(looksVisionCapable("gpt-4o"), true);
  assert.equal(looksVisionCapable("gemini-2.5-pro"), true);
  assert.equal(looksVisionCapable("claude-3-5-sonnet"), true);
  assert.equal(looksVisionCapable("deepseek-flash"), false);
  assert.equal(looksVisionCapable("deepseek-chat"), false);
  assert.equal(looksVisionCapable("kimi-k2"), false);
});

test("resolveVisionTarget: 指定条目名优先且要求完整", () => {
  const target = resolveVisionTarget({ AOS_IOS_VISION_LLM: "vision-entry" }, [entry()], null);
  assert.deepEqual(target, {
    chat: { baseUrl: "https://vision.example.com/v1", apiKey: "vk", model: "qwen-vl-max" },
    model: "qwen-vl-max",
    source: "entry"
  });
  assert.equal(
    resolveVisionTarget({ AOS_IOS_VISION_LLM: "vision-entry" }, [entry({ apiKey: null })], entry()),
    null
  );
  assert.equal(resolveVisionTarget({ AOS_IOS_VISION_LLM: "missing" }, [entry()], null), null);
});

test("resolveVisionTarget: env 模型覆盖，可用显式或 active 凭证", () => {
  const explicit = resolveVisionTarget(
    {
      AOS_IOS_VISION_MODEL: "my-vl",
      AOS_IOS_VISION_BASE_URL: "https://v.example.com/v1",
      AOS_IOS_VISION_API_KEY: "k2"
    },
    [],
    null
  );
  assert.deepEqual(explicit, {
    chat: { baseUrl: "https://v.example.com/v1", apiKey: "k2", model: "my-vl" },
    model: "my-vl",
    source: "env"
  });

  const inherited = resolveVisionTarget(
    { AOS_IOS_VISION_MODEL: "my-vl" },
    [],
    entry({ name: "active", model: "deepseek-flash", apiKey: "ak", baseUrl: "https://a.example.com/v1" })
  );
  assert.deepEqual(inherited.chat, { baseUrl: "https://a.example.com/v1", apiKey: "ak", model: "my-vl" });

  assert.equal(resolveVisionTarget({ AOS_IOS_VISION_MODEL: "my-vl" }, [], null), null);
});

test("resolveVisionTarget: active 本身多模态时直接复用", () => {
  const target = resolveVisionTarget({}, [], entry({ model: "qwen-vl-max", source: "env" }));
  assert.equal(target.source, "active");
  assert.equal(resolveVisionTarget({}, [], entry({ model: "deepseek-flash", source: "env" })), null);
  assert.equal(resolveVisionTarget({}, [], null), null);
});

test("visionAlwaysEnabled: 1/true/yes 开启", () => {
  assert.equal(visionAlwaysEnabled({ AOS_IOS_VISION_ALWAYS: "1" }), true);
  assert.equal(visionAlwaysEnabled({ AOS_IOS_VISION_ALWAYS: "true" }), true);
  assert.equal(visionAlwaysEnabled({ AOS_IOS_VISION_ALWAYS: "yes" }), true);
  assert.equal(visionAlwaysEnabled({ AOS_IOS_VISION_ALWAYS: "0" }), false);
  assert.equal(visionAlwaysEnabled({}), false);
});

test("pngDimensions: 解析 IHDR 宽高，非 PNG 返回 null", () => {
  assert.deepEqual(pngDimensions(PNG_BYTES), { width: 4, height: 4 });
  assert.equal(pngDimensions(JPG_BYTES), null);
  assert.equal(pngDimensions(Buffer.from("tiny")), null);
});
