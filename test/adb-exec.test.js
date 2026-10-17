import assert from "node:assert/strict";
import test from "node:test";

import { defaultExec, defaultExecBuffer } from "../dist/device/adb.js";

const PROBE = "process.stdout.write(process.env.AOS_EXEC_ENV_PROBE || '')";

test("defaultExec/defaultExecBuffer：传入 env 真正到达子进程", async () => {
  const env = { ...process.env, AOS_EXEC_ENV_PROBE: "tcp:10.0.0.5:5037" };

  const text = await defaultExec(process.execPath, ["-e", PROBE], { env });
  assert.equal(text.code, 0);
  assert.equal(text.stdout, "tcp:10.0.0.5:5037");

  const buffer = await defaultExecBuffer(process.execPath, ["-e", PROBE], { env });
  assert.equal(buffer.code, 0);
  assert.equal(buffer.stdout.toString("utf-8"), "tcp:10.0.0.5:5037");
});
