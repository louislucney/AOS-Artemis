import assert from "node:assert/strict";
import test from "node:test";

import {
  AppiumSessionManager,
  IosDeviceBusyError,
  frameAgeMs,
  isFrameStale,
  resolveCachedFrameMaxAgeMs
} from "../dist/ios/appium/session.js";

class FakeTimers {
  constructor() {
    this.tasks = [];
    this.next = 1;
  }

  set(fn, ms) {
    const id = this.next++;
    this.tasks.push({ id, fn, ms, cancelled: false });
    return {
      cancel: () => {
        const task = this.tasks.find((item) => item.id === id);
        if (task) task.cancelled = true;
      }
    };
  }

  pending() {
    return this.tasks.filter((task) => !task.cancelled);
  }

  fireLast() {
    const pending = this.pending();
    const task = pending[pending.length - 1];
    if (task) {
      task.cancelled = true;
      task.fn();
    }
  }

  fireAll() {
    for (const task of [...this.tasks]) {
      if (!task.cancelled) {
        task.cancelled = true;
        task.fn();
      }
    }
  }
}

class FakeClient {
  constructor() {
    this.created = [];
    this.deleted = [];
    this.counter = 0;
    this.failCreate = 0;
  }

  async createSession(capabilities) {
    this.created.push(capabilities);
    if (this.failCreate > 0) {
      this.failCreate -= 1;
      throw new Error("create-session-failed");
    }
    this.counter += 1;
    return { sessionId: `s-${this.counter}`, capabilities: {} };
  }

  async deleteSession(sessionId) {
    this.deleted.push(sessionId);
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeManager(overrides = {}) {
  const client = new FakeClient();
  const timers = new FakeTimers();
  const manager = new AppiumSessionManager({
    client,
    capabilitiesFor: (udid) => ({ "appium:udid": udid }),
    idleMs: 1000,
    observeWaitMs: 50,
    timers,
    ...overrides
  });
  return { client, timers, manager };
}

test("appium session: 复用会话，空闲回收后重建", async () => {
  const { client, timers, manager } = makeManager();
  const first = await manager.acquire("U-1", "observe");
  assert.equal(first.sessionId, "s-1");
  first.release();
  assert.equal(timers.pending().length, 1);

  const second = await manager.acquire("U-1", "observe");
  assert.equal(second.sessionId, "s-1");
  assert.equal(client.created.length, 1, "空闲期内应复用会话");
  second.release();

  timers.fireAll();
  await tick();
  assert.deepEqual(client.deleted, ["s-1"]);

  const third = await manager.acquire("U-1", "observe");
  assert.equal(third.sessionId, "s-2");
  assert.equal(client.created.length, 2);
  third.release();
});

test("appium session: 观测有界等待超时 → device_busy + 缓存帧", async () => {
  const { timers, manager } = makeManager();
  const task = await manager.acquire("U-2", "task");
  manager.noteFrame("U-2", Buffer.from("png"));
  const pending = manager.acquire("U-2", "observe");
  await tick();
  timers.fireLast();
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof IosDeviceBusyError);
    assert.equal(error.cachedFrame.png.toString(), "png");
    assert.ok(error.cachedFrame.capturedAt);
    return true;
  });
  task.release();
});

test("appium session: 任务 FIFO 排队且复用同一会话", async () => {
  const { client, manager } = makeManager();
  const order = [];
  const first = await manager.acquire("U-3", "task");
  const second = manager.acquire("U-3", "task").then((lease) => {
    order.push("second");
    return lease;
  });
  const third = manager.acquire("U-3", "task").then((lease) => {
    order.push("third");
    return lease;
  });
  first.release();
  const secondLease = await second;
  secondLease.release();
  const thirdLease = await third;
  thirdLease.release();
  assert.deepEqual(order, ["second", "third"]);
  assert.equal(client.created.length, 1);
});

test("appium session: markInvalid 后清理并重建", async () => {
  const { client, manager } = makeManager();
  const first = await manager.acquire("U-4", "task");
  first.markInvalid();
  first.release();
  const second = await manager.acquire("U-4", "observe");
  assert.equal(second.sessionId, "s-2");
  assert.deepEqual(client.deleted, ["s-1"]);
  second.release();
});

test("appium session: 创建失败时触发托管恢复一次", async () => {
  let recovered = 0;
  const { client, manager } = makeManager({
    recoverAppium: async () => {
      recovered += 1;
      return true;
    }
  });
  client.failCreate = 1;
  const lease = await manager.acquire("U-5", "observe");
  assert.equal(recovered, 1);
  assert.equal(client.created.length, 2);
  assert.equal(lease.sessionId, "s-1");
  lease.release();
});

test("appium session: dispose 清理会话并拒绝排队请求", async () => {
  const { client, manager } = makeManager();
  const lease = await manager.acquire("U-6", "task");
  const queued = manager.acquire("U-6", "task");
  await manager.dispose();
  await assert.rejects(queued, /已释放/);
  assert.deepEqual(client.deleted, ["s-1"]);
  lease.release();
});

test("CachedFrame 年龄与陈旧判定（capturedAtMs 优先、ISO 回退、0=关闭）", () => {
  const now = Date.now();
  const fresh = {
    png: Buffer.from("x"),
    capturedAt: new Date(now - 1_000).toISOString(),
    capturedAtMs: now - 1_000
  };
  const legacy = { png: Buffer.from("x"), capturedAt: new Date(now - 5_000).toISOString() };
  assert.equal(frameAgeMs(fresh, now), 1_000);
  assert.equal(frameAgeMs(legacy, now), 5_000);
  assert.equal(isFrameStale(fresh, now, 10_000), false);
  assert.equal(isFrameStale(fresh, now, 500), true);
  assert.equal(isFrameStale(fresh, now, 0), false);
  assert.equal(frameAgeMs({ png: Buffer.from("x"), capturedAt: "not-a-date" }, now), null);
});

test("resolveCachedFrameMaxAgeMs：默认 10min、0=关闭、非法回退默认", () => {
  assert.equal(resolveCachedFrameMaxAgeMs({}), 600_000);
  assert.equal(resolveCachedFrameMaxAgeMs({ AOS_IOS_CACHED_FRAME_MAX_AGE_MS: "0" }), 0);
  assert.equal(resolveCachedFrameMaxAgeMs({ AOS_IOS_CACHED_FRAME_MAX_AGE_MS: "5000" }), 5_000);
  assert.equal(resolveCachedFrameMaxAgeMs({ AOS_IOS_CACHED_FRAME_MAX_AGE_MS: "-3" }), 600_000);
});
