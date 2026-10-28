import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { loadProject } from "../dist/config/loader.js";
import {
  createWebProject,
  normalizeProjectName,
  projectSlug
} from "../dist/web/project-service.js";

async function tempWorkspace() {
  return mkdtemp(path.join(os.tmpdir(), "aos-web-svc-"));
}

test("normalizeProjectName: trim + NFKC + lowercase", () => {
  assert.deepEqual(normalizeProjectName("  Starbucks  "), {
    name: "Starbucks",
    normalized: "starbucks"
  });
  assert.deepEqual(normalizeProjectName("Ｓｔａｒｂｕｃｋｓ"), {
    name: "Starbucks",
    normalized: "starbucks"
  });
  assert.deepEqual(normalizeProjectName("  星巴克  "), { name: "星巴克", normalized: "星巴克" });
});

test("normalizeProjectName: 拒绝空/超长/分隔符/.. /控制字符", () => {
  assert.throws(() => normalizeProjectName(""), /长度/);
  assert.throws(() => normalizeProjectName("   "), /长度/);
  assert.throws(() => normalizeProjectName("x".repeat(65)), /长度/);
  assert.throws(() => normalizeProjectName("a/b"), /路径分隔符/);
  assert.throws(() => normalizeProjectName("a\\b"), /路径分隔符/);
  assert.throws(() => normalizeProjectName("a..b"), /\.\./);
  assert.throws(() => normalizeProjectName("a\u0000b"), /控制字符/);
  assert.throws(() => normalizeProjectName("a\u001fb"), /控制字符/);
});

test("projectSlug: 保留 Unicode 字母数字、分隔符转 -、空回退", () => {
  assert.equal(projectSlug("Hello World"), "Hello-World");
  assert.equal(projectSlug("星巴克"), "星巴克");
  assert.equal(projectSlug("  foo   bar  "), "foo-bar");
  assert.equal(projectSlug("a/b\\c"), "a-b-c");
  assert.equal(projectSlug("Foo_Bar.baz"), "Foo-Bar-baz");
  const expected = `project-${createHash("sha256").update("!!!").digest("hex").slice(0, 8)}`;
  assert.equal(projectSlug("!!!"), expected);
  assert.match(projectSlug(""), /^project-[0-9a-f]{8}$/);
});

test("createWebProject: 中文名创建成功（目录/配置/store 记录）", async () => {
  const workspaceRoot = await tempWorkspace();
  const store = new MemoryStore();
  const result = await createWebProject({
    store,
    workspaceRoot,
    name: "星巴克咖啡",
    platforms: ["android", "ios"],
    appPackage: "com.starbucks.tw",
    customerName: "星巴克",
    owner: "admin"
  });

  const expectedRoot = path.join(workspaceRoot, "星巴克咖啡");
  assert.equal(result.rootPath, expectedRoot);

  for (const subdir of ["assets", "workbook", "scripts", "results"]) {
    assert.equal(
      fs.existsSync(path.join(expectedRoot, ".artemis", "web", subdir)),
      true,
      `.artemis/web/${subdir} 目录应存在`
    );
  }

  const config = JSON.parse(
    await readFile(path.join(expectedRoot, "aos.config.jsonc"), "utf-8")
  );
  assert.equal(config.project.name, "星巴克咖啡");
  assert.deepEqual(config.project.stack, ["android-native", "ios-native"]);
  assert.deepEqual(config.llm, { profiles: {} });
  assert.deepEqual(config.artemis, {});

  const project = await store.getProjectByPath(expectedRoot);
  assert.equal(project.name, "星巴克咖啡");

  const web = await store.getWebProject(expectedRoot);
  assert.equal(web.name, "星巴克咖啡");
  assert.equal(web.normalizedName, "星巴克咖啡");
  assert.deepEqual(web.platforms, ["android", "ios"]);
  assert.equal(web.appPackage, "com.starbucks.tw");
  assert.equal(web.customerName, "星巴克");
  assert.equal(web.owner, "admin");

  assert.equal(result.project.rootPath, expectedRoot);
  assert.equal(result.web.rootPath, expectedRoot);
  assert.equal(result.web.name, "星巴克咖啡");
});

test("createWebProject: name 前后空白归一、目录用归一后的 slug", async () => {
  const workspaceRoot = await tempWorkspace();
  const store = new MemoryStore();
  const result = await createWebProject({
    store,
    workspaceRoot,
    name: "  Starbucks  ",
    platforms: ["android"],
    appPackage: "com.x"
  });

  assert.equal(result.rootPath, path.join(workspaceRoot, "Starbucks"));
  const config = JSON.parse(
    await readFile(path.join(result.rootPath, "aos.config.jsonc"), "utf-8")
  );
  assert.equal(config.project.name, "Starbucks");

  const web = await store.getWebProject(result.rootPath);
  assert.equal(web.name, "Starbucks");
  assert.equal(web.normalizedName, "starbucks");
});

