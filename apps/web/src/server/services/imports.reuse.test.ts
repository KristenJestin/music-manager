/**
 * The status-by-status decision of `imports.reuse.ts`, one case per status.
 *
 * Pure: `pickReusable` takes rows and a set of ids, so the table in that file's header is
 * checked here without a database, without a toolbox and without a worker. The integration
 * test beside it checks that the same rule survives a real `createImport`.
 */
import { describe, expect, it } from "vitest";
import { IMPORT_STATUSES, type ImportStatus, type StepName } from "#/server/db/schema/enums.ts";
import type { Import } from "#/server/db/schema/index.ts";
import { isParked, pickReusable } from "./imports.reuse.ts";

const URL = "fixture://discovery";

function row(
  id: string,
  status: ImportStatus,
  extra: { step?: StepName; pausedBy?: "user" | "worker" | null; createdAt?: Date } = {},
): Import {
  const at = extra.createdAt ?? new Date("2026-09-01T10:00:00Z");
  return {
    id,
    url: URL,
    kind: "album",
    status,
    pausedBy: extra.pausedBy ?? (status === "paused" ? "user" : null),
    step: extra.step ?? "match",
    options: {},
    releaseMbid: null,
    releaseGroupMbid: null,
    title: null,
    artist: null,
    year: null,
    priority: 0,
    error: null,
    upstreamAttempts: 0,
    nextAttemptAt: null,
    createdAt: at,
    updatedAt: at,
    startedAt: null,
    finishedAt: null,
  };
}

/**
 * The three statuses a row may carry and still be re-entered, on its columns alone.
 *
 * `running` is in the list because a creation in flight wears it; whether *that* `running` is
 * a creation or the worker is a question for `job_steps`, asked by `importsThatHaveWorked` and
 * supplied here as the second argument to `pickReusable`.
 */
const REUSED: readonly ImportStatus[] = ["pending", "running", "paused"];

describe("which import a wizard entrance re-enters", () => {
  it("re-enters the import the wizard itself parked — the whole defect", () => {
    const parked = row("imp_parked", "paused");
    expect(pickReusable([parked], new Set())).toBe(parked);
  });

  it("re-enters a `pending` import: that is the double-click window", () => {
    // The row a concurrent caller has just inserted and not yet resolved.
    const fresh = row("imp_fresh", "pending", { step: "resolve" });
    expect(pickReusable([fresh], new Set())).toBe(fresh);
  });

  /*
   * The row the owner's four duplicates were all about.
   *
   * `runStep` marks an import `running` for the whole of `resolve` — the minute-long extraction
   * the wizard's `?url=` loader waits on — and a successful `resolve` leaves it `running` at
   * `match`. A rule that refused every `running` row refused the one row every re-entry inside
   * that minute is about.
   */
  it("re-enters a `running` import that nothing has worked on: the creation in flight", () => {
    for (const step of ["resolve", "match"] as const) {
      const creating = row(`imp_creating_${step}`, "running", { step });
      expect(isParked(creating), step).toBe(true);
      expect(pickReusable([creating], new Set()), step).toBe(creating);
    }
  });

  /*
   * And the other `running`, which `status` alone cannot tell from the one above: the worker is
   * in `match`, or further. `importsThatHaveWorked` is what answers it, from `job_steps`; here
   * that answer is the second argument.
   */
  it("does not re-enter a `running` import something has already worked on", () => {
    const busy = row("imp_busy", "running");
    expect(pickReusable([busy], new Set(["imp_busy"]))).toBeNull();
  });

  it("does not re-enter a `done` import: the duplicate is announced, a new import is opened", () => {
    expect(pickReusable([row("imp_done", "done")], new Set())).toBeNull();
  });

  it("does not re-enter a `cancelled` import: somebody said no to that one", () => {
    expect(pickReusable([row("imp_cancelled", "cancelled")], new Set())).toBeNull();
  });

  it("does not re-enter a `failed` import: the row is the record, and `mm retry` is its door", () => {
    expect(pickReusable([row("imp_failed", "failed")], new Set())).toBeNull();
  });

  it("does not re-enter `awaiting_confirm` or `awaiting_review`: the answer lives in Review", () => {
    expect(pickReusable([row("imp_c", "awaiting_confirm")], new Set())).toBeNull();
    expect(pickReusable([row("imp_r", "awaiting_review")], new Set())).toBeNull();
  });

  it("does not re-enter `waiting_upstream`: it is running slowly, not stopped", () => {
    expect(pickReusable([row("imp_up", "waiting_upstream")], new Set())).toBeNull();
  });

  it("does not re-enter an import the **worker** paused: the boot sweep owns those", () => {
    const shutdown = row("imp_shutdown", "paused", { pausedBy: "worker" });
    expect(isParked(shutdown)).toBe(false);
    expect(pickReusable([shutdown], new Set())).toBeNull();
  });

  it("reads a null `paused_by` as the owner's pause, which is the side it is safe to reuse", () => {
    const old = row("imp_old", "paused", { pausedBy: null });
    expect(pickReusable([old], new Set())).toBe(old);
  });

  it("never re-enters an import past `match`, whatever its status says", () => {
    const parkedLate = row("imp_late", "paused", { step: "download" });
    expect(isParked(parkedLate)).toBe(false);
    expect(pickReusable([parkedLate], new Set())).toBeNull();
  });

  it("never re-enters an import whose tracks have done work", () => {
    const parked = row("imp_worked", "paused");
    expect(pickReusable([parked], new Set(["imp_worked"]))).toBeNull();
  });

  it("covers every status at both early steps, so a new one cannot be forgotten", () => {
    for (const step of ["resolve", "match"] as const) {
      for (const status of IMPORT_STATUSES) {
        const candidate = row(`imp_${status}_${step}`, status, { step });
        const picked = pickReusable([candidate], new Set());
        expect(picked === null, `status ${status} at ${step}`).toBe(!REUSED.includes(status));
      }
    }
  });

  it("and refuses every one of them once something has worked on it", () => {
    for (const status of IMPORT_STATUSES) {
      const id = `imp_worked_${status}`;
      const candidate = { ...row(id, status), id };
      expect(pickReusable([candidate], new Set([id])), status).toBeNull();
    }
  });

  it("takes the newest reusable row and ignores the rest", () => {
    const newest = row("imp_new", "paused", { createdAt: new Date("2026-09-10T10:00:00Z") });
    const older = row("imp_older", "paused", { createdAt: new Date("2026-09-01T10:00:00Z") });
    // `createImport` hands them over newest first, as `order by created_at desc` produced them.
    expect(pickReusable([newest, older], new Set())).toBe(newest);
  });

  it("falls through a `done` row to the parked one behind it", () => {
    const finished = row("imp_done", "done", { createdAt: new Date("2026-09-10T10:00:00Z") });
    const parked = row("imp_parked", "paused", { createdAt: new Date("2026-09-01T10:00:00Z") });
    expect(pickReusable([finished, parked], new Set())).toBe(parked);
  });
});
