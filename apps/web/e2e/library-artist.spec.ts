import { expect, test, reloadUntil, signIn } from "./helpers.ts";

/**
 * The artist page, and the album's link back to where its audio came from.
 *
 * Both are read off the album `import-album.spec.ts` places, and this spec imports nothing of
 * its own — same reasoning as `library.spec.ts`, and the same dependency: the suite is
 * single-worker and serial in file-name order, and `import-album` sorts before this file.
 *
 * The fixture artist is Daft Punk. Two rows have to exist for this page to have anything to
 * say, and the import writes both without any help from here: `place` files the album under
 * `Daft Punk`, and the `tag` step's document build runs `rememberArtist`, which writes
 * `artists_cache` from the recorded MusicBrainz artist — MBID, image URL and the whole entity
 * including its url-rels.
 */
test.describe("the artist page", () => {
  test("the artists list links to it, and it shows the artist's albums", async ({ page }) => {
    await signIn(page);

    /* ---- the list ---------------------------------------------------------- */

    // Filtered to the fixture artist rather than taking the first row: the suite also imports
    // a Bon Iver single and, on a full run, Tame Impala's Currents, and "who sorts first" is
    // not a fact this spec should depend on.
    await reloadUntil(page, "/library/artists?q=Daft", async () => {
      await expect(
        page.getByTestId("artist-link").first(),
        "Daft Punk is not in the library: import-album.spec.ts places the album this spec reads, so run the whole suite rather than this file alone",
      ).toBeVisible({ timeout: 5_000 });
    });

    const row = page.getByTestId("artist-link").first();
    const name = (await row.textContent())?.trim() ?? "";
    expect(name).toBe("Daft Punk");
    await row.click();
    await page.waitForURL(/\/library\/artists\/[^/]+$/, { timeout: 60_000 });

    /* ---- the page ---------------------------------------------------------- */

    await expect(page.getByTestId("artist-name")).toHaveText(name);
    // The picture: a real image when the sidecar or the cached URL resolved, the gradient
    // underneath either way. The tile is what must be there; the pixels are the network's.
    await expect(page.getByTestId("artist-image")).toBeVisible();

    // Their albums, as cards, with the badges the grid draws — and they link through.
    const albums = page.getByTestId("artist-albums").getByTestId("album-card");
    await expect(albums.first()).toBeVisible();
    const title = await albums.first().getAttribute("data-album-title");
    expect(title).not.toBeNull();

    /* ---- the quick links --------------------------------------------------- */

    // MusicBrainz is always offered: as a link when the artist is linked, as a plain
    // "no MusicBrainz id yet" when they are not. The fixture artist is linked.
    const mb = page.getByTestId("artist-mb-link");
    await expect(mb).toBeVisible();
    await expect(mb).toHaveAttribute("href", /musicbrainz\.org\/artist\//);

    // The url-rels `rememberArtist` stored. The recorded Daft Punk entity carries the Wikidata
    // one, so at least one external address is on the page rather than none.
    const external = page.getByTestId("artist-external-link");
    await expect(external.first()).toBeVisible();
    await expect(external.first()).toHaveAttribute("href", /^https?:\/\//);

    /* ---- the discography, from the cache ----------------------------------- */

    // `seed-discover.ts` writes the browse answer for the fixture artist into `source_cache`
    // under the key the real client computes, so the comparison renders with no request at
    // all — which is the whole point of the section. Five of Daft Punk's seven release groups
    // are gaps, two of which the Discover filters exclude.
    const shelf = page.getByTestId("artist-shelf");
    await expect(shelf).toBeVisible();
    await expect(shelf).toContainText(/you have \d+ of \d+/);
    await expect(page.getByTestId("artist-missing-release").first()).toBeVisible();

    /* ---- back through an album -------------------------------------------- */

    await albums.first().click();
    await page.waitForURL(/\/library\/albums\//, { timeout: 60_000 });
    await expect(page.getByTestId("album-title")).toHaveText(title ?? "");

    // And the album's artist points back at the page we came from.
    await expect(page.getByTestId("album-artist-link")).toHaveAttribute(
      "href",
      /\/library\/artists\//,
    );
  });

  test("an artist nothing is credited to says so instead of erroring", async ({ page }) => {
    await signIn(page);
    await page.goto("/library/artists/no-such-artist-ever");
    await expect(page.getByTestId("artist-unknown")).toBeVisible();
  });
});

/**
 * The album's link back to YouTube.
 *
 * `imports.url` is `fixture://discovery` here, because fixtures mode must stay provably
 * offline and `fixture://` is the only scheme the toolbox will answer — so the *playlist*
 * branch cannot be exercised by a fixture import, and `source-url.test.ts` is what proves it
 * (including the `OLAK5uy_…` and migrated-from-v1 shapes). What this asserts is the half a
 * browser can settle: the fallback fires, the link is a real YouTube address built from the
 * `webpage_url` of the recorded yt-dlp entry, and `fixture://discovery` never reaches an
 * anchor.
 */
test.describe("an album's source link", () => {
  test("points at the YouTube the audio came from", async ({ page }) => {
    await signIn(page);
    // The fixture album by name: an album placed by a library scan has no import behind it and
    // therefore no source link, which is correct and is not what this test is about.
    await reloadUntil(page, "/library?q=Discovery", async () => {
      await expect(page.getByTestId("album-card").first()).toBeVisible({ timeout: 5_000 });
    });
    await page.getByTestId("album-card").first().click();
    await page.waitForURL(/\/library\/albums\//, { timeout: 60_000 });

    const source = page.getByTestId("album-source-link");
    await expect(source).toBeVisible();
    const href = await source.getAttribute("href");
    expect(href).toMatch(/^https:\/\/(www\.|music\.)?youtu/);
    expect(href).not.toContain("fixture://");

    // The label says which of the two it is, and the kind is on the element so a change of
    // wording does not quietly turn a playlist link into a video one.
    const kind = await source.getAttribute("data-source-kind");
    expect(["playlist", "video"]).toContain(kind);
    if (kind === "playlist") {
      expect(href).toMatch(/list=|OLAK5uy_/);
      await expect(source).toContainText("playlist");
    } else {
      await expect(source).toContainText("video");
    }
    await expect(source).toHaveAttribute("aria-label", /Open the source/);
  });
});
