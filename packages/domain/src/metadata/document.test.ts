import { describe, expect, it } from "vitest";

import { albumTrack, FETCHED_AT, oneMoreTime } from "../testing/discovery.ts";
import { SOURCE_PRECEDENCE } from "./resolvers/index.ts";
import {
  albumScopeConsistency,
  canonicalValue,
  emptyDocument,
  field,
  lock,
  merge,
  removeField,
  setConsoleValue,
  setUserValue,
  unknownFields,
  unlock,
} from "./document.ts";

const at = FETCHED_AT;

describe("merge", () => {
  it("prefers the source that comes first in the precedence list", () => {
    const document = merge(
      [
        { fields: { title: field("From YouTube", "youtube", at) } },
        { fields: { title: field("One More Time", "musicbrainz", at) } },
      ],
      { schemaVersion: 1, precedence: SOURCE_PRECEDENCE },
    );
    expect(document.fields["title"]?.value).toBe("One More Time");
    expect(document.fields["title"]?.source).toBe("musicbrainz");
  });

  it("does so whatever the order the patches arrive in", () => {
    const musicbrainz = { fields: { title: field("One More Time", "musicbrainz", at) } };
    const youtube = { fields: { title: field("From YouTube", "youtube", at) } };
    for (const patches of [
      [musicbrainz, youtube],
      [youtube, musicbrainz],
    ]) {
      const document = merge(patches, { schemaVersion: 1, precedence: SOURCE_PRECEDENCE });
      expect(document.fields["title"]?.value).toBe("One More Time");
    }
  });

  it("lets a locked value win over any precedence", () => {
    const document = merge(
      [
        { fields: { title: field("My title", "youtube", at, { locked: true }) } },
        { fields: { title: field("One More Time", "musicbrainz", at) } },
      ],
      { schemaVersion: 1, precedence: SOURCE_PRECEDENCE },
    );
    expect(document.fields["title"]?.value).toBe("My title");
    expect(document.fields["title"]?.locked).toBe(true);
  });

  it("breaks ties between equally ranked sources by confidence", () => {
    const document = merge(
      [
        { fields: { bpm: field(100, "deezer", at, { confidence: 0.9 }) } },
        { fields: { bpm: field(123, "deezer", at, { confidence: 0.4 }) } },
      ],
      { schemaVersion: 1, precedence: ["deezer"] },
    );
    expect(document.fields["bpm"]?.value).toBe(100);
  });

  it("lets a value cancel an n/a another resolver declared", () => {
    const document = merge(
      [
        { na: { label: { reason: "the release carries no label", source: "musicbrainz" } } },
        { fields: { label: field(["Virgin"], "youtube", at) } },
      ],
      { schemaVersion: 1 },
    );
    expect(document.fields["label"]?.value).toEqual(["Virgin"]);
    expect(document.na["label"]).toBeUndefined();
  });

  it("keeps an n/a nobody contradicts", () => {
    const document = merge([{ na: { key: { reason: "analysis off", source: "app" } } }], {
      schemaVersion: 1,
    });
    expect(document.na["key"]?.reason).toBe("analysis off");
  });
});

describe("lock / unlock / setUserValue", () => {
  const base = merge([{ fields: { title: field("One More Time", "musicbrainz", at) } }], {
    schemaVersion: 1,
  });

  it("locks and unlocks without touching the value", () => {
    const locked = lock(base, "title");
    expect(locked.fields["title"]?.locked).toBe(true);
    expect(locked.fields["title"]?.value).toBe("One More Time");
    expect(unlock(locked, "title").fields["title"]?.locked).toBe(false);
    // The original is untouched: documents are values, not mutable state.
    expect(base.fields["title"]?.locked).toBe(false);
  });

  it("refuses to lock a field that is not there", () => {
    expect(() => lock(base, "bpm")).toThrow(/absent field: bpm/);
  });

  it("records a hand-entered value as locked, from the user, and clears any n/a", () => {
    const withNa = merge([{ na: { subtitle: { reason: "none", source: "musicbrainz" } } }], {
      schemaVersion: 1,
    });
    const edited = setUserValue(withNa, "subtitle", "radio edit", at);
    expect(edited.fields["subtitle"]).toMatchObject({
      value: "radio edit",
      source: "user",
      locked: true,
    });
    expect(edited.na["subtitle"]).toBeUndefined();
  });
});

/*
 * The manual override of the Console — the clean equivalent of v1's `SongForceMetadata`.
 *
 * What has to be true is one sentence: *what a person typed survives every rebuild, and
 * unlocking hands the field back*. The first half is the whole point; the second is what makes
 * it safe to use, because an override nobody can undo is a corruption with a nice UI.
 */
