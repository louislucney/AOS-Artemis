import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { startDeviceGateway } from "../dist/runner/gateway.js";

class FakeChild extends EventEmitter {
  pid = 4242;
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
}

test("startDeviceGateway: 未配置 ssh target → null", async () => {
  assert.equal(await startDeviceGateway({ env: {} }), null);
});

test("startDeviceGateway: 配置 Appium 时启动第二路 ssh -R", async () => {
  const children = [];
  const commands = [];
  const gateway = await startDeviceGateway({
    env: {
      AOS_GATEWAY_SSH_TARGET: "center.example",
      AOS_GATEWAY_ADB_PORT: "16037",
      AOS_GATEWAY_APPIUM_PORT: "16038",
      AOS_GATEWAY_LOCAL_APPIUM_PORT: "4723"
    },
    spawnChild: (cmd, args) => {
      const child = new FakeChild();
      commands.push({ cmd, args });
      children.push(child);
      return child;
    }
  });
  assert.ok(gateway);
  assert.equal(commands.length, 2);
  assert.ok(commands[1].args.includes("16038:127.0.0.1:4723"));
  assert.equal(gateway.snapshot().appiumUrl, "http://127.0.0.1:16038");
  await gateway.stop();
  assert.ok(children.every((child) => child.killed));
});

test("startDeviceGateway: 启动 ssh -R，退出/停止更新 ready", async () => {
  const child = new FakeChild();
  let command = "";
  let args = [];
  const gateway = await startDeviceGateway({
    env: {
      AOS_GATEWAY_SSH_TARGET: "center.example",
      AOS_GATEWAY_ADB_PORT: "16037",
      AOS_GATEWAY_LOCAL_ADB_PORT: "5037"
    },
    now: () => Date.parse("2026-11-04T10:00:00.000Z"),
    spawnChild: (cmd, nextArgs) => {
      command = cmd;
      args = nextArgs;
      return child;
    }
  });
  assert.ok(gateway);
  assert.equal(command, "ssh");
  assert.ok(args.includes("-R"));
  assert.equal(args[args.indexOf("-R") + 1], "16037:127.0.0.1:5037");
  assert.ok(args.includes("ExitOnForwardFailure=yes"));
  assert.equal(args.at(-1), "center.example");
  assert.deepEqual(gateway.snapshot(), {
    adbServer: "127.0.0.1:16037",
    appiumUrl: null,
    tunnelPort: 16037,
    ready: true,
    reportedAt: "2026-11-04T10:00:00.000Z"
  });

  child.emit("exit", 1, null);
  assert.equal(gateway.snapshot().ready, false);

  await gateway.stop();
  assert.equal(child.killed, true);
});
