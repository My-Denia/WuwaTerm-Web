# Manuscript format v5 (`wuwaterm-manuscript-v5`)

Status: contract for WuwaTerm-Web and WuwaTerm-Windows. Both parsers and both writers
implement this file. It changes [`../manuscript-v4/SPEC.md`](../manuscript-v4/SPEC.md)
only where this file says so, and v4 in turn changes
[`../manuscript-v3/SPEC.md`](../manuscript-v3/SPEC.md). `cases.json` in this directory is
the shared fixture index. Regenerate the fixtures with
`node scripts/build-manuscript-v5-fixtures.mjs --write`; without `--write`, the script
only checks that the committed bytes are current. `schema.json` is the Draft 2020-12
schema of a v5 file alone. `npm run generate:contracts` cuts it from
`contracts/schemas/manuscript.schema.json` together with the TypeScript and Python
types, and `npm run check:contracts` fails when any of them drifts.

v5 exists for three things a v4 file cannot hold:

1. **Results made with a review feature.** Core's review-v2 feature
   `ambiguous-mention-v1` reports a one-character resonator name that the matcher could
   not settle, but whose surrounding text supports it, as a `not_evaluated` finding.
   Such a result differs from one made without the feature, so a client must not reuse
   it for a request without the feature, or the other way round. The file records which
   features its results were made with.
2. **The reason `ambiguous_mention`.** A v4 reader accepts five reasons and rejects any
   other string.
3. **Gap-tolerant segment records.** When explicit alignments leave text outside every
   alignment span, segmentation-v1 makes the whole manuscript one `needs_manual_split`
   pair, and every record of a long manuscript becomes pending. An edit that invalidates
   one alignment of 64 leaves exactly such a gap. v5 records the pairing that keeps
   every aligned region and makes only the gap a region of its own.

A manuscript that needs none of the three keeps its lower format, so older clients keep
opening it.

## What changes

| | v4 | v5 |
|---|---|---|
| Top-level keys | 13 | the same 13, then `review_features` (14) |
| `format` | `wuwaterm-manuscript-v4` | `wuwaterm-manuscript-v5` |
| Finding `reason` values | 5 | the 5 of v4 and `ambiguous_mention` |
| `segments[].segmentation_version` | `segmentation-v1` | `segmentation-v1` or `segmentation-v1-gaps`, the same in every record |

Everything else is exactly v4: the limits (44 MiB, 128 findings, choices and
resolutions per list, 512 items, depth 16, 32 fields), the record, result, choice and
history entry shapes, canonical bytes (minified UTF-8 JSON, no trailing newline), and
the runtime rules of v3 "Runtime: reopening and re-checking", with the additions below.

## Review features

`review_features` is the last top-level key. It is an array of at most 8 strings, in
strictly ascending order, each one a review feature that changes which findings a result
holds. The only such feature is `ambiguous-mention-v1`. `dense-128` and `reason-v1`
change the page size and add a key; they are not recorded.

Meaning: every record result with status `done` was made by a request that asked for
exactly these features. A `stale` record keeps its result for reference only, under any
features. Document-mode history reports (`history[]`) are history, never reused, so the
list says nothing about them beyond the rule on `ambiguous_mention` below.

Rules a reader checks:

- `review_features` is present, an array, at most 8 items, strictly ascending, and every
  item is a known feature. Otherwise `workfile_invalid_content`.
- A finding with the reason `ambiguous_mention` exists only when `review_features`
  contains `ambiguous-mention-v1`. In a history report the code is
  `workfile_invalid_content`; in a record result it is `workfile_segment_invalid`.

Runtime (additions to v3 "Runtime"):

- The session's features are the recorded features the client asks Core for. Web asks
  for `ambiguous-mention-v1`, always together with `reason-v1`, exactly when
  `GET /v1/capabilities` lists `ambiguous-mention-v1`. While the capabilities are not
  known, the session's features are unknown.
- A record read from a file has the file's `review_features`. A record checked in the
  session has the features of the request that produced its result.
- Step 3, reuse: a result is reused only when, besides the v3 conditions, its features
  equal the session's. While the session's features are unknown, a result that is
  otherwise reusable is a reuse candidate (`saved`), never `current`.
- A v1 to v4 file has no list: its records have no features. Under a session that asks
  for `ambiguous-mention-v1` they are stale and checked again, once.

## Reason `ambiguous_mention`