describe("setConsoleValue / removeField", () => {
  const base = merge([{ fields: { album: field("Discovery", "musicbrainz", at) } }], {
    schemaVersion: 1,
  });

  it("records the value as locked, from the console, and clears any n/a", () => {
    const withNa = merge([{ na: { subtitle: { reason: "none", source: "musicbrainz" } } }], {
      schemaVersion: 1,
    });
    const edited = setConsoleValue(withNa, "subtitle", "radio edit", at, { note: "set by owner" });
    expect(edited.fields["subtitle"]).toMatchObject({
      value: "radio edit",
      source: "console",
      locked: true,
      note: "set by owner",
    });
    expect(edited.na["subtitle"]).toBeUndefined();
  });

  it("survives a later MusicBrainz patch — that is the whole promise of a lock", () => {
    const edited = setConsoleValue(base, "album", "Discovery (Remastered)", at);
    const rebuilt = merge(
      [
        { fields: edited.fields },
        { fields: { album: field("Discovery", "musicbrainz", "2026-09-13T00:00:00.000Z") } },
      ],
      { schemaVersion: 1, precedence: SOURCE_PRECEDENCE },
    );
    expect(rebuilt.fields["album"]?.value).toBe("Discovery (Remastered)");
    expect(rebuilt.fields["album"]?.source).toBe("console");
  });

  it("beats a v1-migrated `user` value, so editing a migrated field is not a no-op", () => {
    const rebuilt = merge(
      [
        { fields: { album: field("Forced in v1", "user", at) } },
        { fields: { album: field("Typed here", "console", at) } },
      ],
      { schemaVersion: 1, precedence: SOURCE_PRECEDENCE },
    );
    expect(rebuilt.fields["album"]?.value).toBe("Typed here");
  });

  /*
   * Unlocking is `removeField`, not `unlock`: an unlocked `console` value would still sit at
   * the head of `SOURCE_PRECEDENCE` and go on winning. Removing it is what actually gives the
   * field back to the resolvers, and this is the test that would have caught the shortcut.
   */
  it("lets MusicBrainz win again once the console value is removed", () => {
    const edited = setConsoleValue(base, "album", "Discovery (Remastered)", at);
    const released = removeField(edited, "album");
    expect(released.fields["album"]).toBeUndefined();

    const rebuilt = merge(
      [{ fields: released.fields }, { fields: { album: field("Discovery", "musicbrainz", at) } }],
      { schemaVersion: 1, precedence: SOURCE_PRECEDENCE },
    );
    expect(rebuilt.fields["album"]?.value).toBe("Discovery");
    expect(rebuilt.fields["album"]?.source).toBe("musicbrainz");
  });

  it("would keep winning if `unlock` were used instead — which is why it is not", () => {
    const unlocked = unlock(setConsoleValue(base, "album", "Typed here", at), "album");
    const rebuilt = merge(
      [{ fields: unlocked.fields }, { fields: { album: field("Discovery", "musicbrainz", at) } }],
      { schemaVersion: 1, precedence: SOURCE_PRECEDENCE },
    );
    expect(rebuilt.fields["album"]?.value).toBe("Typed here");
  });

  it("removes nothing it was not asked to remove", () => {
    const two = setConsoleValue(setConsoleValue(base, "album", "A", at), "genre", ["house"], at);
    expect(Object.keys(removeField(two, "album").fields)).toEqual(["genre"]);
  });
});

describe("albumScopeConsistency", () => {
  it("flags an album-scope field that differs between two tracks", () => {
    const report = albumScopeConsistency([albumTrack(1), albumTrack(3)]);
    expect(report.consistent).toBe(false);
    const genre = report.divergences.find((divergence) => divergence.field === "genre");
    expect(genre).toBeDefined();
    expect(genre?.values.length).toBeGreaterThan(1);
    expect(genre?.values.flatMap((entry) => entry.tracks).sort()).toEqual([0, 1]);
  });

  it("reports which tracks hold which value", () => {
    const a = albumTrack(1);
    const b = merge(
      [{ fields: { ...a.fields, label: field(["Other"], "musicbrainz", "2026-01-01") } }],
      {
        schemaVersion: 1,
      },
    );
    const report = albumScopeConsistency([a, b, a]);
    const label = report.divergences.find((divergence) => divergence.field === "label");
    expect(label?.values).toEqual(
      expect.arrayContaining([
        { value: "Virgin", tracks: [0, 2] },
        { value: "Other", tracks: [1] },
      ]),
    );
  });

  it("counts an absent value as its own value", () => {
    const a = albumTrack(1);
    const { media: _dropped, ...withoutMedia } = a.fields;
    const b = { ...a, fields: withoutMedia };
    const report = albumScopeConsistency([a, b]);
    const media = report.divergences.find((divergence) => divergence.field === "media");
    expect(media?.values.map((entry) => entry.value)).toContain("(absent)");
  });

  it("says nothing about a single track, or about identical tracks", () => {
    const one = albumTrack(1);
    expect(albumScopeConsistency([one]).consistent).toBe(true);
    expect(albumScopeConsistency([one, one, one]).consistent).toBe(true);
  });

  it("ignores fields that are not of album scope", () => {
    const report = albumScopeConsistency([albumTrack(1), albumTrack(3)]);
    // TITLE and TRACKNUMBER obviously differ between two tracks; neither may be reported.
    expect(report.divergences.map((divergence) => divergence.field)).not.toContain("title");
    expect(report.divergences.map((divergence) => divergence.field)).not.toContain("tracknumber");
  });
});

describe("document invariants", () => {
  it("only ever uses field names the tag map knows", () => {
    expect(unknownFields(oneMoreTime())).toEqual([]);
  });

  it("renders values canonically for comparison", () => {
    expect(canonicalValue(["a", "b"])).toBe(canonicalValue(["a", "b"]));
    expect(canonicalValue(["a", "b"])).not.toBe(canonicalValue(["b", "a"]));
    expect(canonicalValue(1)).toBe("1");
    expect(canonicalValue(true)).toBe("true");
  });

  it("starts empty at the schema version it is given", () => {
    const document = emptyDocument(3);
    expect(document.schemaVersion).toBe(3);
    expect(document.fields).toEqual({});
    expect(document.na).toEqual({});
  });
});
