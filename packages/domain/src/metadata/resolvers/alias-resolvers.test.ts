/**
 * The locale feature against **real MusicBrainz responses**, not hand-written objects.
 *
 * The rules of `../alias.ts` are proven on a table in `../alias.test.ts`. What this file
 * proves is different and is the thing that actually breaks: that the rules, applied to the
 * data MusicBrainz really sends, produce the tags `docs/03-metadonnees.md` §2.1 asks for —
 * 梶浦由記 written `Yuki Kajiura`, `ARTISTSORT` still `Kajiura, Yuki`, and `Björk`-shaped
 * names left alone.
 */

import { describe, expect, it } from "vitest";

import { FETCHED_AT, release } from "../../testing/discovery.ts";
import { readFixture } from "../../testing/fixtures.ts";
import {
  choosePseudoRelease,
  fromMusicBrainzPseudoRelease,
  fromMusicBrainzRelease,
  pickAlias,
  type LocalePreference,
  type MbArtistLike,
  type MbRelease,
} from "./index.ts";

const at = FETCHED_AT;

const kajiura = readFixture<MbArtistLike>("musicbrainz/artist-kajiura.json");
/** 「ツバサ・クロニクル」オリジナルサウンドトラック — Official, `Jpan`, 20 tracks. */
const tsubasa = readFixture<MbRelease>("musicbrainz/release-tsubasa.json");
/** The same album as MusicBrainz's romanised edition — `Pseudo-Release`, `Latn`. */
const tsubasaPseudo = readFixture<MbRelease>("musicbrainz/release-tsubasa-pseudo.json");

const EN: LocalePreference = { locale: "en", onlyNonLatin: true };

function value(patch: ReturnType<typeof fromMusicBrainzRelease>, field: string): unknown {
  return patch.fields?.[field]?.value;
}

function via(patch: ReturnType<typeof fromMusicBrainzRelease>, field: string): string | undefined {
  return patch.fields?.[field]?.via;
}

describe("the recorded aliases of 梶浦由記", () => {
  it("is the artist the search resolved, not an MBID typed from memory", () => {
    expect(kajiura.name).toBe("梶浦由記");
    expect(kajiura["sort-name"]).toBe("Kajiura, Yuki");
  });

  it("files the romanisation as `Artist name`, primary, in `en` — not as a `Legal name`", () => {
    const alias = pickAlias(kajiura.aliases, { ...EN, kind: "artist", credited: "梶浦由記" });
    expect(alias?.name).toBe("Yuki Kajiura");
    expect(alias?.type).toBe("Artist name");
    expect(alias?.primary).toBe(true);
    // The one real-world worry this fixture settles: no romanisation is hidden behind
    // `Legal name`, which `pickAlias` refuses. Every alias here is typed or has no locale.
    expect((kajiura.aliases ?? []).filter((entry) => entry.type === "Legal name")).toHaveLength(0);
  });

  it("ignores the untyped, locale-less aliases MusicBrainz also carries", () => {
    // `Noir`, `Noir OST I`, `Noir OST II`: real entries, no locale, no type, not primary.
    const untyped = (kajiura.aliases ?? []).filter(
      (entry) => entry.type === null && entry.locale == null,
    );
    expect(untyped.length).toBeGreaterThan(0);
    expect(pickAlias(untyped, { ...EN, kind: "artist" })).toBeNull();
  });
});

describe("fromMusicBrainzRelease with a preferred locale", () => {
  /** Track 3, “believe”, is credited to 梶浦由記 alone — the plain one-artist case. */
  const plain = fromMusicBrainzRelease(tsubasa, { trackPosition: 3, fetchedAt: at });
  const english = fromMusicBrainzRelease(tsubasa, {
    trackPosition: 3,
    fetchedAt: at,
    locale: EN,
  });

  it("writes the Japanese name when no locale is asked for", () => {
    expect(value(plain, "artist")).toBe("梶浦由記");
    expect(via(plain, "artist")).toBeUndefined();
  });

  it("writes ARTIST = Yuki Kajiura for `en`, with the alias recorded in `via`", () => {
    expect(value(english, "artist")).toBe("Yuki Kajiura");
    expect(value(english, "artists")).toEqual(["Yuki Kajiura"]);
    expect(value(english, "albumartist")).toBe("Yuki Kajiura");
    expect(via(english, "artist")).toBe("alias en (primary)");
  });

  it("leaves ARTISTSORT alone: the sort-name already holds the original, sortably", () => {
    expect(value(english, "artistsort")).toEqual(["Kajiura, Yuki"]);
    expect(value(english, "artistsort")).toEqual(value(plain, "artistsort"));
    expect(via(english, "artistsort")).toBeUndefined();
  });

  it("does not translate track titles: recording aliases carry no locale", () => {
    expect(value(english, "title")).toBe(value(plain, "title"));
  });

  it("honours the two switches separately", () => {
    const albumsOnly = fromMusicBrainzRelease(tsubasa, {
      trackPosition: 3,
      fetchedAt: at,
      locale: { ...EN, artists: false },
    });
    expect(value(albumsOnly, "artist")).toBe("梶浦由記");
  });

  /**
   * Track 1, “ship of fools”, is `梶浦由記 feat. 伊東恵里`, and it is the case that goes wrong
   * first: the join phrase must survive, and the second artist — who has no `en` alias — must
   * keep her own name rather than being dropped or replaced by anything.
   */
  it("keeps the join phrase, and leaves an artist with no alias in this locale alone", () => {
    const feat = fromMusicBrainzRelease(tsubasa, {
      trackPosition: 1,
      fetchedAt: at,
      locale: EN,
    });
    expect(value(feat, "artist")).toBe("Yuki Kajiura feat. 伊東恵里");
    expect(value(feat, "artists")).toEqual(["Yuki Kajiura", "伊東恵里"]);
    expect(value(feat, "artistsort")).toEqual(["Kajiura, Yuki", "Ito, Eri"]);
  });

  it("leaves ALBUM alone: this release group has no `Release name` alias", () => {
    // Recorded reality, and the reason the pseudo-release path exists: release-group aliases
    // are rare, and the few that exist are untyped and locale-less.
    expect(tsubasa["release-group"]?.aliases ?? []).toHaveLength(0);
    expect(value(english, "album")).toBe(tsubasa.title);
    expect(english.na?.["albumsort"]).toBeDefined();
  });
});

