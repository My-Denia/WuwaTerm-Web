# Manuscript format v3 (`wuwaterm-manuscript-v3`)

Status: contract for WuwaTerm-Web and WuwaTerm-Windows. Both parsers and writers
implement this file. `cases.json` in this directory is the shared fixture index.
Regenerate the fixtures with `node scripts/build-manuscript-v3-fixtures.mjs --write`;
without `--write` the script only checks that the committed bytes are current.

v3 makes long-manuscript term review resumable. For each segment it saves a compact
term result, the basis the result was computed under, and the user's term choices in
that segment. It also saves the user's position. v1 and v2 stay readable and keep
their meaning ([`docs/manuscript-v2.md`](../../docs/manuscript-v2.md)).

## Design note: what changes in the import rule, and why

**The rule being changed.** Core ADR 0015 decided that imported reports are history:
"报告历史与当前可信状态分开，避免把导入的旧结果当作新检查". An imported file's report may
have been computed on other text, under an older dictionary or under older matching
rules. Treating it as a fresh check would show the user a verdict the current service
never made. The same rule keeps imported choices pending until a fresh review
(`reconcileChoice` code `awaiting_fresh_basis`; an imported `not_a_term` always returns
to pending as `imported_not_a_term`).

**Why v3 changes it.** The 2026-11-15 phase brief asks that a user who handled part of
a long manuscript can save, close, reopen and continue, that edited content is checked
again, and that completed parts are not reviewed again ("不用反复审校已经完成的部分").
Under the old rule every reopen re-checks every segment, which costs one review
admission per segment, and every choice in the file has to be confirmed again.

**What now prevents a stale result from passing as a new check.** A saved segment
result is used as current only when all three of these hold:

1. Content: the SHA-256 of the segment's current source core and target core equal the
   hashes stored with the result. Those hashes are the `source_revision` and
   `target_revision` Core returned for exactly the text it checked. Any edit, by any
   client or by hand, therefore makes the result not current.
2. Basis: after opening, the client makes one live review-v2 request with
   `X-WuwaTerm-Matcher-Basis: 1`. Its response gives the current basis: `rule_version`,
   the dictionary `schema_version`, `revision`, `source_commit` and `term_count`, and
   `matcher_revision`. The stored basis must equal it in all six values. `/v1/meta`
   cannot supply this, because it returns no dictionary revision, matcher revision or
   rule version.
3. Status: the writer stored the record as `done`. A record the writer already knew to
   need a re-check is stored as `stale` and is never reused.

Core still checks every choice the client sends. A choice goes out as a review-v2
resolution whose `resolution_context` carries the current basis, and Core rejects a
stale context.

**Scope of the change.** Only v3 segment records are reused. They exist in long mode,
where either side exceeds 2,000 scalars. Document mode keeps the old rule unchanged: the
v1 `choices` and `history`, the v2 semantic decisions and the v2 semantic history. For a
v3 record that is current, its confirmed choices take effect without being confirmed
again, `not_a_term` included. This deliberately replaces `imported_not_a_term` for such
records.

**Kept unchanged.** A resumable manuscript and a report export are different things.
The current-result JSON export and the Markdown report cannot be imported to resume
work, and they are not a manuscript backup (Finding 2026-10-06, from Core PR #139:
"不可恢复报告也不能充当稿件备份").

**Files that state the old rule.** These change in M1 (Web), M2 (Windows) and ④ (Core
pins). This PR leaves them untouched.

- Core:
  - `docs/adr/0015-desktop-manuscript-workflow.md`: the third bullet under Decision (the
    workfile format) and the first bullet under Consequences.
  - `docs/adr/0016-desktop-resonance-workbench.md`: around line 48, "导入历史的可信度".
  - `contracts/products.json`: `contracts.manuscript` lists only
    `wuwaterm-manuscript-v1`, and its note says that interchange "does not certify
    historical reports against the current dictionary".
