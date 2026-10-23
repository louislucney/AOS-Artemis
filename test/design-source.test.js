import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { designFlowsPath, sharedDesignDir } from "../dist/figma/design-source.js";
import { baseConfig, makeTempDir, makeTempProject } from "./helpers.js";

test("design-source: config/项目 .env/进程 env 优先级与相对路径解析", () => {
  const dir = makeTempProject({ config: baseConfig({ design: { sharedDir: "../shared-config" } }) });
  const runtime = {
    configDirAbs: path.join(dir, ".artemis"),
    project: {
      rootDir: dir,
      dotenvValues: {},
      config: { design: { sharedDir: "../shared-config" } }
    }
  };
  const fromConfig = sharedDesignDir(runtime, {});
  assert.equal(fromConfig, path.resolve(dir, "../shared-config"));

  const withDotenv = {
    ...runtime,
    project: { ...runtime.project, dotenvValues: { AOS_SHARED_DESIGN_DIR: "../shared-env" } }
  };
  assert.equal(sharedDesignDir(withDotenv, {}), path.resolve(dir, "../shared-env"));
  assert.equal(
    sharedDesignDir(withDotenv, { AOS_SHARED_DESIGN_DIR: "/tmp/shared-process" }),
    "/tmp/shared-process"
  );
});

test("design-source: 共享 flows 存在时优先读取，缺失回退本地", () => {
  const dir = makeTempProject({ config: baseConfig() });
  const shared = makeTempDir("aos-shared-design-");
  const runtime = {
    configDirAbs: path.join(dir, ".artemis"),
    project: { rootDir: dir, dotenvValues: {}, config: { design: { sharedDir: shared } } }
  };
  assert.equal(
    designFlowsPath(runtime, {}),
    path.join(dir, ".artemis", "design", "flows.json"),
    "共享文件不存在时回退本地"
  );
  fs.writeFileSync(path.join(shared, "flows.json"), "{}", "utf-8");
  assert.equal(designFlowsPath(runtime, {}), path.join(shared, "flows.json"));
});
