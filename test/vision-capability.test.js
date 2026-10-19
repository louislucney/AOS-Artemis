import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ChatError } from "../dist/llm/chat.js";
import {
  classifyModalityRejection,
  isVisionCapableModel,
  openVisionCapabilityCache,
  parseDeclaredVision,
  resolveVisionCapability,
  visionCacheTtlMsFromEnv,
  visionCapabilityKey
} from "../dist/llm/vision-capability.js";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-vision-cap-"));
  return path.join(dir, "llm-capabilities.json");
}

const NOW = new Date("2026-10-19T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

test("parseDeclaredVision: 1/true/yes 与 0/false/no，未知值交给启发式", () => {
  assert.equal(parseDeclaredVision({ AOS_LLM_VISION: "1" }), true);
  assert.equal(parseDeclaredVision({ AOS_LLM_VISION: "true" }), true);
  assert.equal(parseDeclaredVision({ AOS_LLM_VISION: "YES" }), true);
  assert.equal(parseDeclaredVision({ AOS_LLM_VISION: "0" }), false);
  assert.equal(parseDeclaredVision({ AOS_LLM_VISION: "false" }), false);
  assert.equal(parseDeclaredVision({ AOS_LLM_VISION: " no " }), false);
  assert.equal(parseDeclaredVision({ AOS_LLM_VISION: "maybe" }), null);
  assert.equal(parseDeclaredVision({}), null);
});

test("visionCacheTtlMsFromEnv: 默认 7 天，0 关闭缓存，非法值回默认", () => {
  assert.equal(visionCacheTtlMsFromEnv({}), 7 * DAY_MS);
  assert.equal(visionCacheTtlMsFromEnv({ AOS_VISION_CACHE_DAYS: "0" }), 0);
  assert.equal(visionCacheTtlMsFromEnv({ AOS_VISION_CACHE_DAYS: "3" }), 3 * DAY_MS);
  assert.equal(visionCacheTtlMsFromEnv({ AOS_VISION_CACHE_DAYS: "abc" }), 7 * DAY_MS);
});

test("visionCapabilityKey: baseUrl 尾斜杠/大小写与模型名归一", () => {
  const a = visionCapabilityKey("https://API.DeepSeek.com/v1/", "DeepSeek-Flash");
  const b = visionCapabilityKey("https://api.deepseek.com/v1", "deepseek-flash");
  assert.equal(a, b);
  assert.notEqual(a, visionCapabilityKey("https://api.deepseek.com/v1", "deepseek-v4-pro"));
});

test("resolveVisionCapability: 声明 > 新鲜缓存 > 启发式 > 未知", () => {
  const fresh = { vision: true, checkedAt: NOW.toISOString() };
  const stale = { vision: false, checkedAt: new Date(NOW.getTime() - 8 * DAY_MS).toISOString() };

  const declared = resolveVisionCapability({
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com/v1",
    declared: false,
    cached: fresh,
    now: NOW
  });
  assert.deepEqual(declared, { capable: false, source: "declared" });

  const cachedOverHeuristic = resolveVisionCapability({
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com/v1",
    declared: null,
    cached: { vision: false, checkedAt: NOW.toISOString() },
    now: NOW
  });
  assert.deepEqual(cachedOverHeuristic, { capable: false, source: "cache" });

  const cachedYesForUnknownName = resolveVisionCapability({
    model: "my-gateway-model",
    baseUrl: "https://gw.example.com/v1",
    declared: null,
    cached: fresh,
    now: NOW
  });
  assert.deepEqual(cachedYesForUnknownName, { capable: true, source: "cache" });

  const heuristic = resolveVisionCapability({
    model: "qwen-vl-max",
    baseUrl: null,
    declared: null,
    cached: null,
    now: NOW
  });
  assert.deepEqual(heuristic, { capable: true, source: "heuristic" });

  const staleFallsThrough = resolveVisionCapability({
    model: "my-gateway-model",
    baseUrl: "https://gw.example.com/v1",
    declared: null,
    cached: stale,
    now: NOW
  });
  assert.deepEqual(staleFallsThrough, { capable: "unknown", source: "unknown" });

  const cacheDisabled = resolveVisionCapability({
    model: "my-gateway-model",
    baseUrl: "https://gw.example.com/v1",
    declared: null,
    cached: { vision: true, checkedAt: NOW.toISOString() },
    now: NOW,
    ttlMs: 0
  });
  assert.deepEqual(cacheDisabled, { capable: "unknown", source: "unknown" });
});

test("classifyModalityRejection: 只认「不支持图片」一类错误", () => {
  const rejection = classifyModalityRejection(
    new ChatError("LLM 响应 HTTP 400", {
      status: 400,
      body: '{"error":{"message":"This model does not support image"}}'
    })
  );
  assert.ok(rejection, "DeepSeek 文案应命中");

  assert.ok(
    classifyModalityRejection(
      new ChatError("LLM 响应 HTTP 400", {
        status: 400,
        body: '{"error":{"message":"Invalid content type. image_url is only supported by certain models."}}'
      })
    ),
    "OpenAI 文案应命中"
  );

  assert.equal(
    classifyModalityRejection(new ChatError("LLM 响应 HTTP 401", { status: 401, body: "invalid api key" })),
    null
  );
  assert.equal(
    classifyModalityRejection(new ChatError("LLM 响应 HTTP 500", { status: 500, body: "server error" })),
    null
  );
  assert.equal(
    classifyModalityRejection(
      new ChatError("LLM 响应 HTTP 400", { status: 400, body: "invalid image format: expected png" })
    ),
    null,
    "「格式错误」不是「不支持图片」，不能写死模型能力"
  );
  assert.equal(classifyModalityRejection(new Error("network down")), null);
  assert.equal(classifyModalityRejection(null), null);
});

test("vision capability cache: 落盘、跨实例读取、坏文件容错", () => {
  const file = tmpFile();
  const first = openVisionCapabilityCache(file);
  assert.equal(first.get("k"), null);
  first.set("k", true, NOW);
  assert.ok(fs.existsSync(file));
  const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.entries.k.vision, true);
  assert.equal(raw.entries.k.checkedAt, NOW.toISOString());

  const second = openVisionCapabilityCache(file);
  assert.deepEqual(second.get("k"), { vision: true, checkedAt: NOW.toISOString() });
  second.set("k", false, NOW);
  assert.equal(openVisionCapabilityCache(file).get("k").vision, false);

  fs.writeFileSync(file, "{not json", "utf-8");
  const tolerant = openVisionCapabilityCache(file);
  assert.equal(tolerant.get("k"), null);
  tolerant.set("k", true, NOW);
  assert.equal(openVisionCapabilityCache(file).get("k").vision, true, "坏文件可被覆盖重写");
});

test("isVisionCapableModel: 从设计侧迁移后行为不变", () => {
  assert.equal(isVisionCapableModel("deepseek-flash"), true);
  assert.equal(isVisionCapableModel("qwen2.5-vl-72b-instruct"), true);
  assert.equal(isVisionCapableModel("deepseek-v4-pro"), false);
  assert.equal(isVisionCapableModel(""), false);
});
