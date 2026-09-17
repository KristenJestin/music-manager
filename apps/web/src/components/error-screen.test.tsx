// @vitest-environment happy-dom
/**
 * The panel a broken route draws, one case per branch.
 *
 * `lib/errors.test.ts` covers the sentences; this covers the fact that they reach the glass —
 * and, specifically, the two things the owner's screenshot got wrong on 2026-09-17: the word
 * *"Invariant failed"* where a description belongs, and *"UNKNOWN"* in the slot reserved for a
 * code a reader could quote into a bug report.
 *
 * `useRouter` and `Link` are stubbed rather than provided. A real router would mean a route
 * tree, a history and a memory adapter for a component whose whole job is three paragraphs and
 * a button, and `invalidate` is already the subject of its own assertion below.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MMError } from "@mm/contracts";

const invalidate = vi.fn(() => Promise.resolve());

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate }),
  Link: ({ children }: { children?: ReactNode }) => <a href="/tools">{children}</a>,
}));

const { ErrorScreen } = await import("./error-screen.tsx");

afterEach(() => {
  cleanup();
  invalidate.mockClear();
});

/** What a rejected server function looks like on the client: an `Error` carrying `mm`. */
function wire(body: Record<string, unknown>, message = "boom"): Error {
  const error = new Error(message);
  Object.assign(error, { mm: body, status: body["status"] ?? 500 });
  return error;
}

function panel(): HTMLElement {
  return screen.getByTestId("error-screen");
}

describe("ErrorScreen", () => {
  it("an MMError keeps its code, its hint and its own words for the button", () => {
    render(
      <ErrorScreen
        error={wire({
          code: "SOURCE_UNAVAILABLE",
          message: "musicbrainz answered HTTP 503.",
          hint: "The service is down or throttling us.",
          action: "Retry later",
          status: 503,
        })}
      />,
    );
    expect(panel().dataset["errorKind"]).toBe("typed");
    expect(panel().dataset["errorCode"]).toBe("SOURCE_UNAVAILABLE");
    expect(screen.getByTestId("error-message").textContent).toBe("musicbrainz answered HTTP 503.");
    expect(screen.getByTestId("error-code").textContent).toBe("SOURCE_UNAVAILABLE (HTTP 503)");
    expect(screen.getByTestId("error-hint").textContent).toContain("throttling");
    expect(screen.getByTestId("error-retry").textContent).toContain("Retry later");
  });

  it("an aborted request says the connection closed, and offers to try again", () => {
    render(
      <ErrorScreen
        error={Object.assign(new Error("The user aborted a request."), {
          name: "AbortError",
        })}
      />,
    );
    expect(panel().dataset["errorKind"]).toBe("aborted");
    expect(screen.getByTestId("error-message").textContent).toBe(
      "The connection closed before the server answered.",
    );
    expect(screen.getByTestId("error-code").textContent).toBe("Connection interrupted");
    expect(screen.getByTestId("error-retry").textContent).toContain("Try again");
  });

  it("a network failure says the server could not be reached", () => {
    render(<ErrorScreen error={new TypeError("Failed to fetch")} />);
    expect(panel().dataset["errorKind"]).toBe("offline");
    expect(screen.getByTestId("error-message").textContent).toBe(
      "Music Manager could not be reached.",
    );
    expect(screen.getByTestId("error-code").textContent).toBe("Network unavailable");
  });

  it("a 5xx with nothing in it says the server failed, not the browser", () => {
    render(<ErrorScreen error={Object.assign(new Error("Invariant failed"), { status: 502 })} />);
    expect(panel().dataset["errorKind"]).toBe("server");
    expect(screen.getByTestId("error-message").textContent).toBe(
      "The server failed while loading this page.",
    );
    expect(screen.getByTestId("error-code").textContent).toBe("Server error (HTTP 502)");
    expect(screen.getByTestId("error-hint").textContent).toContain("not in this browser");
  });

  it("a plain Error saying nothing prints no code at all, and never the word UNKNOWN", () => {
    // The regression, verbatim. Before this, the three lines of this panel read
    // "This page could not be loaded", "Invariant failed" and "UNKNOWN".
    render(<ErrorScreen error={new Error("Invariant failed")} />);
    expect(panel().dataset["errorKind"]).toBe("unknown");
    expect(screen.getByTestId("error-message").textContent).toBe(
      "This page's data could not be read.",
    );
    expect(screen.queryByTestId("error-code")).toBeNull();
    expect(panel().textContent).not.toContain("UNKNOWN");
    expect(panel().textContent).not.toContain("Invariant");
    // The code is still there for a machine, and only for a machine.
    expect(panel().dataset["errorCode"]).toBe("UNKNOWN");
  });

  it("Retry re-runs the loader rather than reloading the document", () => {
    render(<ErrorScreen error={new MMError("NOT_FOUND", "No import with id 0000.")} />);
    fireEvent.click(screen.getByTestId("error-retry"));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("offers no Retry on a boundary where retrying cannot help", () => {
    render(<ErrorScreen error={new Error("Invariant failed")} retryable={false} />);
    expect(screen.queryByTestId("error-retry")).toBeNull();
    // The journal is still one click away: the second question is always "what was it doing".
    expect(panel().textContent).toContain("Open the journal");
  });
});