- Web:
  - `lib/manuscript.js`: the header comment says "never reusable certification".
  - `docs/sites.md`: the section "Resumable bilingual manuscripts", and the paragraph
    that starts "Per-segment term results of a long manuscript are not written to the
    manuscript file".
  - `docs/manuscript-v2.md`.
  - `docs/cross-repository-delivery.md`: "a manuscript import is not fresh
    certification", and the format list.
  - `lib/semantic-messages.ts`: `runTermHint` and `segmentTermsNotSaved`.
  - `lib/messages.ts`: `segmentTermsNote`.
- Windows: the module docstring of `src/wuwaterm_client/manuscript.py`, and
  `README.md` (the manuscript section, around lines 181 to 185).

## Terms

- **Scalar**: a Unicode scalar value. All offsets count scalars, as in v1 and v2: Python
  `str` indexes, and `Array.from(text)` indexes in JavaScript.
- **Segment core**: segmentation-v1 (Core `contracts/segmentation-v1.json`; Web
  `lib/segmentation.js` `pairSegments`) splits the whole `source` and `target` into
  pairs. Each side's core is its region without leading and trailing segmentation-v1
  whitespace: `core_start..core_end`. The core is exactly the text a client sends to
  Core for that segment's term check.
- **Long mode**: either side of the manuscript has more than 2,000 scalars. Term checks
  run per segment. Document mode (both sides at most 2,000) uses the v1 `choices` and
  `history`, unchanged.
- **Content hash**: the lowercase hexadecimal SHA-256 of the UTF-8 encoding of a core,
  with no normalization: no NFC or NFKC, no line-ending conversion, and no trimming
  beyond the core boundaries. It equals:
  - Core `text_revision(core)`;
  - the review-v2 `source_revision` or `target_revision` for a request that sent this
    core;
  - Web `revisionOf(core)`.

  The hash of an empty core is
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- **Basis**: `{rule_version, dictionary: {schema_version, source_commit, term_count, revision}, matcher_revision}`.
  Two bases are the **same** when all six values are equal. In v3 a basis must have:
  - `rule_version` `review-v2`;
  - non-empty `schema_version` and `source_commit`, at most 4,096 scalars each;
  - a safe integer `term_count` of 0 or more;
  - a 64-hex `revision` and `matcher_revision`.

  No value may be null or missing, so a basis fails closed. A response with a null
  `schema_version` or `source_commit`, or without `matcher_revision`, cannot be stored as
  a result and cannot serve as the current basis.

## File layout

The top level has exactly these 13 keys, in this order:

| Key | Content |
|---|---|
| `format` | `"wuwaterm-manuscript-v3"` |
| `source`, `target`, `direction`, `alignments`, `choices`, `history` | as in v1 |
| `semantic_decisions`, `semantic_texts`, `semantic_history` | as in v2 |
| `segments` | an array of segment records, at most 128 |
| `segment_choice_history` | an array of history choices, at most 128 |
| `progress` | the progress object |

The v1 and v2 parts keep their v2 validation and error codes. Their limits are in the
table under "Limits"; only the text and file size limits change.

### Segment record

Exact keys, in this order:

| Key | Rule |
|---|---|
| `index` | integer, equal to the record's position in `segments` (0-based) |
| `segmentation_version` | `"segmentation-v1"` |
| `source_start`, `source_end` | integers, the source core range in the saved `source`; `0 <= start <= end <= scalar length` |
| `target_start`, `target_end` | the same for the target core in the saved `target` |
| `source_hash`, `target_hash` | content hashes of the cores (64 lowercase hex) |
| `status` | `"pending"`, `"done"` or `"stale"` |
| `basis` | `null` when pending; otherwise a v3 basis |
| `result` | `null` when pending; otherwise a compact term result for the two cores |
| `choices` | an array of segment choices, at most 32 |

- **pending**: there is no result for this content. `basis` and `result` are null. The
  record may still hold choices; they wait for the next check. A record is pending when:
  - the segment was never checked, or its check failed;
  - the segment is not ready (for example `needs_manual_split`);
  - the content changed since the last result, in which case the result was dropped.
- **done**: `result` is Core's review-v2 response for exactly these cores, compacted as
  described below. The request that produced it carried exactly the record's confirmed
  choices as resolutions (see "Runtime", step 6). `basis` is that response's basis.
- **stale**: like done, but the writer knew the record needs a re-check. Either a later
  response in the session had a different basis, or the confirmed choices changed after
  the result. A reader never reuses a stale result.

