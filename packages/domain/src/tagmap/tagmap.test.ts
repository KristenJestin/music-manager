/**
 * Structural invariants of the tag map, the profiles and the exports.
 *
 * These are the assertions that keep the table usable as "the only source of tag names":
 * unique field names, no accidental key collision inside a format, and profiles that can only
 * name fields the table defines.
 */

import { describe, expect, it } from "vitest";

import { TAG_SCHEMA_CHANGELOG, TAG_SCHEMA_VERSION, needsRetag } from "../metadata/schema.ts";
import {
  describeProfile,
  exportFormatTable,
  exportNavidromeMappings,
  exportPicardScript,
} from "./export.ts";
import { PROFILE_IDS, PROFILES, profileById, unreadCount } from "./profiles.ts";
import { projectDocument } from "./project.ts";
import { oneMoreTime } from "../testing/discovery.ts";
import {
  ALBUM_SCOPE_FIELDS,
  keyFor,
  LEVEL_WEIGHT,
  TAG_FORMATS,
  TAGS,
  tagByField,
  tagsByVorbisKey,
} from "./tags.ts";

describe("the tag map", () => {
  it("encodes the whole table of docs §2", () => {
    expect(TAGS.length).toBeGreaterThanOrEqual(99);
  });

  it("has a unique field name per entry", () => {
    const names = TAGS.map((tag) => tag.field);
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every entry a Vorbis key, since Opus and FLAC are what we write", () => {
    for (const tag of TAGS) expect(tag.vorbis, tag.field).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it("uses only the three declared levels, with the weights of §6", () => {
    for (const tag of TAGS) expect(LEVEL_WEIGHT[tag.level]).toBeGreaterThan(0);
    expect(LEVEL_WEIGHT).toEqual({ required: 3, recommended: 2, optional: 1 });
  });

  it("looks entries up by field and by Vorbis key", () => {
    expect(tagByField("title")?.vorbis).toBe("TITLE");
    expect(tagByField("nope")).toBeUndefined();
    // LYRICS is shared by the USLT and SYLT halves of the §2.6 row.
    expect(tagsByVorbisKey("LYRICS").map((tag) => tag.field)).toEqual(["lyrics", "lyrics_synced"]);
  });

  it("lists the album-scope fields of the §2 notes", () => {
    for (const field of [
      "genre",
      "mood",
      "releasetype",
      "label",
      "releasecountry",
      "media",
      "totaltracks",
    ]) {
      expect(ALBUM_SCOPE_FIELDS, field).toContain(field);
    }
    expect(ALBUM_SCOPE_FIELDS).not.toContain("title");
    expect(ALBUM_SCOPE_FIELDS).not.toContain("tracknumber");
  });

  it("never emits the same key twice for different values in one format", () => {
    // A collision would mean one field silently overwriting another in the written file.
    const document = oneMoreTime();
    for (const format of TAG_FORMATS) {
      const byKey = new Map<string, Set<string>>();
      for (const tag of projectDocument(document, format)) {
        const held = byKey.get(tag.key);
        if (held === undefined) byKey.set(tag.key, new Set([tag.field]));
        else held.add(tag.field);
      }
      for (const [key, fields] of byKey) {
        expect([...fields], `${format}: ${key} written by several fields`).toHaveLength(1);
      }
    }
  });

  it("returns null for a format a tag has no key in", () => {
    const website = tagByField("website");
    expect(website).toBeDefined();
    expect(keyFor(website!, "vorbis")).toBe("WEBSITE");
    expect(keyFor(website!, "mp4")).toBeNull();
  });
});

describe("consumer profiles", () => {
  it("covers every declared id exactly once", () => {
    expect(PROFILES.map((profile) => profile.id).sort()).toEqual([...PROFILE_IDS].sort());
  });

  it("only names fields the tag map defines", () => {
    for (const profile of PROFILES) {
      for (const field of profile.reads) {
        expect(tagByField(field), `${profile.id} reads unknown field ${field}`).toBeDefined();
      }
    }
  });

  it("lists no field twice", () => {
    for (const profile of PROFILES) {
      expect(new Set(profile.reads).size, profile.id).toBe(profile.reads.length);
    }
  });

  it("marks exactly one profile verified — the one read off its own mapping file (§5)", () => {
    expect(PROFILES.filter((profile) => profile.status === "verified").map((p) => p.id)).toEqual([
      "navidrome",
    ]);
  });

  it("keeps every MusicBrainz identifier out of the Plex profile", () => {
    const plex = profileById("plex");
    expect(plex.reads.filter((field) => field.startsWith("musicbrainz_"))).toEqual([]);
  });

  it("counts what a profile is not known to read", () => {
    const plex = profileById("plex");
    expect(unreadCount(plex)).toBe(TAGS.length - plex.reads.length);
    expect(describeProfile(plex)).toContain("Plex");
  });
});

describe("exports", () => {
  it("renders one Picard line per tag, in table order", () => {
    const script = exportPicardScript();
    expect(script).toContain("$set(TITLE,%title%)");
    expect(script).toContain("$set(TRACKTOTAL,%totaltracks%)");
    // Fields Picard has no variable for are commented, not silently dropped.
    expect(script).toContain("$noop(MUSICMANAGER_TAGSCHEMA: written by Music Manager");
  });

  it("renders the Navidrome mappings with the three format aliases", () => {
    const yaml = exportNavidromeMappings();
    expect(yaml).toContain('  title:\n    aliases: ["TITLE", "TIT2", "©nam"]');
    expect(yaml).toContain("indexed: true");
    expect(yaml).toContain("indexed: false");
  });

  it("prints one CLI line per tag present in the format", () => {
    const vorbis = exportFormatTable("vorbis").trimEnd().split("\n");
    expect(vorbis).toHaveLength(TAGS.length);
    expect(vorbis.length).toBeGreaterThanOrEqual(99);

    const id3 = exportFormatTable("id3v24").trimEnd().split("\n");
    expect(id3).toHaveLength(TAGS.filter((tag) => tag.id3 !== null).length);
  });

  it("is deterministic", () => {
    expect(exportPicardScript()).toBe(exportPicardScript());
    expect(exportNavidromeMappings()).toBe(exportNavidromeMappings());
  });
});

describe("the versioned tag schema (§8)", () => {
  it("has a changelog entry for the current version", () => {
    expect(TAG_SCHEMA_CHANGELOG[0]?.version).toBe(TAG_SCHEMA_VERSION);
  });

  it("lists the changelog newest first, with no gap", () => {
    const versions = TAG_SCHEMA_CHANGELOG.map((entry) => entry.version);
    expect(versions).toEqual([...versions].sort((a, b) => b - a));
    expect(versions[versions.length - 1]).toBe(1);
  });

  it("selects the files a background re-tag must touch", () => {
    expect(needsRetag(undefined)).toBe(true);
    expect(needsRetag(0)).toBe(true);
    expect(needsRetag(TAG_SCHEMA_VERSION)).toBe(false);
  });
});
