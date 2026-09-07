// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MappingLine, ReleaseCandidate, ReleaseGroupCandidate } from "@mm/domain";
import { Callout } from "./callout.tsx";
import { Cover, coverArtFront } from "./cover.tsx";
import { DataTable } from "./data-table.tsx";
import { KeyValueList } from "./key-value.tsx";
import { LogViewer } from "./log-viewer.tsx";
import { MappingRow } from "./mapping-row.tsx";
import { PipelineDots } from "./pipeline-dots.tsx";
import { ReleaseCandidateCard } from "./candidate-card.tsx";
import { ReleaseGroupCard } from "./candidate-group.tsx";
import { ReviewCard } from "./review-card.tsx";
import { ScoreBar } from "./score-bar.tsx";
import { SignalsRow } from "./signals-row.tsx";
import { Stepper } from "./stepper.tsx";
import { TrackProgress } from "./track-progress.tsx";
import { ImportStatusBadge, scoreTone } from "./status-badge.tsx";
import type { InboxCard } from "#/server/functions/inbox.ts";
import type { MappingCandidateTrack, SourceVideo } from "#/server/functions/wizard.ts";

/**
 * The shared components, at the level that matters: **what they claim**.
 *
 * These are not snapshot tests. Every assertion below is a statement the Console makes to the
 * person reading it — "this candidate was preselected", "this video is bound to track 6",
 * "seven of fifteen tracks are placed" — and the point of testing them is that a refactor
 * which quietly stops making one of those statements is a bug, however pretty the result.
 */
afterEach(cleanup);

const candidate: ReleaseCandidate = {
  id: "d073287b-d1bd-4f11-a933-a4386f8cf701",
  releaseGroupId: null,
  title: "Discovery",
  artist: "Daft Punk",
  date: "2001-02-26",
  year: 2001,
  country: "FR",
  format: "CD",
  label: "Virgin",
  status: "Official",
  type: "Album",
  secondary: [],
  disambiguation: "",
  barcode: null,
  tracks: 14,
  score: 0.97,
  fit: 13,
  fitOf: 14,
  uncovered: 0,
  leftOver: 1,
  videos: 15,
  durDelta: 0.619,
  signals: {
    title: 1,
    artist: 1,
    trackCount: 0.9,
    durations: 0.93,
    coverage: 0.933,
    year: 1,
    label: 0.4,
    format: 1,
    status: 1,
    country: 1,
  },
  fitLines: [
    {
      videoIndex: 0,
      videoTitle: "One More Time",
      trackPosition: 1,
      mediumPosition: 1,
      recordingMbid: "9c1b1f0e-0000-4000-8000-000000000001",
      trackMbid: null,
      trackTitle: "One More Time",
      delta: -1,
      status: "confident",
    },
    {
      videoIndex: 1,
      videoTitle: "Alive 1997 excerpt",
      trackPosition: null,
      mediumPosition: null,
      recordingMbid: null,
      trackMbid: null,
      trackTitle: null,
      delta: null,
      status: "unmatched",
    },
  ],
  penalties: [],
  why: ["Album title and artist match exactly", "13/14 tracks are covered by a video within ±2s"],
  preselected: true,
  safe: true,
  detailed: true,
};