For done and stale records, both cores must have 1 to 2,000 scalars, which is Core's
request limit.

Records cover every segment of the writer's segmentation, in order. Consecutive records
do not overlap: each `source_start` is at least the previous `source_end`, and the same
holds for the target.

### Compact term result

A done or stale record stores only what the review UIs render and what reconciling
choices needs. Exact keys, in this order:

| Key | Rule |
|---|---|
| `truncated` | boolean: the response's `truncated` |
| `evaluated`, `not_evaluated` | safe integers of 0 or more: the response's `coverage` counts |
| `findings` | at most 32, in the response's order |

Each finding has exact keys, in this order:

| Key | Rule |
|---|---|
| `verdict` | `verified_constraint`, `confirmed_conflict`, `needs_review` or `not_evaluated` |
| `source` | `[start, end]`, with `0 <= start < end <= ` the source core's scalar length |
| `target` | `[start, end]` within the target core, or `null` |
| `candidates` | at most 8 objects `{candidate_id, zh, en, category}` with distinct 64-hex ids; `zh` and `en` non-empty, at most 2,000 scalars; `category` non-empty, at most 256 |
| `candidates_truncated` | boolean |

No two findings may have the same `source`.

**What is dropped from the review-v2 response, and why.**

| Field | Why it is not stored |
|---|---|
| `source_revision`, `target_revision` | Equal to the record's `source_hash` and `target_hash` |
| `rule_version`, `matcher_revision`, `dictionary` | Equal to the record's `basis` |
| `request_id` | No UI shows the id of an old request for a saved result |
| `coverage.rules` | Always `["review.term_pair", "review.sentence_meaning"]` in review-v2 |
| finding `id` | Equal to the mention id of the source span, `` `${start}:${end}:${text}` `` |
| finding `rule_id` | Always `review.term_pair` in review-v2. A response with another rule id is not stored: the writer writes the record as pending |
| span `text` | The core slice at the span |
| candidate `sources` | Only the Web document-mode report shows them. Document mode keeps full reports in v1 `history`, and long mode shows none (Web `semantic-workbench.tsx` term rows, Windows `_show_segment_term_report`) |

The kept fields serve named needs:

- `verdict`, the spans and the candidates' `zh` and `en` are what both long-mode UIs
  render.
- `candidate_id`, `zh`, `en` and `category` together are the candidate identity that
  reconciling checks.
- `candidates_truncated` decides whether a `not_a_term` can be kept.
- `truncated` and the coverage counts are what the Windows status line shows.

A client that renders through its existing report code rebuilds the dropped fields
from the record.

The compact result uses a strict subset of the response's fields. Its minified size is
therefore never larger than Core's response, which Core caps at 65,536 bytes
(`REVIEW_MAX_JSON_BYTES`).

### Segment choice

A segment choice is a user's term decision at one occurrence in a segment. Exact keys,
in this order:

| Key | Rule |
|---|---|
| `source_span` | `{start, end, text}`, relative to the record's source core. `end > start`. `text` is non-empty, at most 2,000 scalars, and `end - start` equals its scalar length |
| `choice` | `"official_pair"` or `"not_a_term"` |
| `candidate` | for `official_pair`, `{candidate_id, zh, en, category}`, with the field rules of a result candidate; for `not_a_term`, `null` |
| `offered` | for `not_a_term`, the candidate ids the occurrence offered when the user decided, as distinct 64-hex strings in ascending order, at most 8; for `official_pair`, `[]` |
| `confirmed` | boolean: the user made or confirmed the choice against the record's current result. Always `false` in a pending record |

The occurrence's mention id is `` `${start}:${end}:${text}` ``, the same as a review-v2
finding `id`. A choice therefore maps one to one onto a review-v2 resolution,
`{mention_id, choice, candidate_id}`.

- The span must lie inside the record's source core and read the same there.
- In a done or stale record, every confirmed choice must match a finding of the result
  with the same source span:
  - for `official_pair`, that finding must have a candidate with the same
    `candidate_id`, `zh`, `en` and `category`;
  - for `not_a_term`, its candidate ids must equal `offered` as a set.
