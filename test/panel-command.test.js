import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import test from "node:test";

import ExcelJS from "exceljs";

import { MemoryStore } from "../dist/db/memory.js";
import { runPanelCommand } from "../dist/panel-command.js";
import { makeTempDir } from "./helpers.js";

function runCli(args, deps = {}) {
  const logs = [];
  const errors = [];
  return runPanelCommand(args, {
    log: (line) => logs.push(line),
    errorLog: (line) => errors.push(line),
    ...deps
  }).then((code) => ({ code, logs, errors }));
}

test("panel --web: 动作门默认关闭；AOS_PANEL_ACTIONS=1＋loopback 才开放", async () => {
  const store = new MemoryStore();
  const dir = makeTempDir("aos-panel-gate-");
  fs.mkdirSync(path.join(dir, "ws-app"), { recursive: true });
  const post = (port, host) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/panel/api/schedules",
          method: "POST",
          headers: { "Content-Type": "application/json", Host: host }
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve({ status: response.statusCode, body }));
        }
      );
      req.on("error", reject);
      req.end(JSON.stringify({}));
    });

  await runCli(["--web", "--port", "0", "--workspace", dir], {
    store,
    waitForShutdown: async (handle) => {
      const page = await fetch(`http://127.0.0.1:${handle.port}/panel`);
      const html = await page.text();
      assert.ok(html.includes("写动作未启用"), "默认关：页级横幅");
      const off = await post(handle.port, "127.0.0.1");
      assert.equal(off.status, 404, "未设 AOS_PANEL_ACTIONS：动作门关闭");
    }
  });

  await runCli(["--web", "--port", "0", "--workspace", dir], {
    store,
    env: { ...process.env, AOS_PANEL_ACTIONS: "1" },
    waitForShutdown: async (handle) => {
      const page = await fetch(`http://127.0.0.1:${handle.port}/panel`);
      const html = await page.text();
      assert.ok(!html.includes("写动作未启用"), "开启后无横幅");
      const on = await post(handle.port, "127.0.0.1");
      assert.equal(on.status, 400, "已开：进入业务校验（缺 project 400）");
      const foreign = await post(handle.port, "10.0.0.5:8767");
      assert.equal(foreign.status, 404, "非 loopback Host 拒绝");
    }
  });
});

test("panel --web: GET /panel/api/hosts 只读可用（不依赖 AOS_PANEL_ACTIONS）", async () => {
  const store = new MemoryStore();
  const dir = makeTempDir("aos-panel-hosts-api-");
  fs.mkdirSync(path.join(dir, "ws-app"), { recursive: true });
  await runCli(["--web", "--port", "0", "--workspace", dir], {
    store,
    env: { ...process.env, AOS_PANEL_ACTIONS: "0" },
    waitForShutdown: async (handle) => {
      const res = await fetch(`http://127.0.0.1:${handle.port}/panel/api/hosts`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /application\/json/);
      assert.deepEqual(await res.json(), { ok: true, hosts: [] });
    }
  });
});

