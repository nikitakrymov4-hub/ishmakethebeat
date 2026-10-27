import test from "node:test";
import assert from "node:assert/strict";
import { yieldRenderTask } from "../src/io/export";

function replaceGlobal(name: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
  return () => {
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  };
}

test("render yield uses the scheduler with its receiver when available", async () => {
  let called = 0;
  const scheduler = {
    yield() {
      assert.equal(this, scheduler);
      called++;
      return Promise.resolve();
    },
  };
  const restoreScheduler = replaceGlobal("scheduler", scheduler);
  const restoreChannel = replaceGlobal(
    "MessageChannel",
    class {
      constructor() {
        throw new Error("Fallback should not run");
      }
    },
  );
  try {
    await yieldRenderTask();
    assert.equal(called, 1);
  } finally {
    restoreChannel();
    restoreScheduler();
  }
});

test("MessageChannel fallback yields beyond microtasks without depending on timers", async () => {
  const restoreScheduler = replaceGlobal("scheduler", undefined);
  const restoreTimer = replaceGlobal("setTimeout", () => {
    throw new Error("Timer clamping must not affect render task yielding");
  });
  try {
    const order: string[] = [];
    const task = yieldRenderTask().then(() => order.push("task"));
    order.push("sync");
    await Promise.resolve();
    order.push("microtask");
    assert.deepEqual(order, ["sync", "microtask"]);
    await task;
    assert.deepEqual(order, ["sync", "microtask", "task"]);
  } finally {
    restoreTimer();
    restoreScheduler();
  }
});