describe("Daft Punk, the other direction", () => {
  it("writes ダフト・パンク for `ja`", () => {
    const japanese = fromMusicBrainzRelease(release, {
      trackPosition: 1,
      fetchedAt: at,
      // `onlyNonLatin` would spare “Daft Punk”, which is exactly the Björk rule; this asks
      // for the translation regardless, which is what turning that switch off means.
      locale: { locale: "ja", onlyNonLatin: false },
    });
    expect(japanese.fields?.["artist"]?.value).toBe("ダフト・パンク");
    expect(japanese.fields?.["artist"]?.via).toBe("alias ja (primary)");
  });

  it("leaves a Latin name alone under the default non-Latin-only rule", () => {
    const japanese = fromMusicBrainzRelease(release, {
      trackPosition: 1,
      fetchedAt: at,
      locale: { locale: "ja", onlyNonLatin: true },
    });
    expect(japanese.fields?.["artist"]?.value).toBe("Daft Punk");
    expect(japanese.fields?.["artist"]?.via).toBeUndefined();
  });
});

describe("the pseudo-release", () => {
  it("is the Latin edition of the same tracklist", () => {
    expect(tsubasa["text-representation"]?.script).toBe("Jpan");
    expect(tsubasaPseudo["text-representation"]?.script).toBe("Latn");
    expect(tsubasaPseudo.status).toBe("Pseudo-Release");
  });

  it("is chosen out of the search results, and only when it is Latin", () => {
    expect(choosePseudoRelease([tsubasaPseudo], tsubasa)?.id).toBe(tsubasaPseudo.id);
    const notLatin = { ...tsubasaPseudo, "text-representation": { script: "Jpan" } };
    expect(choosePseudoRelease([notLatin], tsubasa)).toBeNull();
  });

  it("refuses a candidate whose tracklist is a different shape", () => {
    const shorter: MbRelease = {
      ...tsubasaPseudo,
      media: [{ position: 1, "track-count": 3, tracks: [] }],
    };
    expect(choosePseudoRelease([shorter], tsubasa)).toBeNull();
  });

  it("renames TITLE and ALBUM, and keeps both originals in the sort fields", () => {
    const original = tsubasa.media?.[0]?.tracks?.[0]?.title;
    const patch = fromMusicBrainzPseudoRelease(
      tsubasaPseudo,
      { album: tsubasa.title, title: original },
      { trackPosition: 1, fetchedAt: at },
    );
    expect(patch.fields?.["title"]?.value).toBe(tsubasaPseudo.media?.[0]?.tracks?.[0]?.title);
    expect(patch.fields?.["titlesort"]?.value).toBe(original);
    expect(patch.fields?.["album"]?.value).toBe(tsubasaPseudo.title);
    expect(patch.fields?.["albumsort"]?.value).toBe(tsubasa.title);
    expect(patch.fields?.["title"]?.via).toBe(`pseudo-release ${String(tsubasaPseudo.id)}`);
  });

  it("touches nothing else — it is a spelling, not a second opinion about the album", () => {
    const patch = fromMusicBrainzPseudoRelease(
      tsubasaPseudo,
      { album: tsubasa.title, title: "x" },
      { trackPosition: 1, fetchedAt: at },
    );
    expect(Object.keys(patch.fields ?? {}).sort()).toEqual([
      "album",
      "albumsort",
      "title",
      "titlesort",
    ]);
    expect(patch.na ?? {}).toEqual({});
  });
});