test("panel --web: multipart 导入转发 rawBody/contentType → 200 且登记用例", async () => {
  const workspace = makeTempDir("aos-panel-import-");
  const projectDir = path.join(workspace, "demo");
  fs.mkdirSync(projectDir, { recursive: true });
  const store = new MemoryStore();
  await store.upsertProject({ rootPath: projectDir, name: "demo", hostId: "panel-import-host" });

  await runCli(["--web", "--port", "0", "--workspace", workspace], {
    store,
    env: {
      ...process.env,
      AOS_PANEL_ACTIONS: "1",
      AOS_HOST_ID: "panel-import-host",
      AOS_LEDGER_AUTO_IMPORT: "0",
      AOS_USAGE: "0"
    },
    waitForShutdown: async (handle) => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Sheet1");
      sheet.addRow(["用例名", "步骤", "预期", "前置"]);
      sheet.addRow(["登录", "输入账号密码并点击登录", "进入首页", "应用已安装"]);
      const bytes = await workbook.xlsx.writeBuffer();
      const form = new FormData();
      form.set(
        "file",
        new Blob([bytes], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }),
        "cases.xlsx"
      );
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/panel/api/import?project=${encodeURIComponent(projectDir)}`,
        {
          method: "POST",
          headers: { "X-AOS-Console": "1" },
          body: form
        }
      );
      const body = await res.text();
      assert.equal(res.status, 200, body);
      const payload = JSON.parse(body);
      assert.equal(payload.ok, true);
      assert.equal(payload.caseCount, 1);
      const sets = await store.listCaseSets(projectDir);
      assert.equal(sets.length, 1, "导入用例已登记");
      assert.equal(sets[0].features[0].caseCount, 1);
    }
  });
});

test("panel --web: multipart 资产上传（project/kind 字段）→ 200 且登记资产", async () => {
  const workspace = makeTempDir("aos-panel-assets-");
  const projectDir = path.join(workspace, "demo");
  fs.mkdirSync(projectDir, { recursive: true });
  const store = new MemoryStore();
  await store.upsertProject({
    rootPath: projectDir,
    name: "demo",
    hostId: "panel-asset-host"
  });
  await store.createWebProject({
    rootPath: projectDir,
    name: "demo",
    normalizedName: "demo",
    platforms: ["android"]
  });

  await runCli(["--web", "--port", "0", "--workspace", workspace], {
    store,
    env: {
      ...process.env,
      AOS_PANEL_ACTIONS: "1",
      AOS_HOST_ID: "panel-asset-host",
      AOS_LEDGER_AUTO_IMPORT: "0",
      AOS_USAGE: "0"
    },
    waitForShutdown: async (handle) => {
      const form = new FormData();
      form.set("project", projectDir);
      form.set("kind", "excel");
      form.set(
        "file",
        new Blob([Buffer.from("panel-command-asset")], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }),
        "cases.xlsx"
      );
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/panel/api/projects/assets`,
        {
          method: "POST",
          headers: { "X-AOS-Console": "1" },
          body: form
        }
      );
      const body = await res.text();
      assert.equal(res.status, 200, body);
      const payload = JSON.parse(body);
      assert.equal(payload.ok, true);
      assert.equal(payload.asset.filename, "cases.xlsx");

      const assets = await store.listWebAssets(projectDir, "excel");
      assert.equal(assets.length, 1, "资产已登记");
      assert.equal(
        fs.readFileSync(assets[0].storagePath, "utf8"),
        "panel-command-asset"
      );
    }
  });
});

test("panel --web: 跨主机导入 → 400（不建运行时、不登记、不写本地文件）", async () => {
  const workspace = makeTempDir("aos-panel-import-remote-");
  const projectDir = path.join(workspace, "remote-demo");
  fs.mkdirSync(projectDir, { recursive: true });
  const store = new MemoryStore();
  await store.upsertProject({
    rootPath: projectDir,
    name: "remote-demo",
    hostId: "remote-host"
  });

  await runCli(["--web", "--port", "0", "--workspace", workspace], {
    store,
    env: {
      ...process.env,
      AOS_PANEL_ACTIONS: "1",
      AOS_HOST_ID: "panel-import-host",
      AOS_LEDGER_AUTO_IMPORT: "0",
      AOS_USAGE: "0"
    },
    waitForShutdown: async (handle) => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Sheet1");
      sheet.addRow(["用例名", "步骤", "预期", "前置"]);
      sheet.addRow(["登录", "输入账号密码并点击登录", "进入首页", "应用已安装"]);
      const bytes = await workbook.xlsx.writeBuffer();
      const form = new FormData();
      form.set(
        "file",
        new Blob([bytes], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }),
        "cases.xlsx"
      );
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/panel/api/import?host=remote-host&project=${encodeURIComponent(projectDir)}`,
        {
          method: "POST",
          headers: { "X-AOS-Console": "1" },
          body: form
        }
      );
      const body = await res.text();
      assert.equal(res.status, 400, body);
      assert.match(body, /跨主机导入/);
      assert.equal(
        fs.existsSync(path.join(projectDir, ".artemis")),
        false,
        "未在面板机写用例文件"
      );
      const phantom = await store
        .scopeHost("panel-import-host")
        .getProjectByPath(projectDir);
      assert.equal(phantom, null, "未登记本机幻影项目行");
      assert.deepEqual(await store.scopeHost("remote-host").listCaseSets(projectDir), []);
    }
  });
});

test("panel --web: multipart 超限 → 413（共享上限）", async () => {
  const workspace = makeTempDir("aos-panel-import-big-");
  const store = new MemoryStore();
  await runCli(["--web", "--port", "0", "--workspace", workspace], {
    store,
    env: {
      ...process.env,
      AOS_PANEL_ACTIONS: "1",
      AOS_USAGE: "0"
    },
    waitForShutdown: async (handle) => {
      const oversized = Buffer.alloc(20 * 1024 * 1024 + 256 * 1024 + 1);
      const res = await fetch(
        `http://127.0.0.1:${handle.port}/panel/api/import?project=demo`,
        {
          method: "POST",
          headers: {
            "Content-Type": "multipart/form-data; boundary=aos",
            "X-AOS-Console": "1"
          },
          body: oversized
        }
      );
      assert.equal(res.status, 413);
      assert.match(await res.text(), /too large/);
    }
  });
});

