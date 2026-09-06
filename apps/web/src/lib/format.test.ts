import { describe, expect, it } from "vitest";
import {
  bytes,
  clockTime,
  coverIndex,
  delta,
  humanise,
  mmss,
  pct,
  pctWidth,
  short,
  timeAgo,
  totalSeconds,
} from "./format.ts";

/**
 * The formatting vocabulary of the Console.
 *
 * Every one of these is fed straight from a nullable database column, so the null case is not
 * an edge case — it is the case that happens on the first render of every page, before a job
 * has a duration or a release has a year. An em dash is the answer, never `NaN:aN`.
 */
describe("mmss", () => {
  it("formats minutes and seconds", () => {
    expect(mmss(0)).toBe("0:00");
    expect(mmss(59)).toBe("0:59");
    expect(mmss(320)).toBe("5:20");
    expect(mmss(600)).toBe("10:00");
  });

  it("adds an hour component past 3600 seconds", () => {
    expect(mmss(3600)).toBe("1:00:00");
    expect(mmss(3723)).toBe("1:02:03");
  });

  it("answers with a dash rather than NaN", () => {
    expect(mmss(null)).toBe("--:--");
    expect(mmss(undefined)).toBe("--:--");
    expect(mmss(Number.NaN)).toBe("--:--");
  });
});

describe("pct", () => {
  it("rounds a [0, 1] score to whole percent", () => {
    expect(pct(0.9712)).toBe("97%");
    expect(pct(0)).toBe("0%");
    expect(pct(1)).toBe("100%");
  });

  it("answers with a dash for an unknown score", () => {
    expect(pct(null)).toBe("n/a");
  });
});

describe("pctWidth", () => {
  it("clamps to the bar's range", () => {
    expect(pctWidth(0.5)).toBe("50%");
    expect(pctWidth(-3)).toBe("0%");
    expect(pctWidth(9)).toBe("100%");
    expect(pctWidth(null)).toBe("0%");
  });
});

describe("bytes", () => {
  it("uses binary units, like every disk tool on the machine", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(512)).toBe("512 B");
    expect(bytes(1024)).toBe("1.0 KB");
    expect(bytes(1024 * 1024 * 1.5)).toBe("1.5 MB");
  });

  it("drops the decimal above 100 of a unit, where it is noise", () => {
    expect(bytes(1024 * 150)).toBe("150 KB");
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-09-06T12:00:00Z");

  it("describes the recent past in the unit that reads best", () => {
    expect(timeAgo(new Date("2026-09-06T11:59:30Z"), now)).toBe("just now");
    expect(timeAgo(new Date("2026-09-06T11:48:00Z"), now)).toBe("12 min ago");
    expect(timeAgo(new Date("2026-09-06T09:00:00Z"), now)).toBe("3 h ago");
    expect(timeAgo(new Date("2026-09-04T12:00:00Z"), now)).toBe("2 d ago");
  });

  it("falls back to a date beyond a fortnight", () => {
    expect(timeAgo(new Date("2026-01-04T12:00:00Z"), now)).toMatch(/Jan/);
  });

  it("accepts the ISO strings a server function sends", () => {
    expect(timeAgo("2026-09-06T11:48:00.000Z", now)).toBe("12 min ago");
  });

  it("never renders Invalid Date", () => {
    expect(timeAgo(null, now)).toBe("never");
    expect(timeAgo("not a date", now)).toBe("never");
  });
});

describe("clockTime", () => {
  it("is stable for the log viewer's first column", () => {
    expect(clockTime("2026-09-06T12:00:00Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(clockTime(null)).toBe("--:--:--");
  });
});

describe("delta", () => {
  it("signs the difference with a real minus sign", () => {
    expect(delta(2)).toBe("+2s");
    expect(delta(-3)).toBe("−3s");
    expect(delta(0)).toBe("0s");
    expect(delta(null)).toBe("n/a");
  });
});

describe("short", () => {
  it("keeps enough of an MBID to recognise it", () => {
    expect(short("d073287b-d1bd-4f11-a933-a4386f8cf701")).toBe("d073287b");
    expect(short(null)).toBe("none");
    expect(short("")).toBe("none");
  });
});

describe("humanise", () => {
  it("turns an enum value into words", () => {
    expect(humanise("uncovered_tracks")).toBe("uncovered tracks");
  });
});

describe("totalSeconds", () => {
  it("skips the durations yt-dlp did not report", () => {
    expect(totalSeconds([320, null, 207, undefined])).toBe(527);
  });
});

describe("coverIndex", () => {
  it("is stable, so an album is the same colour on every page", () => {
    expect(coverIndex("imp_01M1T8HTSP31YSYZ3CVXDSMZ50")).toBe(
      coverIndex("imp_01M1T8HTSP31YSYZ3CVXDSMZ50"),
    );
  });

  it("stays inside the eleven gradients styles.css defines", () => {
    for (const seed of ["", "a", "Discovery", "d073287b-d1bd-4f11-a933-a4386f8cf701"]) {
      const index = coverIndex(seed);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(11);
    }
  });
});