Core reports the finding only on a review-v2 request that asked for
`ambiguous-mention-v1` (it needs `reason-v1` on the same request). The finding is
`not_evaluated`, its `target_span` (or compact `target`) is null, its candidates are the
official name or names, and Core sorts it after every judged finding. It is judged only
once the user resolves it: an `official_pair` choice sends the candidate as a resolution
and Core then judges the name like any other; a `not_a_term` choice tells Core the
character is an ordinary word here. A client keeps these findings apart from the
judged ones: it does not count them as problems or conflicts, and it lists them after
the judged findings, folded by default.

The six reasons a v5 file accepts are `not_a_term`, `ordinary_word`,
`no_target_region`, `found_outside_region`, `ambiguous_repeat` and `ambiguous_mention`;
the first five keep the meaning v4 gives them. A `reason` is still only on
`not_evaluated`, and never null.

## Gap-tolerant segment records

`segmentation-v1-gaps` names this pairing. It is segmentation-v1 (Core
`docs/segmentation-v1.md`) in every case except one: explicit alignments (a non-empty
`alignments` list) that leave a non-whitespace scalar outside every alignment span on
either side. segmentation-v1 then makes the whole manuscript one `needs_manual_split`
pair. This pairing instead builds region pairs from the alignments and the gaps:

1. **Anchors.** An alignment whose `target` is not null is an anchor. Between two
   consecutive anchors (and before the first, and after the last) lie the source text
   after the previous anchor's source span up to the next anchor's, with any
   alignments whose `target` is null, and one target stretch from the previous anchor's
   target end to the next anchor's target start.
2. **Gaps.** A source gap is the text between two consecutive alignment source spans
   (or before the first, or after the last) that holds a non-whitespace scalar. The
   target gap of a stretch is that stretch when it holds a non-whitespace scalar. Each
   gap is cut to its core (leading and trailing whitespace removed).
3. **Gap items, per stretch between two anchors:**
   - no target gap: each source gap is a gap item with no target side, and the
     null-target alignments stay as they are;
   - a target gap, no null-target alignment in between, and at most one source gap: one
     gap item with that source gap (or no source side) and the target gap;
   - otherwise: one gap item over the whole stretch on both sides, the null-target
     alignments in it included, because nothing says which part of the target belongs
     to which.
4. **Regions.** The alignments that remain and the gap items, in text order, partition
   both texts as segmentation-v1 rule 1.i partitions them: each item owns the text from
   its own start to the next item's start, and an item with no side on a text takes its
   boundary from the next item. A region whose two cores are empty joins its neighbour
   as in segmentation-v1.
5. **Classification.** An alignment region is classified and split exactly as in
   segmentation-v1. A gap region is never `ready`, since its pairing is a guess: with
   text on both sides it is `needs_manual_split`, with source text only `untranslated`,
   with target text only `unpaired_target`.
6. Adjacent ready pairs are merged, and the pairs are numbered and checked, as in
   segmentation-v1.

Without explicit alignments, or when they cover the text, the pairing is
segmentation-v1 and the label is `segmentation-v1`. One manuscript has one pairing, so
every record carries the same label (otherwise `workfile_segment_invalid`). The label
says how the record ranges were cut; the reuse rules, hashes and alignment inputs are
those of v3. A reader that pairs a draft differently still reopens such a file: records
whose ranges do not line up are matched by their hashes (v3 Runtime step 2).

## Structure checks are not stored

Layer 1 deterministic structure checks (Core `POST /v1/structure-checks`,
`structure-check-v1`, ADR 0022) are a separate track. Their findings never enter a
manuscript file of any version: not as findings, not in `review_features`, not in
history. A client shows them for the texts they were made for and drops them when those
texts change. Writing the same manuscript state with and without structure findings
gives the same bytes.

## Reading

A reader follows v4 "Reading", with these differences:

1. Step 2: a `format` of `"wuwaterm-manuscript-v5"` continues with step 3 under the v5
   rules; the size cap is 44 MiB. A label that is none of v3, v4 and v5 is read by the
   v2 reader, as in v4.
2. Step 3: the top level has exactly the 14 keys (otherwise
   `workfile_unsupported_format`), and `review_features` is checked as above.
3. Steps 5 and 6 accept the six reasons. After them, the reader checks the
   `ambiguous_mention` rule and the single segmentation label.
