/**
 * The tag map against its own specification.
 *
 * `docs/03-metadonnees.md` §2 is the authority; `tags.ts` is a transcription of it. This test
 * re-parses the markdown tables and asserts that every Vorbis key the documentation names has
 * an entry in the table. It is the only guard against the two drifting apart.
 *
 * The documentation lives outside this repository (see ../../../../CLAUDE.md: this repo holds
 * code only), so the file may legitimately be absent — a checkout of `v2/` alone, a CI job
 * that clones only the code. In that case the test skips instead of failing.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { TAGS } from "./tags.ts";

const DOC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../docs/03-metadonnees.md");

/**
 * Keys the documentation writes in shorthand:
 *  - `REPLAYGAIN_TRACK_GAIN / _PEAK / _RANGE` — a suffix continues the previous key;
 *  - `MUSICBRAINZ_COMPOSERID, …PRODUCERID` — an ellipsis repeats the previous key's prefix.
 * Both are expanded here exactly as they are expanded in `tags.ts`.
 */
function keysOfVorbisCell(cell: string): string[] {
  const tokens = cell.match(/…?_?[A-Z][A-Z0-9_]{2,}/g) ?? [];
  const keys: string[] = [];
  for (const raw of tokens) {
    const previous = keys[keys.length - 1];
    if (raw.startsWith("_") && previous !== undefined) {
      // "_PEAK" after "REPLAYGAIN_TRACK_GAIN" → "REPLAYGAIN_TRACK_PEAK".
      keys.push(`${previous.slice(0, previous.lastIndexOf("_"))}${raw}`);
    } else if (raw.startsWith("…") && previous !== undefined) {
      // "…PRODUCERID" after "MUSICBRAINZ_COMPOSERID" → "MUSICBRAINZ_PRODUCERID".
      keys.push(`${previous.slice(0, previous.indexOf("_") + 1)}${raw.slice(1)}`);
    } else if (!raw.startsWith("…") && !raw.startsWith("_")) {
      keys.push(raw);
    }
  }
  return keys;
}

interface DocumentedKey {
  readonly key: string;
  readonly section: string;
  readonly row: string;
}

function parseDocumentedKeys(markdown: string): DocumentedKey[] {
  const out: DocumentedKey[] = [];
  let section = "";
  let inTable = false;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^### (2\.\d.*)$/.exec(line);
    if (heading?.[1] !== undefined) {
      section = heading[1];
      inTable = false;
      continue;
    }
    if (!section.startsWith("2.")) continue;
    if (line.startsWith("## ") && !line.startsWith("## 2")) break;

    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells[0] === "Champ") continue; // header
    if (cells.every((cell) => /^-+$/.test(cell))) {
      inTable = true; // the separator row: real rows follow
      continue;
    }
    if (!inTable) continue;

    const vorbis = cells[1];
    if (vorbis === undefined || vorbis === "—") continue;
    for (const key of keysOfVorbisCell(vorbis)) {
      out.push({ key, section, row: cells[0] ?? "" });
    }
  }

  return out;
}

const available = existsSync(DOC);

describe.skipIf(!available)("tags.ts covers docs/03-metadonnees.md §2", () => {
  const documented = available ? parseDocumentedKeys(readFileSync(DOC, "utf8")) : [];

  it("finds the six tables", () => {
    const sections = new Set(documented.map((entry) => entry.section));
    expect(sections.size).toBe(6);
    expect(documented.length).toBeGreaterThanOrEqual(80);
  });

  it("has an entry for every documented Vorbis key", () => {
    const known = new Set(TAGS.map((tag) => tag.vorbis));
    const missing = documented
      .filter((entry) => !known.has(entry.key))
      .map((entry) => `${entry.section} · ${entry.row} · ${entry.key}`);
    expect(missing).toEqual([]);
  });

  it("does not invent Vorbis keys the documentation never mentions", () => {
    const documentedKeys = new Set(documented.map((entry) => entry.key));
    const invented = TAGS.map((tag) => tag.vorbis).filter((key) => !documentedKeys.has(key));
    expect(invented).toEqual([]);
  });

  it("encodes at least the 99 entries the phase asks for", () => {
    expect(TAGS.length).toBeGreaterThanOrEqual(99);
  });
});
