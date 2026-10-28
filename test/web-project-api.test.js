import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelActionRequest } from "../dist/panel/actions.js";
import { handlePanelRequest } from "../dist/panel/web.js";

const ADMIN = { name: "alice", role: "admin", source: "user" };
const DISPATCHER = { name: "bob", role: "dispatcher", source: "user" };

async function setup(t) {
  const store = new MemoryStore();
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "aos-web-api-"));
  if (t) t.after(() => rm(workspaceRoot, { recursive: true, force: true }));
  return { store, workspaceRoot, deps: { store, env: {}, workspaceRoot } };
}

function action(pathname, body, identity) {
  return {
    method: "POST",
    url: new URL(`http://localhost${pathname}`),
    body,
    ...(identity ? { identity } : {})
  };
}

test("web project api: 创建成功（store 记录 + 审计 project.create）", async (t) => {
  const { store, deps } = await setup(t);
  const res = await handlePanelActionRequest(
    action(
      "/panel/api/projects",
      { name: "星巴克咖啡", platforms: ["android", "ios"], appPackage: "com.starbucks.tw", customerName: "星巴克" },
      ADMIN
    ),
    deps
  );
  assert.equal(res.status, 200, res.body);
  const payload = JSON.parse(res.body);
  assert.equal(payload.ok, true);
  assert.equal(payload.project.name, "星巴克咖啡");
  assert.deepEqual(payload.project.platforms, ["android", "ios"]);
  assert.equal(payload.project.appPackage, "com.starbucks.tw");
  assert.equal(typeof payload.project.rootPath, "string");
  assert.ok(payload.project.rootPath.startsWith(deps.workspaceRoot));

  const web = await store.getWebProject(payload.project.rootPath);
  assert.equal(web.name, "星巴克咖啡");
  assert.equal(web.customerName, "星巴克");
  assert.equal(web.owner, "alice");

  const audit = await store.listAudit(payload.project.rootPath, { domain: "project" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "project.create");
  assert.equal(audit[0].result, "ok");
  assert.equal(audit[0].actor, "alice");
  assert.match(audit[0].summary, /星巴克咖啡/);
});

test("web project api: 重名（大小写/NFKC）409 且不落成功审计", async (t) => {
  const { store, deps } = await setup(t);
  const first = await handlePanelActionRequest(
    action("/panel/api/projects", { name: "dup", platforms: ["android"], appPackage: "com.x" }, ADMIN),
    deps
  );
  assert.equal(first.status, 200);

  const second = await handlePanelActionRequest(
    action("/panel/api/projects", { name: "DUP", platforms: ["android"], appPackage: "com.x" }, ADMIN),
    deps
  );
  assert.equal(second.status, 409);
  assert.match(JSON.parse(second.body).error, /已存在/);

  const projects = await store.listWebProjects();
  assert.equal(projects.length, 1, "重复创建不新增记录");

  const audit = await store.listAudit(path.join(deps.workspaceRoot, "DUP"), {
    domain: "project"
  });
  const failed = audit.find((event) => event.action === "project.create" && event.result === "failed");
  assert.ok(failed, "失败创建应写 failed 审计");
  assert.equal(failed.actor, "alice");
  assert.match(failed.summary, /dup/);
  assert.match(failed.summary, /已存在/);
});

test("web project api: dispatcher 请求 403 role_forbidden", async (t) => {
  const { deps } = await setup(t);
  const res = await handlePanelActionRequest(
    action("/panel/api/projects", { name: "x", platforms: ["android"], appPackage: "com.x" }, DISPATCHER),
    deps
  );
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).code, "role_forbidden");
});

test("web project api: 非法 name/platforms 400", async (t) => {
  const { deps } = await setup(t);
  const noName = await handlePanelActionRequest(
    action("/panel/api/projects", { platforms: ["android"], appPackage: "com.x" }, ADMIN),
    deps
  );
  assert.equal(noName.status, 400);

  const badPlatform = await handlePanelActionRequest(
    action("/panel/api/projects", { name: "x", platforms: ["windows"], appPackage: "com.x" }, ADMIN),
    deps
  );
  assert.equal(badPlatform.status, 400);

  const emptyPlatforms = await handlePanelActionRequest(
    action("/panel/api/projects", { name: "x", platforms: [], appPackage: "com.x" }, ADMIN),
    deps
  );
  assert.equal(emptyPlatforms.status, 400);

  const badAppPackage = await handlePanelActionRequest(
    action("/panel/api/projects", { name: "x", platforms: ["android"], appPackage: 42 }, ADMIN),
    deps
  );
  assert.equal(badAppPackage.status, 400);
});

