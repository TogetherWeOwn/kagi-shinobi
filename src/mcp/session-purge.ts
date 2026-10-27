// Idle-session purge policy for the MCP Durable Object.
//
// Every MCP session gets its own object (KagiMcpSession), and nothing deleted
// a session's storage once the client went away — 25,967 objects and 3.4 GB
// by 2026-10-27. The objects hold no result cache (that is ResultCache) and
// no long-term value, so sessions idle past the operator's 7-day policy are
// destroyed: the DO arms an idempotent 7-day interval schedule on every
// activity (see touchSession in ../mcp.ts), and purgeIfIdle wipes the object
// when the schedule finds 7+ days of idleness.
//
// The interval is idempotent on (callback, interval, payload), so re-arming
// is a no-op while the schedule exists — no cancel/reschedule race, and an
// object can never be left with zero schedules by a failed re-arm. The
// trade-off against a one-shot now+7d alarm is the worst-case retention: a
// session that goes idle just after a check waits almost two intervals, so
// stale storage lingers up to ~14 days instead of ~7. Steady state is still
// ~10 days of session writes, far under the plan's 5 GB.

/** Seconds between idle-purge checks. The Agents Scheduler caps this at 30 days. */
export const SESSION_PURGE_INTERVAL_S = 7 * 24 * 3600;

/** Idle time after which a session is destroyed. Single source: the interval above. */
export const SESSION_IDLE_TTL_MS = SESSION_PURGE_INTERVAL_S * 1000;

/** Durable storage key for the last-activity timestamp (unix millis). */
export const LAST_ACTIVITY_KEY = "lastActivityAt";

/**
 * Whether a session last active at `lastActivityAt` may be destroyed now.
 *
 * A missing timestamp keeps the session: destruction needs positive
 * evidence of idleness, so a schedule that outlives its timestamp (or a
 * clock that jumped) never wipes an object it cannot account for.
 */
export function shouldPurgeSession(
  lastActivityAt: number | undefined,
  nowMs: number,
): boolean {
  if (lastActivityAt === undefined) return false;
  return nowMs - lastActivityAt >= SESSION_IDLE_TTL_MS;
}
