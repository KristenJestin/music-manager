/**
 * The template renderer, and the one property that makes it safe to ship: **the default
 * template reproduces `trackPath` exactly.**
 *
 * That is what lets the setting exist at all. If the two disagreed by a space, turning on a
 * feature nobody asked for would silently re-file an entire library.
 */
import { describe, expect, it } from "vitest";
import { albumFolder, trackPath, type TrackPathInput } from "./index.ts";
import {
  DEFAULT_PATH_TEMPLATE,
  previewPathTemplate,
  renderAlbumFolder,
  renderPathTemplate,
  validatePathTemplate,
} from "./template.ts";

const discovery: TrackPathInput = {
  albumArtist: "Daft Punk",
  album: "Discovery",
  year: 2001,
  trackNumber: 1,
  title: "One More Time",
  extension: "opus",
};

const doubleDisc: TrackPathInput = {
  albumArtist: "Justice",
  album: "Woman",
  year: 2016,
  discNumber: 2,
  totalDiscs: 2,
  trackNumber: 3,
  title: "Alakazam !",
  extension: "opus",
};

const noYear: TrackPathInput = {
  albumArtist: "Unknown Artist",
  album: "Untitled",
  trackNumber: 7,
  title: "Track Seven",
  extension: "opus",
};

describe("the default template is the shipped layout", () => {
  for (const [name, input] of [
    ["a single disc", discovery],
    ["a multi-disc release", doubleDisc],
    ["a release with no year", noYear],
  ] as const) {
    it(`matches trackPath for ${name}`, () => {
      expect(renderPathTemplate(DEFAULT_PATH_TEMPLATE, input)).toBe(trackPath(input));
    });

    it(`matches albumFolder for ${name}`, () => {
      expect(renderAlbumFolder(DEFAULT_PATH_TEMPLATE, input)).toBe(albumFolder(input));
    });
  }
});

describe("multi-disc modes", () => {
  it("prefixes the file name by default", () => {
    expect(renderPathTemplate(DEFAULT_PATH_TEMPLATE, doubleDisc)).toBe(
      "Justice/Woman (2016)/2-03 Alakazam !.opus",
    );
  });

  it("puts each disc in its own folder", () => {
    expect(renderPathTemplate(DEFAULT_PATH_TEMPLATE, doubleDisc, { discMode: "folder" })).toBe(
      "Justice/Woman (2016)/Disc 2/03 Alakazam !.opus",
    );
  });

  it("keeps one album folder and one cover in folder mode", () => {
    expect(renderAlbumFolder(DEFAULT_PATH_TEMPLATE, doubleDisc, { discMode: "folder" })).toBe(
      "Justice/Woman (2016)",
    );
  });

  it("drops the disc entirely when the release is numbered straight through", () => {
    expect(renderPathTemplate(DEFAULT_PATH_TEMPLATE, doubleDisc, { discMode: "continuous" })).toBe(
      "Justice/Woman (2016)/03 Alakazam !.opus",
    );
  });

  it("never adds a disc to a single-disc release, whatever the mode", () => {
    for (const discMode of ["prefix", "folder", "continuous"] as const) {
      expect(renderPathTemplate(DEFAULT_PATH_TEMPLATE, discovery, { discMode })).toBe(
        "Daft Punk/Discovery (2001)/01 One More Time.opus",
      );
    }
  });
});

describe("substitution", () => {
  it("removes the brackets around a year that does not exist", () => {
    expect(renderPathTemplate(DEFAULT_PATH_TEMPLATE, noYear)).toBe(
      "Unknown Artist/Untitled/07 Track Seven.opus",
    );
  });

  it("honours a padding width", () => {
    expect(renderPathTemplate("{album}/{track:03} {title}.{ext}", discovery)).toBe(
      "Discovery/001 One More Time.opus",
    );
  });

  it("falls back to the album artist when a track artist was not supplied", () => {
    expect(renderPathTemplate("{artist}/{title}.{ext}", discovery)).toBe(
      "Daft Punk/One More Time.opus",
    );
    expect(
      renderPathTemplate("{artist}/{title}.{ext}", discovery, {}, { artist: "Romanthony" }),
    ).toBe("Romanthony/One More Time.opus");
  });

  it("appends the real extension when the template forgot it", () => {
    expect(renderPathTemplate("{album}/{title}", discovery)).toBe("Discovery/One More Time.opus");
  });

  it("never lets a template escape the library root", () => {
    const path = renderPathTemplate("{album}/../../{title}.{ext}", discovery);
    expect(path).not.toContain("..");
    expect(path.startsWith("/")).toBe(false);
  });

  it("sanitises each segment separately, so a slash in a title is not a folder", () => {
    const path = renderPathTemplate(DEFAULT_PATH_TEMPLATE, {
      ...discovery,
      title: "AC/DC Tribute",
    });
    expect(path).toBe("Daft Punk/Discovery (2001)/01 AC-DC Tribute.opus");
  });
});

describe("validation", () => {
  it("accepts the default", () => {
    expect(validatePathTemplate(DEFAULT_PATH_TEMPLATE).ok).toBe(true);
  });

  it("rejects a typo rather than writing it into every folder name", () => {
    const check = validatePathTemplate("{albumartist}/{title}.{ext}");
    expect(check.ok).toBe(false);
    expect(check.unknown).toContain("{albumartist}");
  });

  it("rejects a template that would make every track of an album the same file", () => {
    const check = validatePathTemplate("{album}/{track:02}.{ext}");
    expect(check.ok).toBe(false);
    expect(check.missing).toContain("{title}");
  });

  it("rejects an empty template", () => {
    expect(validatePathTemplate("   ").ok).toBe(false);
  });
});

describe("the Settings preview", () => {
  it("shows three worked examples, and they are what the renderer would do", () => {
    const preview = previewPathTemplate(DEFAULT_PATH_TEMPLATE);
    expect(preview).toHaveLength(3);
    expect(preview[0]?.path).toBe("Daft Punk/Discovery (2001)/01 One More Time.opus");
    expect(preview[1]?.path).toBe("Justice/Woman (2016)/1-01 Safe and Sound.opus");
    expect(preview[2]?.path).toBe("Unknown Artist/Untitled/07 Track Seven.opus");
  });
});