test("panel --web: serves /panel on an ephemeral port and closes cleanly", async () => {
  const store = new MemoryStore();
  const dir = makeTempDir("aos-panel-cli-");
  fs.mkdirSync(path.join(dir, "ws-app"), { recursive: true });
  let handle = null;
  const { code, logs, errors } = await runCli(["--web", "--port", "0", "--workspace", dir], {
    store,
    waitForShutdown: async (webHandle) => {
      handle = webHandle;
      const html = await fetch(webHandle.url);
      assert.equal(html.status, 200);
      assert.match(await html.text(), /多项目总览/);

      const res = await fetch(`http://127.0.0.1:${webHandle.port}/panel.json`);
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.view, "overview");
      assert.ok(payload.projects.some((row) => row.name === "ws-app"));

      const detail = await fetch(
        `http://127.0.0.1:${webHandle.port}/panel.json?project=ws-app`
      );
      const detailPayload = await detail.json();
      assert.equal(detailPayload.view, "project");
      assert.equal(detailPayload.deep, null, "独立 CLI 进程无深探层");

      const missing = await fetch(`http://127.0.0.1:${webHandle.port}/other`);
      assert.equal(missing.status, 404);

      const root = await fetch(`http://127.0.0.1:${webHandle.port}/`, { redirect: "manual" });
      assert.equal(root.status, 302);
      assert.equal(root.headers.get("location"), "/panel");

      await webHandle.close();
      await assert.rejects(fetch(webHandle.url));
    }
  });
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.ok(handle !== null);
  assert.ok(logs.some((line) => line.includes(`http://127.0.0.1:${handle.port}/panel`)));
  assert.ok(logs.some((line) => line.includes("按 Ctrl-C 停止")));
});

test("panel --web: port conflict exits 2 with a clear message", async () => {
  const store = new MemoryStore();
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  try {
    let waitCalled = false;
    const { code, errors } = await runCli(["--web", "--port", String(port)], {
      store,
      waitForShutdown: async () => {
        waitCalled = true;
      }
    });
    assert.equal(code, 2);
    assert.equal(waitCalled, false);
    assert.ok(errors.some((line) => line.includes(`端口 ${port}`) && line.includes("占用")));
  } finally {
    await new Promise((resolve) => probe.close(resolve));
  }
});

test("panel help and parameter errors", async () => {
  const store = new MemoryStore();
  const help = await runCli(["help"], { store });
  assert.equal(help.code, 0);
  assert.ok(help.logs.some((line) => line.includes("mobile-testing-mcp panel")));

  const bare = await runCli([], { store });
  assert.equal(bare.code, 2);

  const unknown = await runCli(["nope"], { store });
  assert.equal(unknown.code, 2);
  assert.ok(unknown.errors.some((line) => line.includes("未知参数")));

  const badPort = await runCli(["--web", "--port", "abc"], { store });
  assert.equal(badPort.code, 2);
  assert.ok(badPort.errors.some((line) => line.includes("--port")));

  const missingValue = await runCli(["--web", "--workspace"], { store });
  assert.equal(missingValue.code, 2);
  assert.ok(missingValue.errors.some((line) => line.includes("--workspace")));
});
