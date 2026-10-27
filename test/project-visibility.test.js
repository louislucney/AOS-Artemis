import assert from "node:assert/strict";
import test from "node:test";

import { projectExcluded, serviceRepoRoot } from "../dist/project-visibility.js";

test("project visibility: 服务仓库默认隐藏，AOS_PANEL_EXCLUDE_PROJECTS 仍生效", () => {
  const repo = serviceRepoRoot();
  assert.equal(projectExcluded({ name: "mobile-testing", rootPath: repo }, undefined), true);
  assert.equal(projectExcluded({ name: "mobile-testing", rootPath: "/tmp/other" }, undefined), false);
  assert.equal(projectExcluded({ name: "other", rootPath: "/tmp/other" }, "other"), true);
  assert.equal(projectExcluded({ name: "other", rootPath: "/tmp/other" }, undefined), false);
});