test("web project api: 非法名称（分隔符/超长）400 且不建目录", async (t) => {
  const { store, deps } = await setup(t);
  for (const name of ["a/b", "x".repeat(65), "a..b"]) {
    const res = await handlePanelActionRequest(
      action("/panel/api/projects", { name, platforms: ["android"], appPackage: "com.x" }, ADMIN),
      deps
    );
    assert.equal(res.status, 400, `${name} 应被拒绝`);
    assert.equal(typeof JSON.parse(res.body).error, "string");
  }
  assert.equal((await store.listWebProjects()).length, 0);
  assert.equal((await readdir(deps.workspaceRoot)).length, 0, "校验失败不落目录");
});

test("web project api: workspace 不可写时返回结构化 JSON 错误（不崩溃）", async (t) => {
  const { deps } = await setup(t);
  const blocker = path.join(deps.workspaceRoot, "not-a-dir");
  await writeFile(blocker, "x");
  const res = await handlePanelActionRequest(
    action(
      "/panel/api/projects",
      { name: "blocked", platforms: ["android"], appPackage: "com.x" },
      ADMIN
    ),
    { ...deps, workspaceRoot: blocker }
  );
  assert.equal(res.status, 500);
  assert.match(res.contentType, /application\/json/);
  assert.equal(typeof JSON.parse(res.body).error, "string");
  assert.match(JSON.parse(res.body).error, /创建项目失败/);
});

test("web project api: archive 成功（状态归档 + 审计 project.archive）", async (t) => {
  const { store, deps } = await setup(t);
  const created = await handlePanelActionRequest(
    action("/panel/api/projects", { name: "arch", platforms: ["ios"], appPackage: "com.a" }, ADMIN),
    deps
  );
  const rootPath = JSON.parse(created.body).project.rootPath;

  const res = await handlePanelActionRequest(
    action("/panel/api/projects/archive", { project: rootPath }, ADMIN),
    deps
  );
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).ok, true);

  const web = await store.getWebProject(rootPath);
  assert.equal(web.status, "archived");

  const audit = await store.listAudit(rootPath, { domain: "project" });
  const archiveEvent = audit.find((event) => event.action === "project.archive");
  assert.ok(archiveEvent, "应存在 project.archive 审计");
  assert.equal(archiveEvent.result, "ok");
  assert.equal(archiveEvent.actor, "alice");
});

test("web project api: archive 未知项目 404", async (t) => {
  const { deps } = await setup(t);
  const res = await handlePanelActionRequest(
    action("/panel/api/projects/archive", { project: "/nope/unknown" }, ADMIN),
    deps
  );
  assert.equal(res.status, 404);
});

test("web project api: 总览新增项目表单（admin 可见/提交；非 admin 隐藏；actions 关闭禁用）", async (t) => {
  const { deps } = await setup(t);

  const admin = await handlePanelRequest(new URL("http://x/panel"), {
    ...deps,
    capabilities: { actions: true, usage: true, mode: "http", role: "admin" }
  });
  assert.equal(admin.status, 200);
  assert.match(admin.body, /新增项目/);
  assert.match(admin.body, /panel\/api\/projects/);
  assert.match(admin.body, /name="name"/);
  assert.match(admin.body, /value="android"/);
  assert.match(admin.body, /value="ios"/);
  assert.match(admin.body, /name="appPackage"/);
  assert.match(admin.body, /name="customerName"/);
  assert.match(admin.body, /X-AOS-Console/);
  assert.match(admin.body, /aosFlash/);
  assert.match(admin.body, /location\.href='\/panel\?project='/);

  const viewer = await handlePanelRequest(new URL("http://x/panel"), {
    ...deps,
    capabilities: { actions: true, usage: true, mode: "http", role: "viewer" }
  });
  assert.doesNotMatch(viewer.body, /新增项目/);

  const noActions = await handlePanelRequest(new URL("http://x/panel"), {
    ...deps,
    capabilities: { actions: false, usage: true, mode: "standalone", role: "admin" }
  });
  assert.match(noActions.body, /新增项目/);
  assert.match(noActions.body, /disabled/, "actions 关闭时提交入口禁用");
});
