import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handleArtifactRequest } from "../dist/panel/artifact-route.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "aos-artifact-route-"));
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: root, name: "p" });
  const deps = { store, env: {} };
  const dir = join(root, ".artemis", "design", "diffs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(dir, "raw.bin"), Buffer.from([0x00, 0x01, 0x02]));
  await writeFile(
    join(dir, "api-errors.json"),
    JSON.stringify({ traceId: "t-1", errors: [{ code: "E1" }], ok: true, count: 1, nil: null }),
    "utf8"
  );
  await writeFile(join(dir, "broken.json"), "{not json", "utf8");
  await writeFile(
    join(dir, "stderr.log"),
    "INFO start\nWARN slow response\nERROR failed to tap\nat handler.js:1\n",
    "utf8"
  );
  await writeFile(join(root, "aos.config.jsonc"), "{}", "utf8");
  return { root, deps };
}

function url(root, relPath) {
  return new URL(
    `http://x/panel/artifact?project=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`
  );
}

test("artifact route: .artemis 内白名单文件可读（正确 content-type）", async () => {
  const { root, deps } = await setup();
  try {
    const response = await handleArtifactRequest(url(root, ".artemis/design/diffs/shot.png"), deps);
    assert.equal(response.status, 200);
    assert.equal(response.contentType, "image/png");
    assert.ok(Buffer.isBuffer(response.body));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact route: JSON 在浏览器 Accept 下渲染语法高亮查看器", async () => {
  const { root, deps } = await setup();
  try {
    const response = await handleArtifactRequest(
      url(root, ".artemis/design/diffs/api-errors.json"),
      deps,
      { accept: "text/html,application/xhtml+xml" }
    );
    assert.equal(response.status, 200);
    assert.match(response.contentType, /text\/html/);
    const html = String(response.body);
    assert.match(html, /<h1>api-errors.json<\/h1>/);
    assert.match(html, /class="j-key"/, "键高亮");
    assert.match(html, /class="j-str"/, "字符串高亮");
    assert.match(html, /class="j-num"/, "数字高亮");
    assert.match(html, /class="j-lit"/, "布尔/null 高亮");
    assert.match(html, /原始 JSON/, "原始文件入口");
    assert.match(html, /复制 JSON/, "复制全文入口");
    assert.match(html, /white-space:pre-wrap/, "长字符串自动换行，不横向裁切");
    assert.match(html, /← 返回项目/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact route: JSON 对非浏览器请求保持原始 application/json", async () => {
  const { root, deps } = await setup();
  try {
    const response = await handleArtifactRequest(
      url(root, ".artemis/design/diffs/api-errors.json"),
      deps
    );
    assert.equal(response.status, 200);
    assert.match(response.contentType, /application\/json/);
    assert.ok(okRaw(response.body));
    const forced = await handleArtifactRequest(
      new URL(`${url(root, ".artemis/design/diffs/api-errors.json")}&raw=1`),
      deps,
      { accept: "text/html" }
    );
    assert.match(forced.contentType, /application\/json/, "?raw=1 强制原始 JSON");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact route: 非法 JSON 以纯文本查看器展示并显式告警", async () => {
  const { root, deps } = await setup();
  try {
    const response = await handleArtifactRequest(
      url(root, ".artemis/design/diffs/broken.json"),
      deps,
      { accept: "text/html" }
    );
    assert.equal(response.status, 200);
    const html = String(response.body);
    assert.match(html, /不是合法 JSON/);
    assert.match(html, /not json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function okRaw(body) {
  const parsed = JSON.parse(String(body));
  return parsed.traceId === "t-1" && parsed.ok === true;
}

test("artifact route: 日志在浏览器 Accept 下渲染查看器并高亮 ERROR/WARN", async () => {
  const { root, deps } = await setup();
  try {
    const response = await handleArtifactRequest(
      url(root, ".artemis/design/diffs/stderr.log"),
      deps,
      { accept: "text/html,application/xhtml+xml" }
    );
    assert.equal(response.status, 200);
    assert.match(response.contentType, /text\/html/);
    const html = String(response.body);
    assert.match(html, /<h1>stderr.log<\/h1>/);
    assert.match(html, /复制日志/);
    assert.match(html, /原始日志/);
    assert.match(html, /log-error/);
    assert.match(html, /log-warn/);
    assert.match(html, /white-space:pre-wrap/, "长行自动换行");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact route: 日志对非浏览器请求保持 text/plain", async () => {
  const { root, deps } = await setup();
  try {
    const response = await handleArtifactRequest(
      url(root, ".artemis/design/diffs/stderr.log"),
      deps
    );
    assert.equal(response.status, 200);
    assert.match(response.contentType, /text\/plain/);
    assert.match(String(response.body), /ERROR failed to tap/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact route: 索引 CSV 导出（含筛选）", async () => {
  const { root, deps } = await setup();
  try {
    const csv = await handleArtifactRequest(
      new URL(`http://x/panel/artifact?project=${encodeURIComponent(root)}&format=csv&q=shot`),
      deps
    );
    assert.equal(csv.status, 200);
    assert.match(csv.contentType, /text\/csv/);
    assert.match(String(csv.body), /kind,path,title,at,size/);
    assert.match(String(csv.body), /shot\.png/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact route: 目录返回浅索引（可下钻、可回上级、名称转义）", async () => {
  const { root, deps } = await setup();
  try {
    const traceDir = join(root, ".artemis", "traces", "ios-demo");
    await mkdir(join(traceDir, "shots"), { recursive: true });
    await writeFile(join(traceDir, "run.json"), "{}", "utf8");
    await writeFile(join(traceDir, "shots", "step-1.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(traceDir, "<script>.json"), "{}", "utf8");

    const index = await handleArtifactRequest(url(root, ".artemis/traces/ios-demo"), deps);
    assert.equal(index.status, 200);
    assert.match(index.contentType, /text\/html/);
    const html = String(index.body);
    assert.match(html, /\/panel\/artifact\?project=/);
    assert.match(html, /run\.json/);
    assert.match(html, /shots\//);
    assert.match(html, /← 上级/);
    assert.match(html, /&lt;script&gt;\.json/);
    assert.ok(!html.includes("<script>.json"), "条目名称必须转义");

    const artemisRoot = await handleArtifactRequest(url(root, ".artemis"), deps);
    assert.equal(artemisRoot.status, 200);
    assert.ok(!String(artemisRoot.body).includes("← 上级"), ".artemis 根无上级");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact route: 空目录默认折叠，点击空目录显示空态", async () => {
  const { root, deps } = await setup();
  try {
    const traceDir = join(root, ".artemis", "traces", "empty-demo");
    await mkdir(join(traceDir, "steps", "step-empty"), { recursive: true });
    await writeFile(join(traceDir, "status.json"), "{}", "utf8");

    const index = await handleArtifactRequest(url(root, ".artemis/traces/empty-demo/steps"), deps);
    const html = String(index.body);
    assert.match(html, /已折叠 1 个空目录/);
    assert.match(html, /显示空目录/);
    assert.doesNotMatch(html, /step-empty\//, "默认不展开空目录");

    const shown = await handleArtifactRequest(
      new URL(`${url(root, ".artemis/traces/empty-demo/steps")}&showEmpty=1`),
      deps
    );
    assert.match(String(shown.body), /step-empty\//);
    assert.match(String(shown.body), /空目录/);

    const empty = await handleArtifactRequest(
      url(root, ".artemis/traces/empty-demo/steps/step-empty"),
      deps
    );
    assert.match(String(empty.body), /此目录为空/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact route: 越权与穿越全部拒绝", async () => {
  const { root, deps } = await setup();
  try {
    const outside = await handleArtifactRequest(url(root, "aos.config.jsonc"), deps);
    assert.equal(outside.status, 403, "仅 .artemis 范围");

    const traversal = await handleArtifactRequest(
      new URL(
        `http://x/panel/artifact?project=${encodeURIComponent(root)}&path=${encodeURIComponent(".artemis/../../etc/hosts")}`
      ),
      deps
    );
    assert.equal(traversal.status, 400, "目录穿越拒绝");

    const unknownExt = await handleArtifactRequest(url(root, ".artemis/design/diffs/raw.bin"), deps);
    assert.equal(unknownExt.status, 400, "非白名单类型拒绝");

    const missing = await handleArtifactRequest(url(root, ".artemis/design/diffs/none.png"), deps);
    assert.equal(missing.status, 404);

    const noParams = await handleArtifactRequest(new URL("http://x/panel/artifact"), deps);
    assert.equal(noParams.status, 400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
