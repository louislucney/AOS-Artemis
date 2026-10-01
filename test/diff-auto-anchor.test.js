import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { designDeviceDiff } from "../dist/diff/tool.js";
import {
  baseConfig,
  createImage,
  fillRect,
  loadTestRuntime,
  makeTempProject,
  parseToolResult,
  StubProxy,
  stubFigmaFetch,
  toJpeg,
  toPng,
  withFigmaToken
} from "./helpers.js";

function makeAutoProject({ fileKey }) {
  const dir = makeTempProject({ config: baseConfig() });
  const designImage = createImage(390, 844);
  fillRect(designImage, 40, 80, 120, 60, [30, 64, 175, 255]);
  const figma = stubFigmaFetch(toPng(designImage), "1:2", fileKey);
  const postPath = path.join(dir, "step-post.jpg");
  fs.writeFileSync(postPath, toJpeg(createImage(390, 844), 90));
  return { dir, figma, postPath };
}

function stubAuto(proxy, { status, search, screenshots }) {
  proxy.callTool = async (name, args) => {
    proxy.calls.push({ name, args });
    if (name === "mobile_manage_task") {
      return { content: [{ type: "text", text: JSON.stringify(status) }] };
    }
    if (name === "mobile_inspect_trace") {
      if (args.action === "search") {
        return { content: [{ type: "text", text: JSON.stringify(search) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(screenshots) }] };
    }
    return { content: [{ type: "text", text: "{}" }] };
  };
}

const STATUS_WITH_FAILURE = {
  status: "completed",
  test_summary: {
    failed: 1,
    failed_items: [{ item_text: "verify Continue visible", kind: "verify", evidence: "Continue button missing" }]
  }
};

const SEARCH_TWO_HITS = {
  trace_id: "trace-1",
  query: "Continue button missing",
  results:
    "[Step 7 (T+00:12) | id aaa]\n  Screen: Home\n  Match: Continue button missing\n\n[Step 2 (T+00:03) | id bbb]\n  Screen: Home\n  Match: other [Step 99 (T+99:99) | id fake]"
};

const SEARCH_ONE_HIT = {
  trace_id: "trace-1",
  query: "Continue button missing",
  results: "[Step 7 (T+00:12) | id aaa]\n  Screen: Home\n  Match: Continue button missing"
};

function screenshotsPayload(postPath) {
  return {
    trace_id: "trace-1",
    device_serial: "emulator-5554",
    step_number: 7,
    before_screenshot: null,
    after_screenshot: `file://${postPath}`,
    action_overlay_screenshot: null
  };
}

test("design_device_diff: 仅 traceId 时用失败证据检索步骤并记录锚点", async () => {
  await withFigmaToken(async () => {
    const { dir, figma, postPath } = makeAutoProject({ fileKey: "AutoA1" });
    const proxy = new StubProxy({ running: true });
    stubAuto(proxy, {
      status: STATUS_WITH_FAILURE,
      search: SEARCH_TWO_HITS,
      screenshots: screenshotsPayload(postPath)
    });
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const payload = parseToolResult(
        await designDeviceDiff(runtime, {
          design: { figmaUrl: "https://www.figma.com/design/AutoA1/File?node-id=1-2" },
          device: { mode: "step", traceId: "trace-1" }
        })
      );
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.summary.regions, 1);
      assert.equal(payload.anchor.source, "search");
      assert.equal(payload.anchor.query, "Continue button missing");
      assert.equal(payload.anchor.ambiguous, true);
      assert.deepEqual(
        payload.anchor.candidates.map((candidate) => candidate.stepNumber),
        [7, 2]
      );
      assert.match(payload.warnings.join(" "), /多命中|命中 2 个步骤/);

      const report = JSON.parse(fs.readFileSync(payload.saved.report, "utf-8"));
      assert.deepEqual(report.unit.device, {
        mode: "step",
        traceId: "trace-1",
        stepNumber: 7,
        image: "post",
        anchor: "search",
        serial: "emulator-5554"
      });

      const names = proxy.calls.map((call) => `${call.name}:${call.args?.action ?? ""}`);
      assert.deepEqual(names, [
        "mobile_manage_task:status",
        "mobile_inspect_trace:search",
        "mobile_inspect_trace:view_step_screenshots"
      ]);
      const searchCall = proxy.calls.find((call) => call.args?.action === "search");
      assert.equal(searchCall.args.query, "Continue button missing");
      assert.equal(searchCall.args.max_results, 5);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: 唯一命中时不标歧义", async () => {
  await withFigmaToken(async () => {
    const { dir, figma, postPath } = makeAutoProject({ fileKey: "AutoB2" });
    const proxy = new StubProxy({ running: true });
    stubAuto(proxy, {
      status: STATUS_WITH_FAILURE,
      search: SEARCH_ONE_HIT,
      screenshots: screenshotsPayload(postPath)
    });
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const payload = parseToolResult(
        await designDeviceDiff(runtime, {
          design: { figmaUrl: "https://www.figma.com/design/AutoB2/File?node-id=1-2" },
          device: { mode: "step", traceId: "trace-1" }
        })
      );
      assert.equal(payload.ok, true, JSON.stringify(payload));
      assert.equal(payload.anchor.candidates.length, 1);
      assert.equal(payload.anchor.ambiguous, undefined);
      assert.deepEqual(payload.warnings, []);
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: 无失败证据（Flash/通过）时结构化提示", async () => {
  await withFigmaToken(async () => {
    const { dir, figma } = makeAutoProject({ fileKey: "AutoC3" });
    const proxy = new StubProxy({ running: true });
    stubAuto(proxy, { status: { status: "completed" }, search: {}, screenshots: {} });
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(runtime, {
        design: { figmaUrl: "https://www.figma.com/design/AutoC3/File?node-id=1-2" },
        device: { mode: "step", traceId: "trace-1" }
      });
      assert.equal(result.isError, true);
      const error = parseToolResult(result).error;
      assert.match(error, /自动锚点失败/);
      assert.match(error, /没有失败证据/);
      assert.match(error, /stepNumber/);
      assert.deepEqual(
        proxy.calls.map((call) => call.name),
        ["mobile_manage_task"]
      );
      assert.ok(!fs.existsSync(path.join(dir, ".artemis", "design", "diffs")));
    } finally {
      figma.restore();
    }
  });
});

test("design_device_diff: 检索零命中时结构化提示", async () => {
  await withFigmaToken(async () => {
    const { dir, figma } = makeAutoProject({ fileKey: "AutoD4" });
    const proxy = new StubProxy({ running: true });
    stubAuto(proxy, {
      status: STATUS_WITH_FAILURE,
      search: { trace_id: "trace-1", query: "x", results: "no matches here" },
      screenshots: {}
    });
    const { runtime } = await loadTestRuntime(dir, { proxy });
    try {
      const result = await designDeviceDiff(runtime, {
        design: { figmaUrl: "https://www.figma.com/design/AutoD4/File?node-id=1-2" },
        device: { mode: "step", traceId: "trace-1" }
      });
      assert.equal(result.isError, true);
      const error = parseToolResult(result).error;
      assert.match(error, /未检索到/);
      assert.match(error, /no matches here/);
      assert.deepEqual(
        proxy.calls.map((call) => `${call.name}:${call.args?.action ?? ""}`),
        ["mobile_manage_task:status", "mobile_inspect_trace:search"]
      );
    } finally {
      figma.restore();
    }
  });
});
