import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../dist/db/memory.js";
import { baseConfig, loadTestRuntime, makeTempDir, makeTempProject } from "./helpers.js";

test("Runtime.initialize 不把共享 store 绑定到本机（中心读其他主机仍可用）", async () => {
  const shared = new MemoryStore();
  const otherRoot = path.join(makeTempDir("aos-runtime-shared-other-"), "other-app");
  const other = await shared.scopeHost("h-other").upsertProject({
    rootPath: otherRoot,
    name: "other-app"
  });

  const dir = makeTempProject({ config: baseConfig() });
  const { runtime } = await loadTestRuntime(dir, {
    store: shared,
    hostIdentity: {
      id: "h-main",
      hardwareId: null,
      hostname: "main",
      username: "tester",
      osPlatform: "darwin",
      osVersion: "1.0.0",
      arch: "arm64",
      kind: "mac",
      identitySource: "env"
    }
  });

  assert.equal(shared.localHostId, null, "共享 store 未被 bindHost 改写");
  assert.equal(runtime.store.localHostId, "h-main", "Runtime 使用自己的作用域视图");
  assert.equal(runtime.store.kind, "memory");

  const resolved = await shared.getProjectByPath(otherRoot);
  assert.equal(resolved?.id, other.id, "中心未绑定视图仍可解析其他主机项目");
  assert.equal((await shared.listProjects()).length, 2, "两个主机的项目行都可见");
});
