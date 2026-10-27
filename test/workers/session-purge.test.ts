// Idle-session purge for the MCP session object, against the real DO.
//
// Every MCP session gets its own KagiMcpSession object, and abandoned
// sessions used to keep their storage forever (25,967 objects, 3.4 GB).
// Activity arms an idempotent 7-day interval schedule; when it fires on a
// session idle past the policy, the object wipes its own storage.
//
// Runs in workerd: the schedule and storage APIs live on the DO state.

import type { Connection, ConnectionContext, WSMessage } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  LAST_ACTIVITY_KEY,
  SESSION_IDLE_TTL_MS,
  SESSION_PURGE_INTERVAL_S,
} from "../../src/mcp/session-purge";

/** A fresh session object per test — schedules and timestamps are sticky by design. */
let seq = 0;
function sessionStub() {
  seq += 1;
  // McpAgent requires the transport-prefixed naming scheme; anything else
  // fails in getTransportType during startup.
  return env.MCP_OBJECT.get(env.MCP_OBJECT.idFromName(`streamable-http:purge-test-${seq}`));
}

// The RPC stub types listSchedules() as returning never[] (the Rpc stub
// mapping cannot represent the Schedule union), so the tests below read it
// through this structural shape and assert the runtime values instead.
interface ListedSchedule {
  callback: string;
  type: string;
  time: number;
  intervalSeconds?: number;
}

async function listSchedules(
  stub: ReturnType<typeof sessionStub>,
): Promise<ListedSchedule[]> {
  return (await stub.listSchedules()) as unknown as ListedSchedule[];
}

describe("touchSession", () => {
  it("arms one 7-day interval schedule", async () => {
    const stub = sessionStub();
    await stub.touchSession();

    const schedules = await listSchedules(stub);
    expect(schedules).toHaveLength(1);
    const [schedule] = schedules;
    expect(schedule.callback).toBe("purgeIfIdle");
    expect(schedule.type).toBe("interval");
    expect(schedule.intervalSeconds).toBe(SESSION_PURGE_INTERVAL_S);
    const nowS = Math.floor(Date.now() / 1000);
    expect(schedule.time).toBeGreaterThan(nowS + SESSION_PURGE_INTERVAL_S - 120);
    expect(schedule.time).toBeLessThanOrEqual(nowS + SESSION_PURGE_INTERVAL_S + 60);
  });

  it("re-touching does not duplicate the schedule", async () => {
    const stub = sessionStub();
    await stub.touchSession();
    await stub.touchSession();

    expect(await listSchedules(stub)).toHaveLength(1);
  });

  it("records the last-activity timestamp", async () => {
    const stub = sessionStub();
    const before = Date.now();
    await stub.touchSession();

    await runInDurableObject(stub, async (_instance, state) => {
      const ts = await state.storage.get<number>(LAST_ACTIVITY_KEY);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(Date.now());
    });
  });
});

describe("purgeIfIdle", () => {
  it("keeps an active session", async () => {
    const stub = sessionStub();
    await stub.touchSession();
    await stub.purgeIfIdle();

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(LAST_ACTIVITY_KEY)).toBeTypeOf("number");
    });
    expect(await listSchedules(stub)).toHaveLength(1);
  });

  it("destroys a session idle past 7 days", async () => {
    const stub = sessionStub();
    await stub.touchSession();
    const stale = Date.now() - SESSION_IDLE_TTL_MS - 60_000;
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put(LAST_ACTIVITY_KEY, stale);
      // There is an alarm to cancel: without this pre-state, the null
      // below would pass vacuously.
      expect(await state.storage.getAlarm()).toBeTypeOf("number");
    });

    await stub.purgeIfIdle();

    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get(LAST_ACTIVITY_KEY)).toBeUndefined();
      const tables = state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray();
      expect(tables.map((t) => t.name)).not.toContain("cf_agents_jobs");
      // No alarm may survive the purge: a lingering one would wake the
      // empty object, whose onStart would re-arm it into a zombie that
      // wakes every 7 days forever (no timestamp means keep). deleteAll
      // already disarms at this compat date; this pins the end state.
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});

describe("onStart", () => {
  it("arms the schedule without recording activity", async () => {
    const stub = sessionStub();
    // purgeIfIdle is a bare RPC: it starts the object (onStart) with no
    // client activity behind it, exactly like an alarm wake does. It keeps
    // the fresh object (no activity timestamp yet) and must leave none.
    await stub.purgeIfIdle();

    const schedules = await listSchedules(stub);
    expect(schedules).toHaveLength(1);
    expect(schedules[0].callback).toBe("purgeIfIdle");
    await runInDurableObject(stub, async (_instance, state) => {
      // The alarm path must never look like activity: if onStart touched,
      // every purge check would find a fresh session and nothing would
      // ever be destroyed.
      expect(await state.storage.get(LAST_ACTIVITY_KEY)).toBeUndefined();
    });
  });
});

describe("activity hooks", () => {
  it("onConnect records activity after the transport handshake", async () => {
    const stub = sessionStub();
    await stub.touchSession();
    const old = Date.now() - 3600_000;

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put(LAST_ACTIVITY_KEY, old);
      // The transport handshake sends protocol frames on connect, so the
      // fake connection needs a send sink; nothing else is touched.
      const conn = { send: () => {} } as unknown as Connection;
      await instance.onConnect(conn, {
        request: new Request("https://test/mcp"),
      } as unknown as ConnectionContext);
      const ts = await state.storage.get<number>(LAST_ACTIVITY_KEY);
      expect(ts).toBeGreaterThan(old);
    });
  });

  it("onMessage records activity", async () => {
    const stub = sessionStub();
    await stub.touchSession();
    const old = Date.now() - 3600_000;

    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.put(LAST_ACTIVITY_KEY, old);
      await instance.onMessage({} as unknown as Connection, "ping" as unknown as WSMessage);
      const ts = await state.storage.get<number>(LAST_ACTIVITY_KEY);
      expect(ts).toBeGreaterThan(old);
    });
  });
});