test("createWebProject: 同名（大小写/NFKC）拒绝", async () => {
  const workspaceRoot = await tempWorkspace();
  const store = new MemoryStore();
  await createWebProject({
    store,
    workspaceRoot,
    name: "Starbucks",
    platforms: ["android"],
    appPackage: "com.x"
  });

  await assert.rejects(
    createWebProject({
      store,
      workspaceRoot,
      name: "STARBUCKS",
      platforms: ["android"],
      appPackage: "com.x"
    }),
    /已存在/
  );
  await assert.rejects(
    createWebProject({
      store,
      workspaceRoot,
      name: "Ｓｔａｒｂｕｃｋｓ",
      platforms: ["android"],
      appPackage: "com.x"
    }),
    /已存在/
  );
});

test("createWebProject: 目录已存在拒绝", async () => {
  const workspaceRoot = await tempWorkspace();
  await mkdir(path.join(workspaceRoot, "taken"), { recursive: true });
  const store = new MemoryStore();
  await assert.rejects(
    createWebProject({
      store,
      workspaceRoot,
      name: "taken",
      platforms: ["ios"],
      appPackage: "com.x"
    }),
    /目录已存在/
  );
});

test("createWebProject: 未知平台拒绝且不创建目录", async () => {
  const workspaceRoot = await tempWorkspace();
  const store = new MemoryStore();
  await assert.rejects(
    createWebProject({
      store,
      workspaceRoot,
      name: "bad-platform",
      platforms: ["windows"],
      appPackage: "com.x"
    }),
    /平台/
  );
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, "bad-platform")),
    false,
    "未知平台不应创建项目目录"
  );
});

test("createWebProject: 空平台拒绝且不创建目录", async () => {
  const workspaceRoot = await tempWorkspace();
  const store = new MemoryStore();
  await assert.rejects(
    createWebProject({
      store,
      workspaceRoot,
      name: "no-platform",
      platforms: [],
      appPackage: "com.x"
    }),
    /至少选择一个平台/
  );
  assert.equal(
    fs.existsSync(path.join(workspaceRoot, "no-platform")),
    false,
    "空平台不应创建项目目录"
  );
});

test("createWebProject: 生成的 config 可被 loadProject 校验通过（stack 映射为 native 栈）", async () => {
  const workspaceRoot = await tempWorkspace();
  const store = new MemoryStore();
  const result = await createWebProject({
    store,
    workspaceRoot,
    name: "双端项目",
    platforms: ["android", "ios"],
    appPackage: "com.dual"
  });

  const rawConfig = JSON.parse(
    await readFile(path.join(result.rootPath, "aos.config.jsonc"), "utf-8")
  );
  assert.deepEqual(rawConfig.project.stack, ["android-native", "ios-native"]);

  const loaded = loadProject({ cwd: result.rootPath, env: {} });
  assert.equal(loaded.configPath, path.join(result.rootPath, "aos.config.jsonc"));
  assert.deepEqual(loaded.config.project?.stack, ["android-native", "ios-native"]);
  const stackErrors = loaded.validation.errors.filter((entry) =>
    /stack|unknown/i.test(`${entry.code} ${entry.message}`)
  );
  assert.deepEqual(stackErrors, [], "配置不应报 stack 相关校验错误");

  const web = await store.getWebProject(result.rootPath);
  assert.deepEqual(web.platforms, ["android", "ios"]);
});

test("createWebProject: upsert 失败硬删除 web 行，同名可重试", async () => {
  const workspaceRoot = await tempWorkspace();
  const store = new MemoryStore();

  const originalUpsert = store.upsertProject.bind(store);
  let failNext = true;
  store.upsertProject = async (input) => {
    if (failNext) {
      failNext = false;
      throw new Error("upsert boom");
    }
    return originalUpsert(input);
  };

  const expectedRoot = path.join(workspaceRoot, "rollback");
  await assert.rejects(
    createWebProject({
      store,
      workspaceRoot,
      name: "rollback",
      platforms: ["android"],
      appPackage: "com.x"
    }),
    /upsert boom/
  );

  assert.equal(
    fs.existsSync(expectedRoot),
    false,
    "失败后项目目录应被移除"
  );
  assert.equal(await store.getWebProject(expectedRoot), null, "失败后不应残留 web 行");
  assert.equal((await store.listWebProjects()).length, 0, "失败后不应留下 tombstone");

  const result = await createWebProject({
    store,
    workspaceRoot,
    name: "rollback",
    platforms: ["android"],
    appPackage: "com.x"
  });
  assert.equal(result.rootPath, expectedRoot);
  assert.equal((await store.listWebProjects()).length, 1);
  assert.equal((await store.getWebProject(expectedRoot)).name, "rollback");
});
