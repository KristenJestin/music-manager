# Golden projections

`discovery/01-one-more-time.{vorbis,id3,mp4}.txt` is the **complete** projection of Discovery's
track 1 — the document assembled from `../fixtures/` by `src/testing/discovery.ts`, rendered
into each of the three container formats of `docs/03-metadonnees.md` §1.

Format: one `KEY=value` per line, in tag-map order, multi-valued fields repeated, newlines
inside a value escaped as `\n` so the file stays line-oriented. The embedded images are listed
last, apart from the text tags, because that is how §2.6 treats them and how the toolbox
receives them.

These files are the regression test for everything at once: the resolvers, the merge
precedence, the n/a rules, the tag map and the projection. A change anywhere upstream shows up
here as a reviewable diff, which is the point.

## Regenerating

```bash
MM_UPDATE_GOLDEN=1 bun run --cwd packages/domain test
```

Then **read the diff** — that is the review. If the change is intended, it usually comes with a
`TAG_SCHEMA_VERSION` bump and a changelog entry in `src/metadata/schema.ts` (§8), because a
projection that changed means the files already on disk are behind and must be re-tagged.

A diff you did not expect after `bun run --cwd packages/domain fixtures:record` means
MusicBrainz data changed. That is legitimate; review it and commit both.
