import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { collectLocalImagePaths, mirrorDeviceScreenshots } from "../dist/artemis/artifacts.js";
import { baseConfig, loadTestRuntime, makeTempDir, makeTempProject, StubProxy } from "./helpers.js";

function makeSourceScreenshot(name = "live_screenshot_emulator-5554.jpg") {
  const repo = makeTempDir("aos-artemis-repo-");
  const file = path.join(repo, name);
  fs.writeFileSync(file, Buffer.from("JPEGDATA"));
  return { repo, file };
}

test("collectLocalImagePaths: finds file URIs and bare paths, skips image blocks", () => {
  const result = {
    content: [
      { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      { type: "text", text: "captured" },
      { type: "text", text: JSON.stringify({ path: "file:///tmp/a/live.jpg", other: "x" }) },
      { type: "text", text: "plain file:///tmp/b/shot.png and /tmp/c/notes.txt" }
    ]
  };
  const paths = collectLocalImagePaths(result);
  assert.deepEqual(paths.sort(), ["/tmp/a/live.jpg", "/tmp/b/shot.png"]);
});

test("runtime: mobile_get_device_state results are mirrored into the project", async () => {
  const { repo, file } = makeSourceScreenshot();
  const dir = makeTempProject({ config: baseConfig({ artemis: { repo } }) });

  const proxy = new StubProxy({ running: true });
  proxy.callTool = async () => ({
    content: [{ type: "text", text: `file://${file}` }]
  });
  const { runtime } = await loadTestRuntime(dir, { proxy, baseEnv: {} });

  const result = await runtime.proxy.callTool("mobile_get_device_state", {
    view_type: "screenshot"
  });
  assert.equal(
    result.content[0].text,
    `file://${file}`,
    "the original tool result stays untouched"
  );

  const mirror = path.join(
    dir,
    ".artemis",
    "traces",
    "live_screenshots",
    path.basename(file)
  );
  assert.ok(fs.existsSync(mirror), "mirrored screenshot exists in the project");
  assert.deepEqual(fs.readFileSync(mirror), fs.readFileSync(file));
});

test("runtime: other mobile tools are not mirrored", async () => {
  const { repo, file } = makeSourceScreenshot();
  const dir = makeTempProject({ config: baseConfig({ artemis: { repo } }) });

  const proxy = new StubProxy({ running: true });
  proxy.callTool = async () => ({
    content: [{ type: "text", text: `file://${file}` }]
  });
  const { runtime } = await loadTestRuntime(dir, { proxy, baseEnv: {} });

  await runtime.proxy.callTool("mobile_diagnose", {});
  assert.ok(!fs.existsSync(path.join(dir, ".artemis", "traces", "live_screenshots")));
});

test("mirrorDeviceScreenshots: missing source files and copy failures never throw", () => {
  const dir = makeTempProject({ config: baseConfig() });
  const report = mirrorDeviceScreenshots(baseConfig(), dir, {
    content: [{ type: "text", text: "file:///no/such/live_screenshot_x.jpg" }]
  });
  assert.deepEqual(report.copied, []);
  assert.deepEqual(report.errors, []);
});