- Two choices in one record may not have the same `start` and `end`.
- In a done or stale record, a choice that is not confirmed **needs reconfirmation**. It
  is shown with its surface text and candidate, but it is never sent to Core and never
  applied.
- In a pending record no choice is confirmed. Its choices wait for the next check and
  are realigned against it ("Runtime", step 7).

### Segment choice history

These are choices whose occurrence no longer exists in the text: the user edited the
occurrence itself, or deleted its segment. They are kept so that the user's decision is
not lost silently. They are never applied and never sent to Core.

Each entry has exact keys, in this order: `source_hash` (64 hex: the content hash of the
source core the choice was last placed in), `source_span`, `choice`, `candidate`,
`offered`. The structure follows the segment choice rules. The span is not checked
against any text. The array is ordered oldest first.

### Progress

The progress object is `{current, completed}`, with exact keys in this order.

- `current`: `null`, or the `index` of an existing record. It is the segment the user
  was working on.
- `completed`: the indexes the user marked as finished, strictly ascending. Each must be
  a record with status `done`.

## Limits

| Limit | v1 / v2 | v3 | Reason |
|---|---|---|---|
| File size (UTF-8 bytes) | 1 MiB (1,048,576) | 12 MiB (12,582,912) | See "Size arithmetic" |
| `source`, `target` | 1,048,576 scalars | 12,582,912 scalars | Bounded by the file size |
| Array items, any array | 128 | 128 | Unchanged. Old clients then reject a v3 file within 1 MiB as an unsupported format, and v2 fixtures keep their codes |
| Object fields, any object | 32 | 32 | Unchanged; the largest v3 object has 13 |
| Nesting depth | 16 | 16 | Unchanged. The deepest value in a v3 part is at depth 8; v1 and v2 parts reach depth 10 |
| `segments` | none | 128 | At most 1,800 scalars per core, so 128 segments hold about 150,000 to 230,000 scalars per side |
| findings per result | none | 32 | Core returns at most 32 findings |
| candidates per finding | none | 8 | Core returns at most 8 candidates |
| `choices` per record | none | 32 | One choice per occurrence, and Core returns at most 32 |
| `offered` per choice | none | 8 | Core returns at most 8 candidates |
| `segment_choice_history` | none | 128 | The generic array cap |
| `progress.completed` | none | 128 | At most one per record |
| `choices` (document mode) | 32 | 32 | Document mode is unchanged; one check of at most 2,000 scalars returns at most 32 findings |
| `history` (document reports) | 2 | 2 | As above |
| `alignments` | 64 | 64 | Core accepts at most 64 per request |
| `semantic_decisions` | 128 | 128 | Semantic review stays experimental and off by default. Raising this would raise the generic array cap; that is a follow-up if semantic review is enabled for long manuscripts |
| `semantic_texts` | 16 | 16 | Each entry is a whole old text, bounded by the file size |
| `semantic_history` | 2 | 2 | Reference data |
| Segments per `semantic_history` snapshot | 64 | 64 | Reference data. The writer stores the segments that still match, so a run over more segments keeps 64 |

Over any limit, the parser rejects the file with the code given below, and the writer
fails the save with that code. Nothing is truncated silently. The only exceptions are
the two reference-data cases v2 already defines:

- the writer keeps the last 2 document reports;
- the writer drops the oldest `semantic_history` snapshots first while the file is over
  its size cap.

A save that fails leaves the existing file and the open work untouched. Its message
says how to continue: split the manuscript into parts of at most 128 segments, or
remove entries from the choice history.

### Size arithmetic

All sizes are canonical bytes, which are minified (see "Canonical bytes"). The test
`tests/manuscript-v3.test.mjs` builds these models in memory with `budgetManuscript`
from the fixture generator, prints their sizes and asserts the cap margin.

In every model, each segment has a CJK source core (3 bytes per scalar) and an ASCII
target core of the same scalar length, separated by blank lines. Done records carry a
full basis. Half of the choices are `not_a_term` with full `offered`.

