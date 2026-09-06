/**
 * Derive the two matching scenarios MusicBrainz does not actually contain.
 *
 * `bun run scripts/derive-matching-fixtures.ts`
 *
 * The phase specification's acceptance table describes four situations. Two of them are not in
 * MusicBrainz, which recording the cassettes made plain:
 *
 *  - **a fifteen-track Japanese edition of Discovery.** All twenty-three releases of the
 *    release group carry the same fourteen tracks, the three Japanese pressings included.
 *    (This is the same class of finding as P01's note that there is no 2001 Digital Media XW
 *    Discovery either; the canonical 2001 French CD is what gets preselected.)
 *  - **a 3:33 single edit of "Formidable".** MusicBrainz has one studio recording at 3:34,
 *    used by both the single and the album, plus live versions minutes longer.
 *
 * The properties those rows are really about — an edition with an uncovered bonus track ranks
 * below the one that fits exactly; two recordings one second apart are ambiguous and the
 * album version is preselected — are properties of the *engine*, and they are worth proving.
 * So each is built here by a stated, minimal edit of the recorded payload, written to
 * `fixtures/matching/derived/` with the edit recorded in the file itself. Nothing is invented
 * beyond what the header of each output says.
 *
 * Deterministic: running it twice leaves the working tree clean.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  MbRelease,
  MbTrack,
} from "../packages/domain/src/metadata/resolvers/musicbrainz-types.ts";
import { repoRoot } from "./lib.ts";

const FIXTURE_DIR = join(repoRoot, "packages", "domain", "fixtures", "matching");
const DERIVED_DIR = join(FIXTURE_DIR, "derived");

function read<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8")) as T;
}

function write(name: string, value: unknown): void {
  writeFileSync(join(DERIVED_DIR, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

interface AlbumFixture {
  readonly kind: "album";
  readonly videos: readonly unknown[];
  readonly hints: unknown;
  readonly candidates: { release: MbRelease; detailed?: boolean }[];
  readonly lookedUp: readonly string[];
}

interface SingleFixture {
  readonly kind: "single";
  readonly video: unknown;
  readonly candidates: {
    id: string;
    title: string;
    artist: string;
    disambiguation?: string;
    lengthMs?: number | null;
    isrcs?: readonly string[];
    releases?: readonly MbRelease[];
  }[];
}

/* ------------------------------------------------------------------ */
/* Discovery + a fifteen-track Japanese edition                        */
/* ------------------------------------------------------------------ */

/** A synthetic MBID, deliberately not a real one, so it can never be looked up by accident. */
const JAPAN_MBID = "00000000-0000-4000-8000-000000000015";

function deriveDiscoveryJapan(): void {
  const source = read<AlbumFixture>("discovery");
  const base = source.candidates.find(
    (candidate) => candidate.detailed === true && candidate.release.country === "FR",
  );
  if (base === undefined) throw new Error("discovery.json has no detailed French release");

  const medium = base.release.media?.[0];
  if (medium === undefined) throw new Error("the French release has no medium");
  const tracks = [...(medium.tracks ?? [])];
  const last = tracks[tracks.length - 1];
  if (last === undefined) throw new Error("the French release has no tracks");

  /*
   * The one addition: a fifteenth track, four minutes long and matching no video. Everything
   * else — the fourteen real tracks with their real lengths and MBIDs — is the recorded
   * French CD. The edition is Japanese and says "bonus track" in its disambiguation, which is
   * what a real Toshiba-EMI pressing looks like and what the penalty list keys on.
   */
  const bonus: MbTrack = {
    id: "00000000-0000-4000-8000-00000000b015",
    position: 15,
    number: "15",
    title: "Aerodynamic (Slum Village remix)",
    length: 253_000,
    recording: {
      id: "00000000-0000-4000-8000-00000000r015",
      title: "Aerodynamic (Slum Village remix)",
      length: 253_000,
    },
  };

  const japan: MbRelease = {
    ...base.release,
    id: JAPAN_MBID,
    country: "JP",
    date: "2001-03-10",
    barcode: "4988006795426",
    disambiguation: "Japan edition, bonus track",
    media: [
      {
        ...medium,
        "track-count": 15,
        tracks: [...tracks, bonus],
      },
    ],
  };

  write("discovery-japan", {
    kind: "album",
    derivedFrom: "matching/discovery.json",
    synthetic:
      "MusicBrainz has no fifteen-track Discovery: all twenty-three releases of the group, " +
      "the three Japanese ones included, carry the same fourteen tracks. This candidate is " +
      `the recorded French CD (${base.release.id ?? "?"}) with one extra track appended, a ` +
      "Japanese country, and a “bonus track” disambiguation. Nothing else was changed.",
    videos: source.videos,
    hints: source.hints,
    candidates: [...source.candidates, { release: japan, detailed: true }],
  });
}

/* ------------------------------------------------------------------ */
/* Formidable + the single edit                                        */
/* ------------------------------------------------------------------ */

const SINGLE_EDIT_MBID = "00000000-0000-4000-8000-0000000f0213";

function deriveFormidableSingleEdit(): void {
  const source = read<SingleFixture>("formidable");
  const album = source.candidates.find(
    (candidate) => candidate.lengthMs === 214_000 && /stromae/i.test(candidate.artist),
  );
  if (album === undefined) throw new Error("formidable.json has no 3:34 Stromae recording");

  const single = (album.releases ?? []).find(
    (release) =>
      release["release-group"]?.["primary-type"] === "Single" && release.title === "Formidable",
  );
  if (single === undefined) throw new Error("the recording is on no “Formidable” single");

  /*
   * The one addition: the same recording, one second shorter, present only on the single.
   *
   * That is what makes the pair a genuine question. One second is inside the ±2 s tolerance,
   * so the duration signal is 1 for both; the title, the artist and the YouTube tags agree
   * for both; and the only thing left to separate them is where each would be filed — which
   * is the borrow ladder, worth a hundredth of a point. Two candidates a hundredth apart are
   * inside the ambiguity margin, so the engine must ask rather than choose, and the one it
   * puts first must be the album.
   */
  const singleEdit = {
    ...album,
    id: SINGLE_EDIT_MBID,
    lengthMs: 213_000,
    releases: [single],
  };

  write("formidable-single-edit", {
    kind: "single",
    derivedFrom: "matching/formidable.json",
    synthetic:
      "MusicBrainz has one studio “Formidable” at 3:34, used by both the single and the " +
      `album; there is no 3:33 single edit. This candidate is the recorded recording ` +
      `(${album.id}) shortened by one second and restricted to the “Formidable” single ` +
      `(${single.id ?? "?"}), which is a real release of it. Nothing else was changed.`,
    video: source.video,
    candidates: [...source.candidates, singleEdit],
  });
}

mkdirSync(DERIVED_DIR, { recursive: true });
deriveDiscoveryJapan();
deriveFormidableSingleEdit();
console.log("derived: discovery-japan, formidable-single-edit");
