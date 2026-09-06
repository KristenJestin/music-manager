// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MappingLine, ReleaseCandidate } from "@mm/domain";
import { Callout } from "./callout.tsx";
import { Cover, coverArtFront } from "./cover.tsx";
import { DataTable } from "./data-table.tsx";
import { KeyValueList } from "./key-value.tsx";
import { LogViewer } from "./log-viewer.tsx";
import { MappingRow } from "./mapping-row.tsx";
import { PipelineDots } from "./pipeline-dots.tsx";
import { ReleaseCandidateCard } from "./candidate-card.tsx";
import { ReviewCard } from "./review-card.tsx";
import { ScoreBar } from "./score-bar.tsx";
import { SignalsRow } from "./signals-row.tsx";
import { Stepper } from "./stepper.tsx";
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
  durDelta: 0.619,
  signals: {
    title: 1,
    artist: 1,
    trackCount: 0.9,
    durations: 0.93,
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
      trackTitle: "One More Time",
      delta: -1,
      status: "confident",
    },
    {
      videoIndex: 1,
      videoTitle: "Alive 1997 excerpt",
      trackPosition: null,
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

  it("hides the reasons until asked, and opens them on “why?”", () => {
    render(<ReleaseCandidateCard candidate={candidate} selected={false} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("candidate-why")).toBeNull();
    fireEvent.click(screen.getByTestId("why-toggle"));
    const why = screen.getByTestId("candidate-why");
    expect(within(why).getByText("Album title and artist match exactly")).toBeTruthy();
  });

  it("shows the reasons without asking on the card that is selected", () => {
    render(<ReleaseCandidateCard candidate={candidate} selected onSelect={vi.fn()} />);
    expect(screen.getByTestId("candidate-why")).toBeTruthy();
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
    expect(screen.queryByTestId("candidate-fit")).toBeNull();
    fireEvent.click(screen.getByTestId("fit-toggle"));
    const fit = screen.getByTestId("candidate-fit");
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

  it("names every penalty that lowered the score", () => {
    render(
      <ReleaseCandidateCard
        candidate={{ ...candidate, penalties: [{ reason: "Bootleg release", amount: 0.25 }] }}
        selected
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText(/Bootleg release \(−25%\)/)).toBeTruthy();
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