| Model | Segments | Per result | Choices | File |
|---|---|---|---|---|
| 20,000-scalar source | 12 x 1,667 | 16 findings, one in four with 2 candidates | 4 | 0.15 MiB |
| 100,000-scalar source | 60 x 1,667 | as above | 4 | 0.76 MiB |
| Dense | 128 x 1,800 | Core's 32-finding cap, 2 candidates each | 8 | 2.90 MiB |
| Limit | 128 x 1,800 | 32 findings x 8 candidates | 32, 8 offered | 8.20 MiB |
| Extreme | 128 x 1,800 | 32 x 8, candidate strings lengthened until each minified result is just under Core's 65,536-byte response cap | 32, 8 offered | 10.99 MiB |

**Cap arithmetic.** The limit model reaches every count cap at 8.20 MiB. A 25% margin
gives 10.25 MiB, so the cap is the next whole step, 12 MiB.

The extreme model is bounded by Core, because no stored result can be larger than
Core's response. It also fits, at 10.99 MiB. A save therefore exceeds 12 MiB only
through text far beyond these models, such as very long whitespace between segments or
many 4-byte scalars, or through semantic data. Such a save fails with an explicit
error.

The full review-v2 response, pretty-printed as earlier drafts stored it, made the dense
model 8.9 MiB and the limit model more than 20 MiB. The compact minified record is
about 3 times smaller for the same content.

## Reading

A reader decides by these steps, in order. The first failure gives the code, and both
parsers must report the same code for the same bytes.

1. If the file's bytes are not valid UTF-8, the code is `workfile_not_json`. If they
   exceed 12 MiB, the code is `workfile_too_large`. What a parser function does with an
   argument that is not a string is a local API detail, outside this contract.
2. If the content parses as JSON, the top level is an object, and its `format` is
   `"wuwaterm-manuscript-v3"`, continue with step 3. Otherwise, apply the v2 reader
   unchanged, starting with its 1 MiB check. Every non-v3 input therefore gets the v2
   reader's result and code. A non-JSON input over 1 MiB gives `workfile_too_large`, as
   before.
3. Apply the tree caps, the same as v2 and checked in the same way:
   - an array over 128 items gives `workfile_too_many_entries`;
   - an object over 32 fields gives `workfile_too_many_fields`;
   - depth over 16 gives `workfile_too_deep`;
   - a `__proto__`, `constructor` or `prototype` key gives `workfile_forbidden_field`.
4. If the top-level keys are not exactly the 13 v3 keys, the code is
   `workfile_unsupported_format`.
5. Check the v1 and v2 parts with exactly the v2 checks and codes
   (`workfile_invalid_content`, `workfile_duplicate_choices`). The only exception is
   the text limits that v2 ties to the file size: `source`, `target`,
   `semantic_texts[].text` and the `semantic_history` texts may have up to 12,582,912
   scalars.
6. Check the structure of each record, in array order:
   - `segments` is an array, and each record has the exact keys.
   - Each field has a valid type and value, and the ranges lie within the texts.
     `index` only has to be an integer here; its value is checked in step 7.
   - `basis` and `result` are null exactly when the status is `pending`.
   - Every basis is valid.
   - The result has its exact keys and value types. Each finding has its exact keys, a
     known verdict, and `[start, end]` pairs with `0 <= start < end`. Each candidate has
     its exact keys and valid values, and candidate ids are distinct within the
     finding.
   - Each choice has a valid structure, including the `offered` rules, and `confirmed`
     is false in a pending record.

   Each count over its cap (findings 32, candidates 8, choices 32, `offered` 8) gives
   `workfile_too_many_entries`. Any other failure here gives
   `workfile_segment_invalid`.
7. Check the order across records. If an `index` differs from the record's position, or
   if ranges overlap or go backwards, the code is `workfile_segment_order`.
8. Check the content of each record, in array order:
   1. For done and stale records only, the cores must have 1 to 2,000 scalars. Each
      finding's `source` must lie within the source core, and its `target`, when
      present, within the target core. No two findings may share a `source`. Otherwise
      the code is `workfile_segment_invalid`.
   2. Each choice's span must lie inside the source core and read the same there. In a
      done or stale record, each confirmed choice must also match its finding as
      described above. Otherwise the code is `workfile_segment_anchor_invalid`.
   3. If two choices share `start` and `end`, the code is `workfile_duplicate_choices`.
