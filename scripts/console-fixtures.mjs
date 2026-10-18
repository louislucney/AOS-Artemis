import { mkdirSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { MemoryStore } from "../dist/db/memory.js";
import { handlePanelRequest } from "../dist/panel/web.js";

const outDir = path.resolve(".scratch/console-fixtures");
mkdirSync(outDir, { recursive: true });

const root = path.join(tmpdir(), `aos-fixture-${Date.now()}`);
await mkdir(path.join(root, ".artemis", "design", "runs"), { recursive: true });
const manifest = path.join(root, ".artemis", "design", "runs", "20261018_demo.json");
await writeFile(manifest, "{}", "utf8");
await utimes(manifest, new Date("2026-10-18T03:00:00.000Z"), new Date("2026-10-18T03:00:00.000Z"));

const store = new MemoryStore();
await store.upsertProject({ rootPath: root, name: "demo" });
await store.recordCaseSet({
  rootPath: root,
  source: "figma:demo",
  basename: "登录回归",
  features: [
    { key: "login", name: "登录", caseCount: 3, screens: [], jsonPath: "/x/a.json", mdPath: "/x/a.md", xlsxPath: "/x/a.xlsx" }
  ]
});
await store.recordAudit(root, { domain: "suite", action: "run.recorded", result: "ok", summary: "批次登记" });
await store.recordAudit(root, { domain: "panel", action: "action.tasks", result: "failed", summary: "面板动作 tasks → 400" });

const deps = { store, env: {}, storeNote: "未配置 MOBILE_TESTING_DATABASE_URL：使用项目文件台账。" };
const target = (section) => {
  const params = new URLSearchParams({ project: root });
  if (section !== null) params.set("section", section);
  return new URL(`http://x/panel?${params.toString()}`);
};

const pages = [
  ["overview", new URL("http://x/panel")],
  ["project", target(null)],
  ["dispatch", target("dispatch")],
  ["library", target("library")],
  ["archive", target("archive")],
  ["audit", target("audit")],
  ["ops", target("ops")]
];
for (const [name, url] of pages) {
  const response = await handlePanelRequest(url, deps);
  await writeFile(path.join(outDir, `${name}.html`), response.body, "utf8");
}
console.log(`控制台 fixtures 已写入 ${pages.length} 页 → ${outDir}`);
