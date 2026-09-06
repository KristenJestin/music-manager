# Cassettes

Recorded HTTP for the source clients of `apps/web/src/server/integrations/`.

`CLAUDE.md` forbids the network in tests, and P04 is nothing but network code. Each source's
real answer is recorded once, here, and replayed by `../cassette.ts`. The tests therefore
exercise the **production clients** — their URLs, their `inc` presets, their cache keys, their
parsing, their retry policy. Only the socket is replaced.

Re-record with:

```bash
bun run apps/web/test/record-cassettes.ts              # all of them
bun run apps/web/test/record-cassettes.ts musicbrainz  # one
```

That script is the only networked code under `test/`. It is never run by `vitest`, by
`bun run test` or by `bun run check`. It drives the same clients the tests do, so a cassette
cannot drift from the client that reads it: the recorded keys are, by construction, the keys
the tests ask for. MusicBrainz is paced by the client's own 1 req/s limiter, as
`docs/03-metadonnees.md` §4 requires.

## The scenario

Daft Punk — Discovery, the same album `packages/domain/fixtures/` records, so the two sets can
be read side by side.

| MBID                                   | Entity                       |
| -------------------------------------- | ---------------------------- |
| `d073287b-d1bd-4f11-a933-a4386f8cf701` | release                      |
| `48117b90-a16e-34ca-a514-19c702df1158` | release group                |
| `60fa767a-d85d-4991-82bc-4294e0b11ae7` | recording 1                  |
| `4bb47ffc-9006-32cf-8aa9-e213334550dc` | work                         |
| `056e4f3e-d505-4dad-8ec1-d04f521cbb56` | artist                       |
| `11111111-2222-4333-8444-555555555555` | nothing — the deliberate 404 |

| File                   | What it holds                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `musicbrainz.json`     | release, recording, work, artist, release group, an artist browse, a Lucene search, and a 404 |
| `coverartarchive.json` | the Discovery index, and a release the archive has nothing for (the frequent 404 of §4)       |
| `lrclib.json`          | the exact lookup that answers, and a track nobody has lyrics for                              |
| `deezer.json`          | both ISRCs MusicBrainz has for the recording, and one Deezer answers `no data` to             |
| `lastfm.json`          | track top tags, artist top tags, similar artists                                              |
| `listenbrainz.json`    | recording tags, and the similar-artists graph P09 will read                                   |
| `wikimedia.json`       | the artist's url-rels and the Wikidata entity behind them                                     |

## What is redacted, and why

- **API keys.** The Last.fm and fanart.tv URLs carry an `api_key`, the AcoustID form a
  `client`. Both are replaced with `<redacted>` **before anything is written**, and the
  redacted form is the lookup key on both sides of the tape — so a cassette cannot hold a
  credential even by accident.
- **Lyrics.** `lrclib.json` keeps the real response shape, the ids, the durations, the
  `instrumental` flags and the `[mm:ss.cc]` timestamps; every lyric line's words are replaced
  with `lyrics redacted`. Song lyrics are third-party copyrighted text and do not belong in
  this repository. No code looks at the words — only at the presence, the LRC structure and
  the flag. This is the same rule `packages/domain/fixtures/README.md` states.
- **The Wikidata entity** is pruned to its English label and its `P18` claim. Nothing else is
  read, and the full entity is 400 KB.

## Re-recording produces a diff

MusicBrainz data changes; Last.fm counts change daily. Read the diff before committing it, and
re-run `bun run --cwd apps/web test integrations`: a field that disappears from a cassette is
usually a real editorial change, occasionally a client that stopped asking for it.

`matching/` belongs to P05 and is recorded by `scripts/record-matching-cassettes.ts`.