9. Check `segment_choice_history`. It must be an array whose entries are checked like a
   segment choice in step 6, without `confirmed`. `offered` over 8 gives
   `workfile_too_many_entries`, and any other failure gives
   `workfile_segment_invalid`. Step 3 already bounds the entry count.
10. Check `progress`. It must have exact keys, `current` must be null or the index of an
    existing record, and `completed` must be strictly ascending with every entry the
    index of a done record. Otherwise the code is `workfile_progress_invalid`.

Integer fields accept any JSON number whose value is a safe integer, so `3.0` reads as
`3`. JavaScript cannot tell the two apart after parsing, so Python must accept and
normalize them too. The canonical form writes plain integers. Python's existing
strict-integer check on v2 decision fields is unchanged in v3 and remains a known
difference.

**Parsing checks structure, ranges, and the result and choices against the current
cores, but it computes no hashes.** Web `parseWorkfile` is synchronous and SHA-256 in
the browser is not, so the v2 precedent applies: hashes are verified before use. A
record whose stored hash differs from its current core is therefore a valid file, and
its result is simply not current at runtime (see the fixture
`valid-v3-hash-not-current.json`).

## Writing

**Which format.** A writer emits the lowest format that holds the payload:

1. If `segments` and `segment_choice_history` are empty and the v2 writer's output fits
   in 1 MiB, the writer emits exactly those v1 or v2 bytes. The v2 writer's output is
   v1 when there is no semantic data, and otherwise v2 with its oldest-first
   `semantic_history` trimming. Old clients keep opening these files.
2. Otherwise the writer writes v3. In v3, the oldest `semantic_history` snapshots are
   dropped only while the file exceeds 12 MiB. Records, choices, history choices and
   semantic decisions are never dropped. If the file is still too large, the save fails
   with `workfile_too_large`.

A reopened v3 file without segment state is therefore written back as v2 or v1 (see
the fixture `valid-v3-from-v2.json`).

**Records.** At save time, the writer stores one record per segment of the current
segmentation-v1 pairing, using the current `alignments`, in order.

- If the content of a done or stale record changed since its result, the record becomes
  pending. Its hashes are recomputed, its result and basis are dropped, and its choices
  become unconfirmed.
- If the direction changes, every record becomes pending.
- If the manuscript has more than 128 segments, the save fails with
  `workfile_too_many_entries`. The message tells the user to split the manuscript.
  Saving without segment records is allowed only as the user's explicit choice.

**Choices.** A choice stays in the record whose source core holds its occurrence.

- The writer relocates the choice through edits so that its span still reads the same
  in that core. Any mapping that preserves the text is acceptable, for example Web's
  `diffSplice`/`mapSpan`. Across a whole-text replacement, the reference rule is v1's
  `recoverSpan`: an identical, unique, complete line block.
- A choice that cannot be placed moves to `segment_choice_history`, with the hash of the
  source core it was last in. If that history would exceed 128 entries, the save fails
  with `workfile_too_many_entries` and the user removes history entries. Nothing is
  dropped silently.
- Adding, changing or confirming a choice in a done record makes the record stale.

**Progress.** `current` is the user's segment. The writer removes an index from
`completed` once its record is no longer done.

**Canonical bytes.** A v3 file is minified JSON. In JavaScript the writer outputs
`JSON.stringify(value)`, which is byte-identical to Python
`json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)`:

- no whitespace between tokens;
- non-ASCII characters written as they are;
- no trailing newline.

Keys are in the orders given in this document. The v1 and v2 parts keep the values and
key order the v2 writer gives them; in a v3 file they are minified like the rest. v1
and v2 files themselves stay pretty-printed, exactly as today.

## Runtime: reopening and re-checking

1. **No request on import.** Parsing never sends anything. Until the live basis
   arrives (step 4), the client shows saved results as saved, not as current, and sends
   no resolutions.
2. **Matching records to segments.** The reader pairs the current text with
   segmentation-v1. If the number of segments and every core range equal the records,
   records map by position. Otherwise:
   - Each current segment takes the first unused record with equal `source_hash` and
     `target_hash`.
   - A segment still unmatched takes the first unused record with an equal
     `source_hash`. It keeps that record's choices, unconfirmed; the result is not
     reused.
   - Every other segment is pending.
   - The choices of records left unused move to `segment_choice_history`.
   - `progress` follows the mapping.
