// @vitest-environment happy-dom
/**
 * The Console's half of `services/adopt.ts` — the dialog Kris actually works in.
 *
 * The owner's rule is that every gesture exists in the interface *and* in the API, and that a
 * feature shipped on one side only is half a feature. The service, `/api/v1`, MCP and `mm` all
 * have tests for the replacement address; this is the fourth surface's, and it is a component
 * test rather than a browser one deliberately: what has to be proved here is the *choice* —
 * that a third way to name the bytes exists, that it produces the right `AdoptFileChoice`, and
 * that the obviously wrong address is refused before a request is made. None of that needs a
 * server, and a Playwright spec for it would need an album to import and would collide with
 * the one `import-album.spec.ts` already owns.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AdoptFileDialog, type AdoptFileChoice } from "./adopt-file-dialog.tsx";

afterEach(cleanup);

/** The dialog, open, on a track — with a spy for whatever it decides the source is. */
function open(): { onAdopt: ReturnType<typeof vi.fn> } {
  const onAdopt = vi.fn();
  render(
    <AdoptFileDialog
      open
      onOpenChange={vi.fn()}
      trackTitle="Aerodynamic"
      onAdopt={onAdopt as (choice: AdoptFileChoice) => void}
    />,
  );
  return { onAdopt };
}

/** The last choice the dialog handed up, or `null` when it refused to hand one up. */
function choiceOf(onAdopt: ReturnType<typeof vi.fn>): AdoptFileChoice | null {
  const call = onAdopt.mock.calls.at(-1);
  return (call?.[0] as AdoptFileChoice | undefined) ?? null;
}

describe("AdoptFileDialog", () => {
  it("offers three ways for the bytes to arrive, not two", () => {
    open();
    // The two that existed, and the one this branch adds. A missing button here is the whole
    // failure mode the owner's rule is about: the agent can do it and the person cannot.
    expect(screen.getByTestId("adopt-mode-upload")).toBeDefined();
    expect(screen.getByTestId("adopt-mode-path")).toBeDefined();
    expect(screen.getByTestId("adopt-mode-url")).toBeDefined();
  });

  it("shows the address field only once that mode is chosen", () => {
    open();
    // Upload is the default, so the address field is not on screen to begin with.
    expect(screen.queryByTestId("adopt-url-input")).toBeNull();
    fireEvent.click(screen.getByTestId("adopt-mode-url"));
    expect(screen.getByTestId("adopt-url-input")).toBeDefined();
    // …and choosing it puts the other two modes' fields away, rather than stacking them.
    expect(screen.queryByTestId("adopt-file-input")).toBeNull();
    expect(screen.queryByTestId("adopt-path-input")).toBeNull();
  });

  it("hands up a `url` choice, trimmed, for an address that could be downloaded", () => {
    const { onAdopt } = open();
    fireEvent.click(screen.getByTestId("adopt-mode-url"));
    fireEvent.change(screen.getByTestId("adopt-url-input"), {
      target: { value: "  https://www.youtube.com/watch?v=kJQP7kiw5Fk  " },
    });
    fireEvent.click(screen.getByTestId("adopt-file-confirm"));

    expect(choiceOf(onAdopt)).toEqual({
      kind: "url",
      url: "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
    });
  });

  it("refuses a scheme the server would refuse, without making the request", () => {
    /*
     * The mirror of `isAdoptableUrl`. It is a courtesy and not the guard — the server validates
     * the same string again with the real schema — but the courtesy is the difference between
     * an answer now and a round trip, and `file:///` is exactly the address somebody pastes
     * when they meant to use "A path on the server".
     */
    const { onAdopt } = open();
    fireEvent.click(screen.getByTestId("adopt-mode-url"));
    for (const address of ["file:///etc/shadow", "D:\\Musique\\track.flac", "not a url"]) {
      fireEvent.change(screen.getByTestId("adopt-url-input"), { target: { value: address } });
      fireEvent.click(screen.getByTestId("adopt-file-confirm"));
      expect(screen.getByTestId("adopt-file-problem"), address).toBeDefined();
    }
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it("asks for an address rather than submitting an empty one", () => {
    const { onAdopt } = open();
    fireEvent.click(screen.getByTestId("adopt-mode-url"));
    fireEvent.click(screen.getByTestId("adopt-file-confirm"));
    expect(screen.getByTestId("adopt-file-problem").textContent).toContain("another upload");
    expect(onAdopt).not.toHaveBeenCalled();
  });

  it("says it is about to download, because pressing it starts one", () => {
    // The button's label is load-bearing: `url` is the only one of the three that spends the
    // single download slot and takes real time, and "Adopt this file" would hide that.
    open();
    expect(screen.getByTestId("adopt-file-confirm").textContent).toContain("Adopt this file");
    fireEvent.click(screen.getByTestId("adopt-mode-url"));
    expect(screen.getByTestId("adopt-file-confirm").textContent).toContain("Download it");
  });

  it("still hands up a `path` choice, so the third kind cost the first nothing", () => {
    const { onAdopt } = open();
    fireEvent.click(screen.getByTestId("adopt-mode-path"));
    fireEvent.change(screen.getByTestId("adopt-path-input"), {
      target: { value: "D:\\Musique\\Daft Punk\\03 Digital Love.flac" },
    });
    fireEvent.click(screen.getByTestId("adopt-file-confirm"));
    expect(choiceOf(onAdopt)).toEqual({
      kind: "path",
      path: "D:\\Musique\\Daft Punk\\03 Digital Love.flac",
    });
  });
});
