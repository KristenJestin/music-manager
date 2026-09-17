/**
 * Both sides of the rule, because a rule with only one side tested is a rule that fails open.
 *
 * The first half is the incident: a 503 from MusicBrainz must be a wait. The second half is
 * what pays for it: a 404, a parse error, a bad MBID and an `INVALID_INPUT` must still fail on
 * the spot, or "retry the upstream failures" becomes "retry everything, for ever".
 */
import { describe, expect, it } from "vitest";
import { MMError } from "@mm/contracts";
import { sourceHttpError } from "#/server/integrations/http.ts";
import {
  classifyFailure,
  describeHold,
  isUpstreamFailure,
  planUpstreamRetry,
  sourceOf,
  UPSTREAM_EXHAUSTED_CODE,
  wasKilledByASource,
} from "./upstream.ts";

const POLICY = { maxAttempts: 6, baseMs: 30_000, maxMs: 3_600_000 };

/** The body, as it would be stored — which is the only form the machine ever reads. */
const body = (error: MMError) => error.toBody();

describe("classifyFailure — the source is busy", () => {
  it("calls a 503 from MusicBrainz upstream: the incident, in one line", () => {
    const error = sourceHttpError("musicbrainz", "https://musicbrainz.org/ws/2/release/x", 503);
    expect(classifyFailure(body(error))).toBe("upstream");
  });

  it("calls a 429 upstream", () => {
    expect(classifyFailure(body(sourceHttpError("musicbrainz", "https://x", 429)))).toBe(
      "upstream",
    );
  });

  it("calls every 5xx upstream, not only the ones we have seen", () => {
    for (const status of [500, 502, 503, 504, 599]) {
      expect(classifyFailure(body(sourceHttpError("musicbrainz", "https://x", status)))).toBe(
        "upstream",
      );
    }
  });

  it("calls a transport failure upstream — it has no status at all", () => {
    const error = new MMError("SOURCE_UNREACHABLE", "musicbrainz did not answer (TypeError).", {
      details: { source: "musicbrainz" },
      retryable: true,
    });
    expect(classifyFailure(body(error))).toBe("upstream");
  });

  it("calls a timeout upstream", () => {
    expect(classifyFailure(body(new MMError("TIMEOUT", "took too long")))).toBe("upstream");
  });

  it("calls the toolbox being down upstream", () => {
    expect(classifyFailure(body(new MMError("TOOLBOX_UNREACHABLE", "no toolbox")))).toBe(
      "upstream",
    );
  });

  it("reads `retryable` off the stored body, not off the live error", () => {
    // The whole point of putting the flag on the body: a row read back a day later still
    // classifies the way the process that wrote it did.
    const stored = JSON.parse(
      JSON.stringify(body(sourceHttpError("lrclib", "https://x", 503))),
    ) as Record<string, unknown>;
    expect(stored["retryable"]).toBe(true);
    expect(isUpstreamFailure(stored as never)).toBe(true);
  });
});

describe("classifyFailure — the import is broken", () => {
  it("calls a 404 a defect: waiting will not invent the release", () => {
    expect(classifyFailure(body(sourceHttpError("musicbrainz", "https://x", 404)))).toBe("defect");
  });

  it("calls a parse error a defect even though the call itself went through", () => {
    const error = new MMError("SOURCE_BAD_RESPONSE", "musicbrainz answered something else.", {
      details: { source: "musicbrainz" },
      // Deliberately flagged retryable: the code wins, because re-asking gets the same bytes.
      retryable: true,
    });
    expect(classifyFailure(body(error))).toBe("defect");
  });

  it("calls a bad url or a bad MBID a defect", () => {
    expect(classifyFailure(body(new MMError("INVALID_INPUT", 'Not a uuid: "nope".')))).toBe(
      "defect",
    );
  });

  it("calls every other 4xx a defect", () => {
    for (const status of [400, 401, 403, 410, 422]) {
      expect(classifyFailure(body(sourceHttpError("musicbrainz", "https://x", status)))).toBe(
        "defect",
      );
    }
  });

  it("refuses to promote our own bugs, which MMError marks retryable by default", () => {
    // `UNKNOWN` is in MMError's own RETRYABLE set, so `retryable` alone would have made a
    // TypeError in this repository look like a busy MusicBrainz and retried it six times.
    const ours = MMError.from(new TypeError("cannot read properties of undefined"));
    expect(ours.retryable).toBe(true);
    expect(classifyFailure(body(ours))).toBe("defect");
  });

  it("calls a step that failed without an error a defect", () => {
    expect(classifyFailure(null)).toBe("defect");
    expect(classifyFailure(undefined)).toBe("defect");
  });

  it("does not restart the ladder on a job that already exhausted it", () => {
    const given = new MMError(UPSTREAM_EXHAUSTED_CODE, "musicbrainz refused 6 times.", {
      details: { source: "musicbrainz" },
      retryable: true,
    });
    expect(classifyFailure(body(given))).toBe("defect");
  });

  it("calls a missing MusicBrainz contact a settings error, not a busy server", () => {
    expect(classifyFailure(body(new MMError("MB_CONTACT_MISSING", "no contact")))).toBe("defect");
  });

  /*
   * The end condition of `mm retry --failed-step resolve`.
   *
   * Nineteen of the owner's twenty playlists are alive and lost one entry; the twentieth may
   * genuinely be gone, and the requeue has to be able to *stop* on it. The toolbox now says so
   * in its own word — `PLAYLIST_UNAVAILABLE`, a 404 about the playlist rather than
   * `YTDLP_UNAVAILABLE` about a video inside it — and the rule must read that 404 the way it
   * reads every other one. A code the ladder called `upstream` would put the import back on
   * the queue with a growing delay for ever, which is the loop this test exists to forbid.
   *
   * `wasKilledByASource` says no for the same reason `--failed-upstream` was the wrong
   * instrument for these twenty: nothing here is waiting on a busy server.
   */
  it("calls a deleted playlist a defect, so a requeue of the twenty can end", () => {
    const gone = new MMError("PLAYLIST_UNAVAILABLE", "This playlist no longer exists.", {
      hint: "The playlist itself was deleted, or the id is wrong.",
      status: 404,
    });
    expect(classifyFailure(body(gone))).toBe("defect");
    expect(isUpstreamFailure(body(gone))).toBe(false);
    expect(wasKilledByASource(body(gone))).toBe(false);
  });

  /* Its two neighbours, which are about the same URL and mean different things. */
  it("calls a private playlist and an unreadable entry defects too", () => {
    const priv = new MMError("PLAYLIST_PRIVATE", "This playlist is private.", { status: 403 });
    const entry = new MMError(
      "PLAYLIST_ENTRY_UNAVAILABLE",
      "An entry of this playlist could not be read.",
      { status: 404 },
    );
    expect(classifyFailure(body(priv))).toBe("defect");
    expect(classifyFailure(body(entry))).toBe("defect");
  });
});