4. The v3 and v4 labels keep their rules: a v4 file with an `ambiguous_mention` reason,
   a `segmentation-v1-gaps` record or a `review_features` key is invalid (fixtures
   `invalid-v5-v4-format-*`).

## Writing

A writer emits the **lowest** format that holds the payload.

1. It first sets the file's `review_features`: the sorted union of the features of every
   record it writes `done`, and `ambiguous-mention-v1` whenever a written finding (in
   the last two history reports or in a record result) has the reason
   `ambiguous_mention`. A record it would write `done` whose features differ from that
   list is written `stale` instead, so a reader never reuses a result made under other
   features.
2. **v5** when that list is not empty or a record carries `segmentation-v1-gaps`. The
   bytes are those of v4 with `"format":"wuwaterm-manuscript-v5"` and
   `review_features` appended last.
3. Otherwise exactly v4 "Writing": v1 or v2, then v3, then v4.

The session's features do not decide what a writer writes: a record states the features
its result was made with, and the reader compares them with its own session. A v5 file
read back and written again follows
the same rule, so one that a lower format holds is written in that format (fixtures
`valid-v5-fits-v4.json`, `valid-v5-fits-v1.json` and
`valid-v5-features-without-results.json`).

## Compatibility

- **New clients** read v1 to v5 and write by the rule above. The Windows client pinned
  in `contracts/windows-ref.txt` is one: `tests/contracts/windows-manuscript.test.mjs`
  asserts that it and Web read, write and reject the cases here alike, and that long
  manuscripts built by each client's own runtime give the same bytes and are kept
  unchanged by the other.
- **Older clients** (Web 0.4.5 and earlier, and Windows 0.6.6 and earlier) read a v5
  file as unsupported and keep the manuscript that is already open:
  `workfile_too_large` over 1 MiB, otherwise `workfile_unsupported_format`.
  `cases.json` records the Web 0.4.5 code of each case as `legacy_error`, and Web's test
  asserts it against `tests/legacy/web-0.4.5/manuscript.js`, a frozen copy of that
  reader (tag `v0.4.5`).
- **v4 contract.** `contracts/manuscript-v4/` does not change. Its case
  `invalid-v4-format-v5.json` has 13 keys under the v5 label, so a v5 reader still
  gives it `workfile_unsupported_format`.
- **Core API.** Nothing of the file reaches Core. The client asks for the feature per
  request with `X-WuwaTerm-Review-Features` (`dense-128,reason-v1,ambiguous-mention-v1`);
  the Web BFF forwards the header only as the client sent it, refuses
  `ambiguous-mention-v1` without `reason-v1`, and accepts an `ambiguous_mention` finding
  only on a request that asked for it.

## Error codes

The 13 codes and their messages are those of v3 "Error codes", unchanged. v5 adds no
code.

## Fixtures

`cases.json` lists every case with `file`, an optional `pad_to_bytes`, a `note` and
`legacy_error`; a valid case also has `canonical`, an invalid case `error`. All text is
synthetic or public game terms; the generator computes every hash, digest and candidate
id.

- `valid-v5-document-ambiguous.json`: Core's enumeration case in document mode, two
  judged names and one `ambiguous_mention` finding, with an adopted candidate that waits
  for the next check. Padded to 1 MiB plus one byte it is a valid case too.
- `valid-v5-segments-ambiguous.json`: long mode with a done record holding an ambiguous
  finding, a stale record with an unconfirmed adoption of one, and a pending record.
- `valid-v5-features-without-ambiguous.json`: results made with the feature that found
  no ambiguous name; only `review_features` keeps them reusable under that feature.
- `valid-v5-gaps.json`: three paragraphs, the middle one outside every alignment. The
  two aligned paragraphs keep their done records, the gap is a pending
  `needs_manual_split` record, and every record says `segmentation-v1-gaps`.
- `valid-v5-fits-v4.json`, `valid-v5-fits-v1.json` and
  `valid-v5-features-without-results.json`: v5 files written back as
  `valid-v4-from-v5.json`, `valid-v1-from-v5.json` and `valid-v3-from-v5.json`.

The invalid cases cover a missing, unknown, repeated or null `review_features`, an
`ambiguous_mention` finding without the feature, an unknown reason, a reason on a
verified finding, an unknown or mixed segmentation label, the v4 label with each of the
three v5 additions, a v6 label, and a v5 file one byte over 44 MiB.