describe("ReleaseCandidateCard", () => {
  it("shows the score, the fit and the preselection", () => {
    render(<ReleaseCandidateCard candidate={candidate} selected={false} onSelect={vi.fn()} />);
    expect(screen.getByTestId("candidate-score").textContent).toBe("97%");
    expect(screen.getByText("13/14")).toBeTruthy();
    expect(screen.getByText(/preselected/)).toBeTruthy();
  });

  it("keeps the reasons folded until asked, and unfolds them on “why?”", () => {
    /*
     * Folded, not unmounted (owner review 3, D1). The section stays in the DOM so there is a
     * closing frame to animate; `data-state` is what "closed" means for a reader and a test.
     */
    render(<ReleaseCandidateCard candidate={candidate} selected={false} onSelect={vi.fn()} />);
    expect(screen.getByTestId("candidate-why").dataset["state"]).toBe("closed");
    expect(screen.getByTestId("candidate-why").getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(screen.getByTestId("why-toggle"));
    const why = screen.getByTestId("candidate-why");
    expect(why.dataset["state"]).toBe("open");
    expect(within(why).getByText("Album title and artist match exactly")).toBeTruthy();
  });

  it("shows the reasons without asking on the card that is selected", () => {
    render(<ReleaseCandidateCard candidate={candidate} selected onSelect={vi.fn()} />);
    expect(screen.getByTestId("candidate-why").dataset["state"]).toBe("open");
  });

  it("says what pressing it does, and closes what is open (D1)", () => {
    /*
     * The button on the *selected* card used to be genuinely inert: `open || selected` meant
     * the flag it set was already outvoted, so "why?" did nothing at all on the one card whose
     * reasons were on screen. Now the label is the action and the action always happens.
     */
    render(<ReleaseCandidateCard candidate={candidate} selected onSelect={vi.fn()} />);
    const button = screen.getByTestId("why-toggle");
    expect(button.textContent).toContain("hide why");
    expect(button.dataset["state"]).toBe("open");
    fireEvent.click(button);
    expect(button.textContent).toContain("why?");
    expect(button.dataset["state"]).toBe("closed");
    expect(screen.getByTestId("candidate-why").dataset["state"]).toBe("closed");
  });

  it("shows both directions of the fit, never only the flattering one (D3)", () => {
    render(<ReleaseCandidateCard candidate={candidate} selected={false} onSelect={vi.fn()} />);
    expect(screen.getByTestId("candidate-coverage").textContent).toContain("14/15");
  });

  it("reports the id it was asked about, so the URL can hold the choice", () => {
    const onSelect = vi.fn();
    render(<ReleaseCandidateCard candidate={candidate} selected={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("candidate"));
    expect(onSelect).toHaveBeenCalledWith(candidate.id);
  });

  it("says when a candidate's fit was never checked, rather than showing 0/0", () => {
    render(
      <ReleaseCandidateCard
        candidate={{ ...candidate, detailed: false, fit: 0, fitOf: 0 }}
        selected={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("fit not checked")).toBeTruthy();
  });

  it("shows video ↔ track behind “tracklist fit”, which is what ordered the list", () => {
    render(<ReleaseCandidateCard candidate={candidate} selected={false} onSelect={vi.fn()} />);
    expect(screen.getByTestId("candidate-fit").dataset["state"]).toBe("closed");
    fireEvent.click(screen.getByTestId("fit-toggle"));
    const fit = screen.getByTestId("candidate-fit");
    expect(fit.dataset["state"]).toBe("open");
    expect(screen.getByTestId("fit-toggle").textContent).toContain("hide fit");
    expect(within(fit).getByText("Alive 1997 excerpt")).toBeTruthy();
    expect(within(fit).getByText("not on this release")).toBeTruthy();
  });

  it("says so rather than showing an empty table when no tracklist was fetched", () => {
    render(
      <ReleaseCandidateCard
        candidate={{ ...candidate, detailed: false, fitLines: [] }}
        selected={false}
        onSelect={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("fit-toggle"));
    expect(screen.getByText(/tracklist was not fetched/)).toBeTruthy();
  });

  it("names every penalty that lowered the score, exactly once", () => {
    /*
     * `why` already ends with the penalties, as percentages. The card used to render them a
     * second time from `candidate.penalties`, so the Bad Ideas deluxe pressing listed its
     * "deluxe" deduction twice — once as (−0.2) and once as (−20%).
     */
    render(
      <ReleaseCandidateCard
        candidate={{
          ...candidate,
          penalties: [{ reason: "Bootleg release", amount: 0.25 }],
          why: [...candidate.why, "Bootleg release (−25 %)"],
        }}
        selected
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByText(/Bootleg release/)).toHaveLength(1);
  });
});

describe("ReleaseGroupCard", () => {
  const inGroup = (over: Partial<ReleaseCandidate>): ReleaseCandidate => ({
    ...candidate,
    ...over,
  });

  const group: ReleaseGroupCandidate = {
    id: "g-album",
    title: "Bad Ideas",
    artist: "Tessa Violet",
    primaryType: "Album",
    secondaryTypes: [],
    firstReleaseDate: "2019-10-25",
    year: 2019,
    score: 1,
    searchScore: 0.97,
    releases: [inGroup({ id: "r-album", title: "Bad Ideas", preselected: true })],
    detailedCount: 1,
    preselected: true,
    why: ["Title matches exactly"],
  };

  const single: ReleaseGroupCandidate = {
    ...group,
    id: "g-single",
    primaryType: "Single",
    score: 0.29,
    searchScore: 0.5,
    releases: [
      inGroup({ id: "r-single", tracks: 1, fit: 1, fitOf: 1, leftOver: 10, preselected: false }),
    ],
    preselected: false,
    why: ["Filed as a Single, which is a poor shape for 11 videos"],
  };

  it("opens the best group and leaves the others shut", () => {
    render(
      <>
        <ReleaseGroupCard group={group} selected={null} onSelect={vi.fn()} defaultOpen />
        <ReleaseGroupCard group={single} selected={null} onSelect={vi.fn()} defaultOpen={false} />
      </>,
    );
    const [best, other] = screen.getAllByTestId("candidate-group");
    expect(best?.dataset["state"]).toBe("open");
    expect(other?.dataset["state"]).toBe("closed");
    // A shut group still says what is inside it, or it is not worth opening.
    expect(screen.getByTestId("group-summary").textContent).toMatch(/videos would find a track/);
  });

  it("shows a group score next to the release scores", () => {
    render(<ReleaseGroupCard group={single} selected={null} onSelect={vi.fn()} defaultOpen />);
    expect(screen.getByTestId("group-score").textContent).toBe("29%");
  });

  it("opens on its own header, and selecting stays a release-level decision", () => {
    const onSelect = vi.fn();
    render(
      <ReleaseGroupCard group={single} selected={null} onSelect={onSelect} defaultOpen={false} />,
    );
    fireEvent.click(screen.getByTestId("group-toggle"));
    expect(screen.getByTestId("candidate-group").dataset["state"]).toBe("open");
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("candidate"));
    expect(onSelect).toHaveBeenCalledWith("r-single");
  });
});

describe("MappingRow", () => {
  const video: SourceVideo = {
    id: "row_1",
    videoId: "vid_1",
    index: 0,
    title: "One More Time",
    durationSeconds: 320,
    uploader: "Daft Punk - Topic",
    ytTrack: "One More Time",
    thumbnail: "https://i.ytimg.com/vi/vid_1/maxresdefault.jpg",
  };
  const tracks: MappingCandidateTrack[] = [
    {
      absoluteIndex: 0,
      position: 1,
      mediumPosition: 1,
      title: "One More Time",
      lengthSeconds: 321,
      trackMbid: "trk_1",
      recordingMbid: "rec_1",
    },
    {
      absoluteIndex: 1,
      position: 2,
      mediumPosition: 1,
      title: "Aerodynamic",
      lengthSeconds: 208,
      trackMbid: "trk_2",
      recordingMbid: "rec_2",
    },
  ];
  const line: MappingLine = {
    videoId: "vid_1",
    videoIndex: 0,
    videoTitle: "One More Time",
    trackN: 1,
    mediumPosition: 1,
    trackMbid: "trk_1",
    recordingMbid: "rec_1",
    trackTitle: "One More Time",
    confidence: 0.98,
    signals: { title: 1, duration: 0.99, position: 1, ytTrackTag: 1 },
    delta: -1,
    status: "confident",
    why: [],
  };

  it("shows the duration difference against the bound track", () => {
    render(
      <MappingRow
        index={0}
        video={video}
        line={line}
        tracks={tracks}
        bound={0}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Δ −1s/)).toBeTruthy();
    expect(screen.getByTestId("mapping-row").dataset["status"]).toBe("confident");
  });

  it("becomes an extra video when nothing is bound", () => {
    render(
      <MappingRow
        index={0}
        video={video}
        line={{ ...line, trackN: null, status: "unmatched" }}
        tracks={tracks}
        bound={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("extra video")).toBeTruthy();
    expect(screen.getByTestId("mapping-row").dataset["status"]).toBe("unmatched");
  });

  it("offers every track of the release, plus “not on this release”", async () => {
    render(
      <MappingRow
        index={0}
        video={video}
        line={line}
        tracks={tracks}
        bound={0}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("mapping-select"));
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]?.textContent).toContain("not on this release");
  });

  it("reports an unbinding as null, not as an empty string", async () => {
    const onChange = vi.fn();
    render(
      <MappingRow
        index={0}
        video={video}
        line={line}
        tracks={tracks}
        bound={0}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("mapping-select"));
    const options = await screen.findAllByRole("option");
    const skip = options[0] as HTMLElement;
    fireEvent.pointerDown(skip);
    fireEvent.pointerUp(skip);
    fireEvent.click(skip);
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe("ReviewCard", () => {
  const card: InboxCard = {
    item: {
      id: "ibx_1",
      type: "uncovered_tracks",
      status: "open",
      importId: "imp_1",
      trackId: null,
      title: "2 track(s) of the release have no video",
      summary: "Positions 6, 9.",
      payload: { positions: [6, 9] },
      preselected: { action: "import anyway" },
      resolution: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    job: null,
    options: [
      {
        id: "partial",
        label: "Accept as partial",
        detail: "Import the 2 missing track(s) later.",
        preselected: true,
        value: { action: "import anyway", accepted: true },
      },
      {
        id: "cancel",
        label: "Cancel this import",
        preselected: false,
        value: { action: "cancel" },
      },
    ],
  };

  it("opens with the preselected answer chosen", () => {
    render(<ReviewCard card={card} busy={false} onConfirm={vi.fn()} />);
    const chosen = screen
      .getAllByTestId("review-option")
      .find((option) => option.getAttribute("aria-checked") === "true");
    expect(chosen?.dataset["optionId"]).toBe("partial");
  });

  it("confirms the preselection on Enter — the whole point of the queue", () => {
    const onConfirm = vi.fn();
    render(<ReviewCard card={card} busy={false} onConfirm={onConfirm} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({ id: "partial" });
  });

  it("confirms whatever was picked instead, once it is picked", () => {
    const onConfirm = vi.fn();
    render(<ReviewCard card={card} busy={false} onConfirm={onConfirm} />);
    fireEvent.click(screen.getAllByTestId("review-option")[1] as HTMLElement);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({ id: "cancel" });
  });

  it("ignores Enter while a decision is already being saved", () => {
    const onConfirm = vi.fn();
    render(<ReviewCard card={card} busy onConfirm={onConfirm} />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("lists the uncovered positions a supplied mapping reported", () => {
    render(<ReviewCard card={card} busy={false} onConfirm={vi.fn()} />);
    expect(screen.getByText("06")).toBeTruthy();
    expect(screen.getByText("09")).toBeTruthy();
  });
});

describe("PipelineDots", () => {
  it("marks everything done when the import is", () => {
    const { container } = render(<PipelineDots step="verify" status="done" />);
    expect(container.querySelectorAll("i.bg-ok")).toHaveLength(8);
  });

  it("marks the failing step red and the ones before it green", () => {
    const { container } = render(<PipelineDots step="tag" status="failed" />);
    expect(container.querySelectorAll("i.bg-danger")).toHaveLength(1);
    expect(container.querySelectorAll("i.bg-ok")).toHaveLength(5);
  });

  it("marks the step a human is being waited for in amber", () => {
    const { container } = render(<PipelineDots step="confirm" status="awaiting_review" />);
    expect(container.querySelectorAll("i.bg-warn")).toHaveLength(1);
  });
});

describe("Stepper", () => {
  it("walks back only to steps already completed", () => {
    const onSelect = vi.fn();
    render(
      <Stepper steps={["Source", "Match", "Mapping", "Options"]} current={2} onSelect={onSelect} />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith(0);
  });
});

describe("ScoreBar and its tone", () => {
  it("colours on the thresholds the Console uses everywhere", () => {
    expect(scoreTone(0.97)).toBe("ok");
    expect(scoreTone(0.7)).toBe("warn");
    expect(scoreTone(0.2)).toBe("danger");
    expect(scoreTone(null)).toBe("muted");
  });

  it("prints the number next to the bar", () => {
    render(<ScoreBar value={0.5} />);
    expect(screen.getByText("50%")).toBeTruthy();
  });
});

describe("SignalsRow", () => {
  it("names every signal and renders nothing when there are none", () => {
    const { container } = render(<SignalsRow signals={{ title: 1, durations: 0.5 }} />);
    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("Durations")).toBeTruthy();
    cleanup();
    const empty = render(<SignalsRow signals={null} />);
    expect(empty.container.textContent).toBe("");
    expect(container).toBeTruthy();
  });
});

describe("LogViewer", () => {
  it("says so when a job has not written anything yet", () => {
    render(<LogViewer events={[]} />);
    expect(screen.getByText("No journal lines yet.")).toBeTruthy();
  });

  it("shows the level, the step and the message of every line", () => {
    render(
      <LogViewer
        events={[
          {
            id: 1,
            importId: "imp_1",
            trackId: null,
            step: "download",
            level: "warn",
            type: "step.blocked",
            message: "Waiting for confirmation",
            data: null,
            at: "2026-09-06T12:00:00.000Z",
          },
        ]}
      />,
    );
    expect(screen.getByText("warn")).toBeTruthy();
    expect(screen.getByText("download")).toBeTruthy();
    expect(screen.getByText("Waiting for confirmation")).toBeTruthy();
  });
});

describe("DataTable", () => {
  it("renders the empty message rather than an empty box", () => {
    render(
      <DataTable
        columns={[{ key: "a", header: "A", cell: (row: { a: string }) => row.a }]}
        rows={[]}
        rowKey={() => "k"}
        empty="No jobs yet."
      />,
    );
    expect(screen.getByText("No jobs yet.")).toBeTruthy();
  });

  it("makes a row clickable when there is somewhere to go", () => {
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={[{ key: "a", header: "A", cell: (row: { a: string }) => row.a }]}
        rows={[{ a: "one" }]}
        rowKey={(row) => row.a}
        onRowClick={onRowClick}
      />,
    );
    fireEvent.click(screen.getByText("one"));
    expect(onRowClick).toHaveBeenCalledWith({ a: "one" });
  });
});

describe("the small ones", () => {
  it("Cover derives a stable gradient and shows an initial", () => {
    const first = render(<Cover seed="imp_1" label="Discovery" />).container.innerHTML;
    cleanup();
    const second = render(<Cover seed="imp_1" label="Discovery" />).container.innerHTML;
    expect(first).toBe(second);
    expect(first).toContain("D");
  });

  it("Cover shows the real image when it has one, and falls back when it breaks", () => {
    render(<Cover seed="imp_1" label="Discovery" src="https://example.invalid/front-250" />);
    const image = screen.getByTestId("cover-image");
    expect(image.getAttribute("src")).toBe("https://example.invalid/front-250");
    expect(image.getAttribute("alt")).toBe("");
    fireEvent.error(image);
    expect(screen.queryByTestId("cover-image")).toBeNull();
    // The gradient and the initial were underneath the whole time.
    expect(screen.getByText("D")).not.toBeNull();
  });

  /**
   * The hydration race of owner review B10.
   *
   * A server-rendered page whose cover is already in the browser cache finishes loading it
   * before React attaches its listeners, so `onLoad` never fires. The tile used to be
   * `opacity-0` until that event, which meant "for ever" — the real cover, loaded and
   * invisible. `settled()` below is that browser: an `<img>` that is already `complete` when
   * React mounts it, with no event to come.
   */
  const settled = (naturalWidth: number) => {
    const proto = window.HTMLImageElement.prototype;
    const previous = {
      complete: Object.getOwnPropertyDescriptor(proto, "complete"),
      naturalWidth: Object.getOwnPropertyDescriptor(proto, "naturalWidth"),
    };
    Object.defineProperty(proto, "complete", { configurable: true, get: () => true });
    Object.defineProperty(proto, "naturalWidth", { configurable: true, get: () => naturalWidth });
    return () => {
      if (previous.complete) Object.defineProperty(proto, "complete", previous.complete);
      else Reflect.deleteProperty(proto, "complete");
      if (previous.naturalWidth)
        Object.defineProperty(proto, "naturalWidth", previous.naturalWidth);
      else Reflect.deleteProperty(proto, "naturalWidth");
    };
  };

  it("Cover never hides the image behind a state, so a missed onLoad cannot blank it", () => {
    render(<Cover seed="imp_1" label="Discovery" src="https://example.invalid/front-250" />);
    // No load event has fired and none is coming: the image must still be paintable.
    expect(screen.getByTestId("cover-image").className).not.toContain("opacity-0");
  });

  it("Cover reads an image that finished loading before hydration out of the DOM", () => {
    const restore = settled(250);
    try {
      const { container } = render(
        <Cover seed="imp_1" label="Discovery" src="https://example.invalid/front-250" />,
      );
      const image = screen.getByTestId("cover-image");
      expect(image.className).not.toContain("opacity-0");
      // No `fireEvent.load` anywhere: the tile knows on its own.
      expect(image.getAttribute("data-loaded")).toBe("true");
      expect(container.querySelector("[data-slot=cover]")?.getAttribute("data-has-image")).toBe(
        "true",
      );
    } finally {
      restore();
    }
  });

  it("Cover claims nothing for an image the DOM cannot vouch for", () => {
    // `complete` with no pixels is a 404 in a browser and "this DOM never loads images" in a
    // test one, so the tile stays honest and simply keeps drawing the gradient under it.
    const restore = settled(0);
    try {
      const { container } = render(
        <Cover seed="imp_1" label="Discovery" src="https://example.invalid/front-250" />,
      );
      expect(
        container.querySelector("[data-slot=cover]")?.getAttribute("data-has-image"),
      ).toBeNull();
      expect(screen.getByText("D")).not.toBeNull();
    } finally {
      restore();
    }
  });

  it("coverArtFront builds a release front URL, and nothing without an MBID", () => {
    expect(coverArtFront("a1b2")).toBe("https://coverartarchive.org/release/a1b2/front-250");
    expect(coverArtFront("a1b2", 500)).toBe("https://coverartarchive.org/release/a1b2/front-500");
    expect(coverArtFront(null)).toBeNull();
    expect(coverArtFront("   ")).toBeNull();
  });

  it("KeyValueList drops a pair asked to hide when empty", () => {
    render(
      <KeyValueList
        items={[
          { label: "Year", value: "", hideWhenEmpty: true },
          { label: "Title", value: "Discovery" },
        ]}
      />,
    );
    expect(screen.queryByText("Year")).toBeNull();
    expect(screen.getByText("Discovery")).toBeTruthy();
  });

  it("Callout carries its tone and its children", () => {
    render(<Callout tone="warn">Two tracks have no video.</Callout>);
    expect(screen.getByText("Two tracks have no video.")).toBeTruthy();
  });

  it("ImportStatusBadge speaks English, not enum", () => {
    render(<ImportStatusBadge status="awaiting_review" />);
    expect(screen.getByText("Needs review")).toBeTruthy();
  });
});

describe("TrackProgress — the Status column keeps its shape (owner review D4)", () => {
  const busy = {
    stage: "download",
    percent: 22,
    speed: 32_000,
    eta: 4,
    message: "Aerodynamic: downloading 22%",
    waiting: false,
  };

  it("says the phase and the figures, which is what the owner could not see", () => {
    render(<TrackProgress activity={busy} />);
    const text = screen.getByTestId("track-progress").textContent ?? "";
    expect(text).toContain("download");
    expect(text).toContain("22%");
    expect(text).toContain("31.3 KB/s");
    expect(text).toContain("0:04 left");
  });

  it("**reserves its space when nothing is happening**, so a row never changes height", () => {
    // The whole of D4's "le tableau saute": the block used to appear and disappear with the
    // download. It is rendered either way now — same three lines, same bar — and only its
    // text changes.
    const { container: idle } = render(<TrackProgress activity={undefined} />);
    const empty = idle.querySelector("[data-testid=track-progress]");
    expect(empty?.getAttribute("data-active")).toBe("no");
    expect(empty?.children.length).toBe(3);

    cleanup();
    const { container: live } = render(<TrackProgress activity={busy} />);
    const filled = live.querySelector("[data-testid=track-progress]");
    expect(filled?.getAttribute("data-active")).toBe("yes");
    expect(filled?.children.length).toBe(3);
  });

  it("truncates every string it holds, so no figure can widen the column", () => {
    const { container } = render(<TrackProgress activity={busy} />);
    // The two text lines — the bar's own `<span>` carries no text and is not one of them.
    const lines = [...container.querySelectorAll("span")].filter(
      (span) => (span.textContent ?? "") !== "",
    );
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.className).toContain("truncate");
      expect(line.className).toContain("min-w-0");
    }
  });
});
