import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeTaskDocuments } from "../dist/suite-command.js";

test("runner task: center case set JSON and flows are materialized locally", (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-task-materialize-"));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const bundle = {
    documents: [
      {
        caseSetId: "set-1",
        featureKey: "登录",
        jsonPath: "/center/case-sets/login.json",
        content: '{"flows":[{"id":"TC_01"}]}\n'
      }
    ],
    flows: { path: "/center/flows.json", content: '{"screens":[{"name":"Login"}]}\n' }
  };
  const paths = materializeTaskDocuments({ configDirAbs: configDir }, bundle);
  const key = "set-1\0登录";
  const local = paths.get(key);
  assert.ok(local, "missing materialized path");
  assert.equal(fs.readFileSync(local, "utf8"), bundle.documents[0].content);
  assert.equal(
    fs.readFileSync(path.join(configDir, "design", "flows.json"), "utf8"),
    bundle.flows.content
  );
});

test("runner task: center task plan is materialized locally", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-task-plan-materialize-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plan = {
    schemaVersion: 1,
    taskId: "task-1",
    createdAt: "2026-11-16T00:00:00.000Z",
    hostId: "host-1",
    platforms: ["android"],
    plans: [{ schemaVersion: 1, platform: "android", engine: "proxy" }],
    warnings: ["fixture"]
  };
  materializeTaskDocuments(
    { configDirAbs: path.join(root, ".artemis"), project: { rootDir: root } },
    { task: { id: "task-1" }, taskPlan: plan }
  );
  const file = path.join(root, ".artemis", "design", "task-plans", "task-1.json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).taskId, "task-1");
});

test("runner task: null bundle materializes nothing", (t) => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-task-materialize-null-"));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const paths = materializeTaskDocuments({ configDirAbs: configDir }, null);
  assert.equal(paths.size, 0);
});