describe("wasKilledByASource — a different question from 'should we wait?'", () => {
  it("claims the job whose ladder ran out, which `classifyFailure` deliberately does not", () => {
    // These two disagreeing is the design, and getting it wrong once already made the bulk
    // requeue answer "nothing to do" about the very rows it exists for.
    const exhausted = body(
      new MMError(UPSTREAM_EXHAUSTED_CODE, "musicbrainz refused 6 times.", {
        details: { source: "musicbrainz" },
      }),
    );
    expect(classifyFailure(exhausted)).toBe("defect");
    expect(wasKilledByASource(exhausted)).toBe(true);
  });

  it("claims the rows the forty-five actually carry, written before that code existed", () => {
    // A 503 stored in September reads `SOURCE_UNAVAILABLE` with `status: 503`. No migration,
    // no back-fill: the rule recognises them as they are.
    expect(wasKilledByASource(body(sourceHttpError("musicbrainz", "https://x", 503)))).toBe(true);
  });

  it("never claims a broken import", () => {
    expect(wasKilledByASource(body(sourceHttpError("musicbrainz", "https://x", 404)))).toBe(false);
    expect(wasKilledByASource(body(new MMError("INVALID_INPUT", "bad mbid")))).toBe(false);
    expect(wasKilledByASource(body(MMError.from(new TypeError("our bug"))))).toBe(false);
    expect(wasKilledByASource(null)).toBe(false);
  });
});

describe("sourceOf", () => {
  it("names the source that refused, so the row can say who we are waiting on", () => {
    expect(sourceOf(body(sourceHttpError("musicbrainz", "https://x", 503)))).toBe("musicbrainz");
    expect(sourceOf(body(new MMError("TIMEOUT", "slow")))).toBe(null);
  });
});

describe("planUpstreamRetry", () => {
  it("grows the delay, one doubling per attempt", () => {
    expect(planUpstreamRetry(0, POLICY)).toEqual({
      action: "hold",
      attempt: 1,
      delayMs: 30_000,
    });
    expect(planUpstreamRetry(1, POLICY).delayMs).toBe(60_000);
    expect(planUpstreamRetry(2, POLICY).delayMs).toBe(120_000);
    expect(planUpstreamRetry(3, POLICY).delayMs).toBe(240_000);
  });

  it("caps the delay, so the sixth attempt is not tomorrow", () => {
    const capped = planUpstreamRetry(4, { maxAttempts: 20, baseMs: 30_000, maxMs: 300_000 });
    expect(capped.delayMs).toBe(300_000);
  });

  it("gives up once the cap on attempts is passed", () => {
    expect(planUpstreamRetry(5, POLICY).action).toBe("hold");
    expect(planUpstreamRetry(6, POLICY)).toEqual({ action: "giveUp", attempt: 7, delayMs: 0 });
  });

  it("gives up immediately when the policy allows nothing", () => {
    expect(planUpstreamRetry(0, { ...POLICY, maxAttempts: 0 }).action).toBe("giveUp");
  });
});

describe("describeHold", () => {
  it("says who, which attempt, and when — the sentence the owner asked for", () => {
    const decision = planUpstreamRetry(2, POLICY);
    expect(describeHold(decision, POLICY, "musicbrainz")).toBe(
      "waiting on musicbrainz, attempt 3 of 6, next try in 2 min",
    );
  });

  it("falls back to 'the source' when the error did not name one", () => {
    expect(describeHold(planUpstreamRetry(0, POLICY), POLICY, null)).toBe(
      "waiting on the source, attempt 1 of 6, next try in 30s",
    );
  });
});
