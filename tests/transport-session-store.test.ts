import { describe, expect, test } from "vitest";
import { TransportSessionStore } from "../src/runtime/transport-session-store.js";

class TestTransport {
  closeCalls = 0;

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

describe("TransportSessionStore", () => {
  test("bounds committed sessions and outstanding reservations", async () => {
    const store = new TransportSessionStore<TestTransport>({ maxSessions: 2, idleTtlMs: 60_000 });
    const first = await store.reserve();
    const second = await store.reserve();

    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(await store.reserve()).toBeUndefined();

    first?.commit("__proto__", new TestTransport());
    second?.commit("second", new TestTransport());
    expect(store.size).toBe(2);
    expect(store.get("__proto__")).toBeInstanceOf(TestTransport);
  });

  test("releasing a reservation returns its capacity", async () => {
    const store = new TransportSessionStore<TestTransport>({ maxSessions: 1, idleTtlMs: 60_000 });
    const reservation = await store.reserve();
    reservation?.release();

    expect(await store.reserve()).toBeDefined();
  });

  test("expires idle sessions and closes their transports", async () => {
    let now = 1_000;
    const store = new TransportSessionStore<TestTransport>({
      maxSessions: 2,
      idleTtlMs: 100,
      now: () => now
    });
    const idle = new TestTransport();
    const active = new TestTransport();
    (await store.reserve())?.commit("idle", idle);
    (await store.reserve())?.commit("active", active);

    now = 1_080;
    expect(store.get("active")).toBe(active);
    now = 1_150;
    const result = await store.sweepExpired();

    expect(result).toEqual({ expired: 1, close_failures: 0 });
    expect(store.get("idle")).toBeUndefined();
    expect(store.get("active")).toBe(active);
    expect(idle.closeCalls).toBe(1);
    expect(active.closeCalls).toBe(0);
  });

  test("close removes one session and closes its transport exactly once", async () => {
    const store = new TransportSessionStore<TestTransport>({ maxSessions: 1, idleTtlMs: 60_000 });
    const transport = new TestTransport();
    (await store.reserve())?.commit("session", transport);

    await expect(store.close("session")).resolves.toBe(true);
    await expect(store.close("session")).resolves.toBe(false);
    expect(store.get("session")).toBeUndefined();
    expect(transport.closeCalls).toBe(1);
  });

  test("closeAll releases every transport during shutdown", async () => {
    const store = new TransportSessionStore<TestTransport>({ maxSessions: 2, idleTtlMs: 60_000 });
    const first = new TestTransport();
    const second = new TestTransport();
    (await store.reserve())?.commit("first", first);
    (await store.reserve())?.commit("second", second);

    await expect(store.closeAll()).resolves.toEqual({ closed: 2, close_failures: 0 });
    expect(store.size).toBe(0);
    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(1);
  });
});
