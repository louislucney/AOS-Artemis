import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("docs: runner 常驻化示例绑定目标项目＋中心 PG 来源（可复制执行）", () => {
  // systemd：ExecStart 显式 --project；PG 以服务级 Environment 提供（不放项目 .env）
  assert.match(
    readme,
    /ExecStart=.*suite runner --project \/srv\/projects\/<项目> --name/,
    "systemd ExecStart 须带 --project 指向目标项目"
  );
  assert.match(readme, /Environment=MOBILE_TESTING_DATABASE_URL=/, "systemd 须给出中心 PG 来源");
  assert.equal(readme.includes("EnvironmentFile=/srv/projects/<项目>/.env"), false, "不得以项目 .env 充当 PG 来源");

  // launchd：完整最小 plist 片段（Label/ProgramArguments --project/EnvironmentVariables）
  assert.match(readme, /<key>Label<\/key><string>com\.mobile-testing\.runner<\/string>/, "launchd 须含 Label");
  assert.match(readme, /<string>--project<\/string>\s*<string>\/srv\/projects\/<项目><\/string>/, "launchd ProgramArguments 须带 --project");
  assert.match(readme, /<key>EnvironmentVariables<\/key>/, "launchd 须含环境变量来源（中心 PG）");
});