3. **Content check, before any use.** The reader computes the hashes of the current
   cores. A result is a reuse candidate only if its record is done and both hashes are
   equal.
4. **Live basis.** The client sends one review-v2 term check with
   `X-WuwaTerm-Matcher-Basis: 1`. The probe goes to the first of these:
   - the segment at `progress.current`, if that segment needs a check;
   - the first segment that needs a check;
   - the segment at `progress.current`, or index 0.

   It costs one review admission, like any segment check. Its response basis becomes
   the current basis. If the response has no `matcher_revision`, or a null
   `schema_version` or `source_commit`, there is no current basis, and no saved result
   is reused in this session.

   The probe carries no resolutions, because the current basis is not yet known. Its
   response is used as follows:
   - If the probed record turns out to be current by step 5, it stays as stored. The
     probe only supplied the basis and replaces nothing.
   - Otherwise the probe counts as that segment's first request without resolutions in
     step 6.

   Reopening an unchanged manuscript whose basis is unchanged therefore costs exactly
   one review request.
5. **Current or stale.** A reuse candidate whose basis is the same as the current basis
   is current. It is not checked again, and its confirmed choices take effect without
   being confirmed again. Every other record that has a result is stale and is checked
   again. Whenever a later response carries a different basis, that basis becomes
   current and every record is evaluated again by this step.
6. **Re-check.** A segment is checked in one or two requests.
   - If its source hash and basis are unchanged from the record (only the target
     changed, or its choices changed), one request sends the confirmed choices as
     resolutions. The `resolution_context` is
     `{source_revision: source core hash, rule_version, dictionary_revision, matcher_revision}`,
     taken from the current basis.
   - Otherwise, the first request carries no resolutions. The choices are realigned
     against its findings (step 7). If any choice was kept, the segment is checked once
     more with them.

   The stored result is always the compact form of the last response.
7. **Realignment** compares each choice with the new result's findings by occurrence
   and candidate.
   - An `official_pair` is kept when the finding at the same source span still has a
     candidate with the same `candidate_id`, `zh`, `en` and `category`.
   - A `not_a_term` is kept when a finding at the same source span still exists, its
     `candidates_truncated` is false, and its candidate ids equal `offered`.
   - A kept choice becomes confirmed.
   - Any other choice is unconfirmed and needs reconfirmation. It is shown and never
     dropped automatically. The user either confirms it again, which sets `offered`
     from the current finding for a `not_a_term`, or removes it.
8. **History choices** are never applied. If a current segment's source hash equals an
   entry's `source_hash`, the client may offer to restore that entry as an unconfirmed
   choice.
9. **Failures.** A failed or cancelled check changes only that segment. The results of
   other segments, the choices and `progress` are kept, and the run can continue from
   the failed segment.

## Compatibility

- **New clients** read v1, v2 and v3, and write by the format rule above.
- **Old clients** (Web 0.2.0, Windows 0.4.2, and anything earlier) reject every v3 file
  with an explicit error. They load nothing from it, never load it partially, and keep
  the manuscript they already have open:
  - A v3 file of at most 1 MiB gives `workfile_unsupported_format` ("不支持此稿件格式或版本").
    Every valid v3 file keeps the generic tree caps, so it passes their tree checks and
    reaches the format check.
  - A v3 file over 1 MiB gives `workfile_too_large` ("稿件文件不能超过 1 MiB"), because
    that is their first check.

  With compact records, a typical 100,000-scalar manuscript is about 0.76 MiB, so old
  clients usually report the unsupported format. Only manuscripts larger than about
  100,000 scalars, or with dense results, reach the 1 MiB check first.

  `cases.json` records each case's expected old-client code as `legacy_error`. Web's
  test asserts it against `lib/manuscript.js`. When this spec was added, that file was
  unchanged since tag `v0.2.0` (5aabe80), so the test checks the Web 0.2.0 parser.
  Before M1 changes `lib/manuscript.js`, it must freeze a copy of the v0.2.0 parser for
  this check. The Windows 0.4.2 parser also gave every case its `legacy_error` when the
  fixtures were created.
