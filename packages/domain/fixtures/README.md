# `@mm/domain` fixtures

Everything the domain tests read. **No test in this repository is allowed to touch the
network** (`../../../CLAUDE.md`), so every source response the resolvers must understand is
recorded here once and committed.

Refresh the recorded responses with:

```bash
bun run --cwd packages/domain fixtures:record
```

That script (`../scripts/record-fixtures.ts`) is the only networked code in the package. It
is never invoked by `vitest`, `bun run test` or `bun run check`. It sends a
`MusicManager/0.1-dev (fixtures recording)` User-Agent and spaces MusicBrainz calls by
1.1 s, as required by `docs/03-metadonnees.md` §4.

Re-recording will produce a diff (MusicBrainz data changes). Review it, then re-run the
golden tests; `golden/` is regenerated with `MM_UPDATE_GOLDEN=1` (see `../golden/README.md`).

## Recorded — real responses

| File                                        | Provenance                                                                                                                                                                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `musicbrainz/release-discovery.json`        | `GET /ws/2/release/d073287b-d1bd-4f11-a933-a4386f8cf701?inc=artists+artist-credits+labels+recordings+release-groups+media+isrcs+genres+tags+aliases+artist-rels+recording-rels+work-rels+recording-level-rels+work-level-rels+url-rels&fmt=json` |
| `musicbrainz/recording-one-more-time.json`  | `GET /ws/2/recording/60fa767a-d85d-4991-82bc-4294e0b11ae7?inc=artists+artist-credits+isrcs+genres+tags+aliases+artist-rels+work-rels+url-rels+work-level-rels&fmt=json`                                                                          |
| `musicbrainz/work-one-more-time.json`       | `GET /ws/2/work/4bb47ffc-9006-32cf-8aa9-e213334550dc?inc=artist-rels+aliases+tags+url-rels&fmt=json`                                                                                                                                            |
| `musicbrainz/recording-skinny-love.json`    | `GET /ws/2/recording/5463ed3a-5fc1-49b6-8260-3b5bb36ee047?inc=…&fmt=json` (Birdy — "Skinny Love")                                                                                                                                               |
| `musicbrainz/releases-of-skinny-love.json`  | `GET /ws/2/release?recording=5463ed3a-…&inc=artist-credits+release-groups+labels+media&limit=25&fmt=json`                                                                                                                                       |
| `coverartarchive/release-discovery.json`    | `GET https://coverartarchive.org/release/d073287b-d1bd-4f11-a933-a4386f8cf701`                                                                                                                                                                  |
| `lrclib/search-one-more-time.json`          | `GET https://lrclib.net/api/search?track_name=One+More+Time&artist_name=Daft+Punk` — **redacted, see below**                                                                                                                                    |
| `deezer/track-one-more-time.json`           | `GET https://api.deezer.com/track/isrc:GBAHT1305744` (the first ISRC of the recording that Deezer answers for)                                                                                                                                  |

### MBIDs used throughout the tests and the golden files

| Entity        | MBID                                   | Title                                            |
| ------------- | -------------------------------------- | ------------------------------------------------ |
| release       | `d073287b-d1bd-4f11-a933-a4386f8cf701` | Discovery — 2001-02-26, FR, CD, Official, Virgin |
| release-group | `48117b90-a16e-34ca-a514-19c702df1158` | Discovery (Album, first release 2001-02-26)      |
| track 1       | `25fbe7fe-655e-3624-9be1-0452364d0975` | One More Time (release track)                    |
| recording 1   | `60fa767a-d85d-4991-82bc-4294e0b11ae7` | One More Time                                    |
| work          | `4bb47ffc-9006-32cf-8aa9-e213334550dc` | One More Time                                    |
| artist        | `056e4f3e-d505-4dad-8ec1-d04f521cbb56` | Daft Punk                                        |

**Release choice.** The brief asked for the 2001 · Digital Media · Worldwide edition. No such
release exists in MusicBrainz: the only Worldwide Digital Media editions of Discovery are
2005-01-24 and 2024-10-08. The fallback specified in the brief was taken — the canonical 2001
release, i.e. the original French CD dated 2001-02-26, whose date equals the release-group's
`first-release-date`. Consequence for the golden files: `MEDIA=CD`, `RELEASECOUNTRY=FR`.

### Redaction

`lrclib/search-one-more-time.json` keeps the real response shape, result count, ids,
durations, album names and `instrumental` flags, and keeps the `[mm:ss.cc]` timestamps of the
synchronised lyrics — but every lyric line's text is replaced with `lyrics redacted`. Song
lyrics are third-party copyrighted text and do not belong in this repository; no domain code
looks at the words, only at the presence, the LRC structure and the `instrumental` flag. The
redaction is applied by `record-fixtures.ts`, so a re-record stays redacted.

## Hand-written — no public endpoint to record from

| File                                   | What it is                                                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ytdlp/playlist-discovery.json`        | 15 `yt-dlp --dump-json` entries for the Discovery "Topic" playlist: the 14 real tracks (titles and durations taken from the MusicBrainz release) plus `One More Time (Radio Edit)`, which matches no MusicBrainz track and is therefore the `extra_videos` case. A JSON array rather than yt-dlp's NDJSON, because that is the shape the toolbox hands to the domain. |
| `ytdlp/video-one-more-time.json`       | One full single-video dump, with the auto-generated description the YouTube parser must read: `Provided to YouTube by`, `Title · Artist`, album line, `℗ 2001`, `Released on:`, `Producer:` / `Composer:` credits, `Auto-generated by YouTube.`                                                                                                        |
| `rsgain/scan-discovery.tsv`            | A verbatim-looking `rsgain custom -O` table for the 14 files plus the album row.                                                                                                                        |
| `rsgain/scan-discovery.json`           | The same numbers in the shape the toolbox returns and `fromRsgain` consumes. ReplayGain gains are relative to −18 LUFS, `r128*Gain` to −23 LUFS in Q7.8 fixed point.                                     |
| `lrclib/get-instrumental.json`         | An LRCLIB `/api/get` response with `instrumental: true`. LRCLIB carries the flag but no Daft Punk instrumental currently has it set, so the case is written by hand — it is what makes `LYRICS` **n/a** instead of missing. |
| `acoustid/lookup-one-more-time.json`   | An AcoustID `/v2/lookup` response with two scored results. The AcoustID id and the low-scoring recording MBIDs are invented; the One More Time recording MBID is real.                                    |

None of the hand-written files are touched by `fixtures:record`.