- **v2 contract.** Every input that is not a v3 object is read exactly as before. Every
  case in `contracts/manuscript-v2/cases.json` keeps its code under a v3 reader, and
  Web's test asserts this.
- **Core API.** No change is needed.
  - A segment check is an ordinary review-v2 request of at most 2,000 scalars per side.
  - Segment choices go out as review-v2 `resolutions` with a `resolution_context` of
    `{source_revision, rule_version, dictionary_revision, matcher_revision}`. Core
    accepts this today, and the Web BFF forwards up to 32 resolutions with that four-key
    context.
  - Windows `ApiClient.review_pair` does not send resolutions yet. Adding them is a
    Windows client change in M2.

## Error codes

Both parsers use these codes. The messages are the canonical Chinese data form, and UIs
localize them by code.

| Code | Case | Message |
|---|---|---|
| `workfile_not_json` | not UTF-8, or not JSON | 无法读取 JSON 稿件文件。 |
| `workfile_too_large` | over 12 MiB, or a non-v3 input over 1 MiB | 稿件文件超过大小上限（v1/v2 为 1 MiB，v3 为 12 MiB）；请把稿件拆成较小的几份。 |
| `workfile_too_deep` | depth over 16 | 稿件文件嵌套过深。 |
| `workfile_too_many_entries` | an array over 128 items, or a v3 count over its limit | 稿件文件条目过多；超过 128 段的稿件请拆成几份保存。 |
| `workfile_too_many_fields` | an object over 32 fields | 稿件文件字段过多。 |
| `workfile_forbidden_field` | a `__proto__`, `constructor` or `prototype` key | 稿件文件含不支持的字段。 |
| `workfile_unsupported_format` | an unknown `format`, or wrong top-level keys | 不支持此稿件格式或版本。请导入“保存稿件”生成的文件。 |
| `workfile_invalid_content` | an invalid v1/v2 part | 稿件内容、选择或位置依据无效；当前稿件未被替换。 |
| `workfile_duplicate_choices` | two choices for one occurrence, in a v1/v2 part or in one record | 稿件包含同一位置的重复选择，未导入。 |
| `workfile_segment_invalid` | a malformed record, result, finding, segment choice, history choice or basis; for example an unknown status or segmentation version, bad hex, a range outside the text or core, or a status, basis and result that disagree | 稿件的分段记录无效；当前稿件未被替换。 |
| `workfile_segment_order` | an index that is not its position (duplicated or out of order), or ranges that overlap or go backwards | 稿件的分段顺序或位置无效；当前稿件未被替换。 |
| `workfile_segment_anchor_invalid` | a choice outside its core or not reading the same, or a confirmed choice without its finding or candidate | 稿件的逐段术语选择位置无效；当前稿件未被替换。 |
| `workfile_progress_invalid` | a malformed `progress`, or one pointing at a missing or not-done record | 稿件的进度记录无效；当前稿件未被替换。 |

Web 0.2.0 and Windows 0.4.2 say "稿件文件不能超过 1 MiB。" for `workfile_too_large`. New
clients use the message above.

## Fixtures

`cases.json` lists every fixture case. Every case has `file`, an optional
`pad_to_bytes`, a `note` and `legacy_error`. A valid case also has `canonical`, and an
invalid case also has `error`.

- `pad_to_bytes`: read `file` and append ASCII spaces (U+0020) until its UTF-8 length
  equals this number. The padding is JSON whitespace, so the parsed value does not
  change. This keeps the 1 MiB and 12 MiB boundary cases out of the working tree.
- `canonical`: the file whose exact bytes a conforming writer produces from the parsed
  value.
- `error`: the code a v3 reader must report.
- `legacy_error`: what Web 0.2.0 and Windows 0.4.2 report. `null` means accepted.

All text is synthetic. Hashes and candidate ids are computed by the generator, never
typed. Two groups of fixtures use ranges that are not a segmentation-v1 result: the
128-segment fixtures (short paragraphs) and the core-length boundary fixtures. Parsers
do not run segmentation. The other v3 fixtures use ranges that `pairSegments` produces
for their text.
