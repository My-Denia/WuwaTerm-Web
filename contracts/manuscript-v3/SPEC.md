# Manuscript format v3 (`wuwaterm-manuscript-v3`)

Status: contract for WuwaTerm-Web and WuwaTerm-Windows. Both parsers and writers
implement this file; `cases.json` in this directory is the shared fixture index.
Regenerate the fixtures with `node scripts/build-manuscript-v3-fixtures.mjs --write`;
without `--write` the script only checks that the committed bytes are current.

v3 adds resumable per-segment term review to long manuscripts: each segment's term
result, the basis it was computed under, the user's term choices in that segment, and
the user's position. v1 and v2 stay readable and keep their meaning
([`docs/manuscript-v2.md`](../../docs/manuscript-v2.md)).

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
result is used as current only when all of these hold:

1. Content: the SHA-256 of the segment's current source core and target core equal the
   hashes stored with the result. Those hashes are the `source_revision` and
   `target_revision` Core returned for exactly the text it checked, so any edit, by any
   client or by hand, makes the result not current.
2. Basis: after opening, the client makes one live review-v2 request with
   `X-WuwaTerm-Matcher-Basis: 1`. Its response gives the current basis: `rule_version`,
   the dictionary `schema_version`, `revision`, `source_commit` and `term_count`, and
   `matcher_revision`. The stored basis must equal it in all six values. `/v1/meta` cannot
   supply this, because it returns no dictionary revision, matcher revision or rule
   version.
3. Status: the writer stored the record as `done`. A record the writer already knew to
   need a re-check is stored as `stale` and is never reused.

Core still checks every choice the client sends. A choice goes out as a review-v2
resolution whose `resolution_context` carries the current basis, and Core rejects a
stale context.

**Scope of the change.** Only v3 segment records (long mode, where either side exceeds
2,000 scalars) are reused. Document mode keeps the old rule unchanged: the v1 `choices`
and `history`, v2 semantic decisions and semantic history. For a v3 record that is
current, its confirmed choices take effect without confirmation again, `not_a_term`
included. This deliberately replaces `imported_not_a_term` for such records.

**Kept unchanged.** A resumable manuscript and a report export are different things.
The current-result JSON export and the Markdown report cannot be imported to resume
work, and they are not a manuscript backup (Finding 2026-10-06, from Core PR #139:
"不可恢复报告也不能充当稿件备份").

**Files that state the old rule.** These change in M1 (Web), M2 (Windows) and ④ (Core
pins); this PR leaves them untouched.

- Core: `docs/adr/0015-desktop-manuscript-workflow.md` (Decision, the third bullet on the
  workfile format; Consequences, the first bullet), `docs/adr/0016-desktop-resonance-workbench.md`
  (around line 48, "导入历史的可信度"), and `contracts/products.json`. Its `contracts.manuscript`
  lists only `wuwaterm-manuscript-v1`, and its note says interchange "does not certify
  historical reports against the current dictionary".
- Web:
  - `lib/manuscript.js`: the header comment says "never reusable certification".
  - `docs/sites.md`: the section "Resumable bilingual manuscripts" and the paragraph
    starting "Per-segment term results of a long manuscript are not written to the
    manuscript file".
  - `docs/manuscript-v2.md`.
  - `docs/cross-repository-delivery.md`: "a manuscript import is not fresh
    certification", and the format list.
  - `lib/semantic-messages.ts`: `runTermHint` and `segmentTermsNotSaved`.
  - `lib/messages.ts`: `segmentTermsNote`.
- Windows: the module docstring of `src/wuwaterm_client/manuscript.py`, and `README.md`
  (the manuscript section, around lines 181-185).

## Terms

- **Scalar**: a Unicode scalar value. All offsets count scalars, as in v1 and v2 (Python
  `str` indices; `Array.from(text)` indices in JavaScript).
- **Segment core**: segmentation-v1 (Core `contracts/segmentation-v1.json`; Web
  `lib/segmentation.js` `pairSegments`) splits the whole `source` and `target` into
  pairs. Each side's core is its region with leading and trailing segmentation-v1
  whitespace removed: `core_start..core_end`. The core is exactly the text a client
  sends to Core for that segment's term check.
- **Long mode**: either side of the manuscript has more than 2,000 scalars. Term checks
  run per segment. Document mode (both sides at most 2,000) uses the v1 `choices` and
  `history`, unchanged.
- **Content hash**: lowercase hexadecimal SHA-256 of the UTF-8 encoding of a core, with
  no normalization: no NFC or NFKC, no line-ending conversion, and no trimming beyond
  the core boundaries. It equals Core `text_revision(core)`, the review-v2
  `source_revision`/`target_revision` for a request that sent this core, and Web
  `revisionOf(core)`. The hash of an empty core is
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- **Basis**: `{rule_version, dictionary: {schema_version, source_commit, term_count, revision}, matcher_revision}`.
  Two bases are the **same** when all six values are equal. In v3 a basis must have
  `rule_version` `review-v2`, non-empty `schema_version` and `source_commit` (at most
  4,096 scalars each), a safe integer `term_count` of 0 or more, and 64-hex `revision`
  and `matcher_revision`. Nothing in v3 is null or missing, so it fails closed. A
  response with a null `schema_version` or `source_commit`, or without
  `matcher_revision`, cannot be stored as a result and cannot serve as the current
  basis.

## File layout

The top level has exactly these 13 keys, in this order:

| Key | Content |
|---|---|
| `format` | `"wuwaterm-manuscript-v3"` |
| `source`, `target`, `direction`, `alignments`, `choices`, `history` | as in v1 |
| `semantic_decisions`, `semantic_texts`, `semantic_history` | as in v2 |
| `segments` | array of segment records, at most 128 |
| `segment_choice_history` | array of history choices, at most 128 |
| `progress` | progress object |

The v1 and v2 parts keep their v2 validation and their error codes. Their limits are in
the table under "Limits"; only the text and file size limits change.

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
| `report` | `null` when pending; otherwise a review-v2 report for the two cores |
| `choices` | array of segment choices, at most 32 |

- **pending**: no result for this content. Either it was never checked, the check
  failed, the segment is not ready (for example `needs_manual_split`), or the content
  changed since the last result (the report is dropped). `basis` and `report` are null.
  The record may still hold choices; they wait for the next check.
- **done**: `report` is Core's response for exactly these cores. The request that
  produced it carried exactly the record's confirmed choices as resolutions (see
  "Re-check"). `basis` is the same as the report's basis.
- **stale**: like done, but the writer knew it needs a re-check. Either a later
  response in the session had a different basis, or the confirmed choices changed after
  the report. A reader never reuses a stale result.

For done and stale records, both cores must have 1 to 2,000 scalars (Core's request
limit). The report must also meet four conditions:

- It is accepted by the v2 report validator (`validReport(report, sourceCore, targetCore)`
  in Web, `valid_report` in Windows): exact keys, spans that read the same inside the
  cores, at most 32 findings, 8 candidates and 8 sources.
- It has `rule_version` `review-v2` and a `matcher_revision`.
- Its `source_revision` and `target_revision` equal the record's hashes.
- Its basis is the same as the record's `basis`.

Records cover every segment of the writer's segmentation, in order. Consecutive records
do not overlap: each `source_start` is at least the previous `source_end`, and likewise
for the target.

### Segment choice

A user's term decision at one occurrence in a segment. Exact keys, in this order:

| Key | Rule |
|---|---|
| `source_span` | `{start, end, text}` relative to the record's source core; `end > start`; `text` non-empty, at most 2,000 scalars, `end - start` equals its scalar length |
| `choice` | `"official_pair"` or `"not_a_term"` |
| `candidate` | `{candidate_id, zh, en, category}` for `official_pair` (64-hex id; `zh` and `en` non-empty, at most 2,000 scalars; `category` non-empty, at most 256); `null` for `not_a_term` |
| `offered` | candidate ids the finding offered when the user decided: distinct 64-hex strings in ascending order, at most 8; an `official_pair` candidate id must be among them |
| `basis` | the v3 basis under which the user made or last confirmed the choice |

The occurrence's mention id is `` `${start}:${end}:${text}` ``, the same as a review-v2
finding `id`. A choice therefore maps one to one onto a review-v2 resolution:
`{mention_id, choice, candidate_id}`.

- The span must lie inside the record's source core and read the same there.
- A choice is **confirmed** when its basis is the same as the record's basis. In a done
  or stale record, every confirmed choice must match a finding in the record's report
  whose `id` is the mention id. That finding's candidate ids must equal `offered` as a
  set. An `official_pair` must name a candidate of that finding with the same
  `candidate_id`, `zh`, `en` and `category`.
- Two choices in one record may not have the same `start` and `end`.
- In a done or stale record, a choice that is not confirmed **needs reconfirmation**. It
  is shown with its surface text and candidate. It is never sent to Core and never
  applied. In a pending record no choice is confirmed. Its choices wait for the next
  check and are realigned against it ("Runtime", step 7).

### Segment choice history

Choices whose occurrence no longer exists in the text. The user edited the occurrence
itself, or deleted its segment. They are kept so the user's decision is not lost
silently. They are never applied and never sent to Core. Exact keys, in this order:
`source_hash` (64 hex: the content hash of the source core the choice was last placed
in), `source_span`, `choice`, `candidate`, `offered`, `basis`. Each field follows the
segment choice rules for structure only. The span is not checked against any text.
The array is ordered oldest first.

### Progress

`{current, completed}`, exact keys in this order.

- `current`: `null`, or the `index` of an existing record. It is the segment the user
  was working on.
- `completed`: indexes the user marked as finished, strictly ascending. Each must be a
  record with status `done`.

## Limits

| Limit | v1 / v2 | v3 | Reason |
|---|---|---|---|
| File size (UTF-8 bytes) | 1 MiB (1,048,576) | 16 MiB (16,777,216) | See "Size arithmetic" |
| `source`, `target` | 1,048,576 scalars | 16,777,216 scalars | Bounded by the file size |
| Array items, any array | 128 | 128 | Unchanged. Old clients then reject a v3 file within 1 MiB as an unsupported format, and v2 fixtures keep their codes |
| Object fields, any object | 32 | 32 | Unchanged; the largest v3 object has 13 |
| Nesting depth | 16 | 16 | Unchanged; the deepest v3 value is at depth 10 |
| `segments` | none | 128 | At most 1,800 scalars per core, so 128 segments hold about 150,000 to 230,000 scalars per side |
| `choices` per record | none | 32 | Core returns at most 32 findings per check, and there is one choice per occurrence |
| `offered` per choice | none | 8 | Core returns at most 8 candidates per finding |
| `segment_choice_history` | none | 128 | The generic array cap |
| `progress.completed` | none | 128 | At most one per record |
| `choices` (document mode) | 32 | 32 | Document mode is unchanged; one check at most 2,000 scalars returns at most 32 findings |
| `history` (document reports) | 2 | 2 | As above |
| `alignments` | 64 | 64 | Core accepts at most 64 per request |
| `semantic_decisions` | 128 | 128 | Semantic review stays experimental and off by default. Raising it would raise the generic array cap; it is a follow-up if semantic review is enabled for long manuscripts |
| `semantic_texts` | 16 | 16 | Each entry is a whole old text, bounded by the file size |
| `semantic_history` | 2 | 2 | Reference data |
| Segments per `semantic_history` snapshot | 64 | 64 | Reference data. The writer stores the segments that still match; a run over more segments keeps 64 |

Over any limit, the parser rejects the file with the code below, and the writer fails
the save with that code. Nothing is truncated silently. The only exceptions are the two
reference-data cases v2 already defines: the writer keeps the last 2 document reports,
and drops the oldest `semantic_history` snapshots first while the file is over its size
cap. A save that fails leaves the existing file and the open work untouched.

### Size arithmetic

All sizes are canonical bytes (pretty-printed, see "Canonical bytes"). The test
`tests/manuscript-v3.test.mjs` builds all three models in memory with
`budgetManuscript` from the fixture generator. It asserts that the typical model fits
8 MiB, that the dense model needs more than 8 MiB and fits 16 MiB, and that the extreme
model does not fit 16 MiB.

The model texts are 128 segments, each with an 1,800-scalar CJK source core
(3 bytes per scalar) and an 1,800-scalar ASCII target core, with paragraph breaks. The
two texts alone take about 0.9 MiB. In the model reports, each candidate has 2 sources,
a choice has its full basis, and `offered` lists the finding's candidates.

| Model | Per segment | 128 segments, with text | Fits 16 MiB |
|---|---|---|---|
| Typical: 16 findings (one in four with 2 candidates), 4 choices | about 26 KiB | 4.17 MiB | yes |
| Dense: Core's 32-finding cap, 2 candidates each, 8 choices | about 67 KiB | 9.28 MiB | yes |
| Extreme: every report just under Core's 65,536-byte compact response cap (`REVIEW_MAX_JSON_BYTES`), 8 candidates with 8 sources per finding, 32 choices with 8 offered each | about 168 KiB | 21.90 MiB | no: the save fails with `workfile_too_large` |

A canonical record is about 1.9 times its compact report, because of indentation at
depth 3 to 9.

1 MiB cannot even hold the dense model's records for 16 segments. 8 MiB fails the
dense model. 16 MiB fits the dense model with about 72% headroom, and stays small enough
for a browser and the desktop client to parse and validate in one pass. Both clients
raise the cap together.

## Reading

A reader decides by these steps, in order. The first failure gives the code. Both
parsers must report the same code for the same bytes.

1. If the file's bytes are not valid UTF-8, the code is `workfile_not_json`. If they
   exceed 16 MiB, the code is `workfile_too_large`. What a parser function does with an
   argument that is not a string is a local API detail, outside this contract.
2. If the content parses as JSON, the top level is an object and its `format` is
   `"wuwaterm-manuscript-v3"`, continue with step 3. Otherwise apply the v2 reader
   unchanged, starting with its 1 MiB check. Every non-v3 input therefore gets the v2
   reader's result and code. A non-JSON input over 1 MiB is `workfile_too_large`, as
   before.
3. Tree caps, the same as v2 and checked in the same way: an array over 128 items gives
   `workfile_too_many_entries`, an object over 32 fields gives
   `workfile_too_many_fields`, depth over 16 gives `workfile_too_deep`, and a
   `__proto__`, `constructor` or `prototype` key gives `workfile_forbidden_field`.
4. If the top-level keys are not exactly the 13 v3 keys, the code is
   `workfile_unsupported_format`.
5. The v1 and v2 parts, with exactly the v2 checks and codes (`workfile_invalid_content`,
   `workfile_duplicate_choices`). The only exception is the text limits that v2 ties to
   the file size: `source`, `target`, `semantic_texts[].text` and the `semantic_history`
   texts may have up to 16,777,216 scalars.
6. The structure of each record, in array order:
   - `segments` is an array, and each record has the exact keys.
   - Each field has a valid type and value, and the ranges lie within the texts.
     `index` only has to be an integer here; its value is checked in step 7.
   - `basis` and `report` are null exactly when the status is `pending`.
   - Every basis is valid.
   - `choices` has at most 32 entries (`workfile_too_many_entries`).
   - Each choice's structure is valid, including `offered`: at most 8 entries
     (`workfile_too_many_entries`), and ascending, distinct and containing the
     `official_pair` candidate id (`workfile_segment_invalid`).

   Any other failure here is `workfile_segment_invalid`.
7. Order across records: if an `index` differs from the record's position, or ranges
   overlap or go backwards, the code is `workfile_segment_order`.
8. The content of each record, in array order:
   1. Done and stale only: the cores have 1 to 2,000 scalars, and the report is valid
      for them with `rule_version` `review-v2` and a `matcher_revision`. Otherwise
      `workfile_segment_invalid`.
   2. Done and stale only: the report's `source_revision` and `target_revision` equal
      the record's hashes. Otherwise `workfile_segment_hash_mismatch`.
   3. Done and stale only: the report's basis is the same as the record's `basis`.
      Otherwise `workfile_segment_basis_mismatch`.
   4. Each choice's span lies inside the source core and reads the same there. In a done
      or stale record, each confirmed choice also matches its finding as described
      above. Otherwise `workfile_segment_anchor_invalid`.
   5. If two choices share `start` and `end`, the code is `workfile_duplicate_choices`.
9. `segment_choice_history`: an array whose entries have valid structure, checked like
   a segment choice in step 6. `offered` over 8 is `workfile_too_many_entries`; any
   other failure is `workfile_segment_invalid`. The entry count is already bounded by
   step 3.
10. `progress`: exact keys, `current` is null or the index of an existing record,
    `completed` is strictly ascending, and every entry is the index of a done record.
    Otherwise `workfile_progress_invalid`.

Integer fields accept any JSON number whose value is a safe integer, so `3.0` reads as
`3`. JavaScript cannot tell the two apart after parsing, so Python must accept and
normalize them as well. The canonical form writes plain integers. Python's existing
strict-integer check on v2 decision fields is unchanged in v3 and is a known difference
(listed as an open item).

**Parsing checks structure, ranges and the report against the current cores, but it
does not compute hashes.** Web `parseWorkfile` is synchronous and SHA-256 in the browser
is not, so the v2 precedent applies: hashes are verified before use. A record whose
stored hash differs from its current core is a valid file. Its result is simply not
current at runtime (see the fixture `valid-v3-hash-not-current.json`).

## Writing

**Which format.** A writer emits the lowest format that holds the payload:

1. If `segments` and `segment_choice_history` are empty and the v2 writer's output (v1
   without semantic data, otherwise v2, with v2's oldest-first `semantic_history`
   trimming) fits 1 MiB, the writer emits exactly those v1 or v2 bytes. Old clients keep
   opening these files.
2. Otherwise it writes v3. In v3 the oldest `semantic_history` snapshots are dropped
   only while the file exceeds 16 MiB. Records, choices, history choices and semantic
   decisions are never dropped. If the file is still too large, the save fails with
   `workfile_too_large`.

So a reopened v3 file without segment state is written back as v2 or v1 (fixture
`valid-v3-from-v2.json`).

**Records.** At save time, the writer stores one record per segment of the current
segmentation-v1 pairing (with the current `alignments`), in order:

- If the content of a done or stale record changed since its report, the record becomes
  pending: its hashes are recomputed, and its report and basis are dropped.
- If the direction changes, every record becomes pending.
- If the manuscript has more than 128 segments, the save fails with
  `workfile_too_many_entries` and the client says why. Saving without segment records
  is allowed only as the user's explicit choice.

**Choices.** A choice stays in the record whose source core holds its occurrence. The
writer relocates it through edits so that its span still reads the same in that core.
Any mapping that preserves the text is acceptable, for example Web's
`diffSplice`/`mapSpan`; across a whole-text replacement the reference rule is v1's
`recoverSpan` (identical, unique, complete line block). A choice that cannot be placed
moves to `segment_choice_history` with the hash of the source core it was last in. If
that history would exceed 128 entries, the save fails with `workfile_too_many_entries`,
and the user removes history entries; nothing is dropped silently. Adding, changing or
confirming a choice in a done record makes the record stale.

**Progress.** `current` is the user's segment. The writer removes an index from
`completed` once its record is no longer done.

**Canonical bytes.** The writer outputs `JSON.stringify(value, null, 2)` in JavaScript,
which is byte-identical to Python
`json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)`: two-space indent,
`": "` after keys, non-ASCII written as is, and no trailing newline. Keys are in the
orders given in this document. The v1 and v2 parts are written exactly as the v2 writer
writes them. A stored report uses this order:

- `request_id`, `source_revision`, `target_revision`, `rule_version`,
  `matcher_revision`, `dictionary`, `coverage`, `findings`, `truncated`
- `dictionary`: `schema_version`, `source_commit`, `term_count`, `revision`
- `coverage`: `evaluated`, `not_evaluated`, `rules`
- finding: `id`, `rule_id`, `verdict`, `source_span`, `target_span`, `candidates`,
  `candidates_truncated`
- span: `start`, `end`, `text`
- candidate: `zh`, `en`, `category`, `sources`, `candidate_id`
- source: `source_file`, `source_id`

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
     `source_hash`. It keeps that record's choices; the result is not reused.
   - Every other segment is pending.
   - Choices of records left unused move to `segment_choice_history`.
   - `progress` follows the mapping.
3. **Content check, before any use.** The reader computes the hashes of the current
   cores. A result is a reuse candidate only if the record is done and both hashes are
   equal.
4. **Live basis.** The client sends one review-v2 term check with
   `X-WuwaTerm-Matcher-Basis: 1`. It goes for the segment at `progress.current` if that
   segment needs a check, otherwise for the first segment that needs one, otherwise for
   the segment at `progress.current` (or index 0). It costs one review admission, like
   any segment check. Its response basis is the current basis. If the response has no
   `matcher_revision`, or a null `schema_version` or `source_commit`, there is no
   current basis, and no saved result is reused in this session.
5. **Current or stale.** A reuse candidate whose basis is the same as the current basis
   is current. It is not checked again, and its confirmed choices take effect without
   confirmation. Every other record with a result is stale and is checked again. When
   any later response carries a different basis, that basis becomes current and every
   record is evaluated again by this step.
6. **Re-check.** A segment is checked in one request or two:
   - If its source hash and basis are unchanged from the record (only the target
     changed, or its choices changed), the request sends the confirmed choices as
     resolutions. The `resolution_context` is
     `{source_revision: source core hash, rule_version, dictionary_revision, matcher_revision}`
     from the current basis.
   - Otherwise the first request carries no resolutions. The choices are realigned
     against its findings (step 7). If any choice was kept, the segment is checked once
     more with them.
7. **Realignment** by occurrence and candidate, against the new report:
   - An `official_pair` is kept if a finding with the same mention id still offers a
     candidate with the same `candidate_id`, `zh`, `en` and `category`.
   - A `not_a_term` is kept if a finding with the same mention id still exists, its
     `candidates_truncated` is false, and its candidate ids equal `offered`.
   - A kept choice gets the current basis and the finding's current candidate ids as
     `offered`.
   - Any other choice keeps its old basis and needs reconfirmation. It is shown and
     never dropped automatically. The user confirms it again, which gives it the current
     basis, or removes it.
8. **History choices** are never applied. If a current segment's source hash equals an
   entry's `source_hash`, the client may offer to restore that entry as a choice
   needing reconfirmation.
9. **Failures.** A failed or cancelled check changes only that segment. Results of
   other segments, choices and `progress` are kept, and the run can continue from the
   failed segment.

## Compatibility

- **New clients** read v1, v2 and v3, and write by the format rule above.
- **Old clients** (Web 0.2.0, Windows 0.4.2, and anything earlier) open no v3 file:
  - A v3 file of at most 1 MiB that keeps the generic tree caps (every valid v3 file
    does) passes their tree checks. They reject it with `workfile_unsupported_format`.
  - A v3 file over 1 MiB fails their first check with `workfile_too_large`
    ("稿件文件不能超过 1 MiB").

  Both are explicit errors. The old client keeps its current manuscript and does not
  read any of the file. `cases.json` records the expected old-client code for every
  case as `legacy_error`. Web's test asserts each one against today's
  `lib/manuscript.js`, which is the Web 0.2.0 parser (tag `v0.2.0` is this repository's
  base commit). Real long manuscripts with segment state will often exceed 1 MiB, so old
  clients will report "too large" for them, not "unsupported format".
- **v2 contract.** Every input that is not a v3 object is read exactly as before. Every
  case in `contracts/manuscript-v2/cases.json` keeps its code under a v3 reader. Web's
  test asserts this.
- **Core API.** No change is needed:
  - A segment check is an ordinary review-v2 request of at most 2,000 scalars per side.
  - Segment choices go out as review-v2 `resolutions`, with `resolution_context`
    `{source_revision, rule_version, dictionary_revision, matcher_revision}`. Core
    accepts these today, and the Web BFF forwards up to 32 resolutions with that
    four-key context.
  - Windows `ApiClient.review_pair` does not send resolutions yet. Adding them is a
    Windows client change in M2.

## Error codes

Both parsers use these codes. Messages are the canonical Chinese data form; UIs
localize by code.

| Code | Case | Message |
|---|---|---|
| `workfile_not_json` | not text, or not JSON | 无法读取 JSON 稿件文件。 |
| `workfile_too_large` | over 16 MiB, or a non-v3 input over 1 MiB | 稿件文件超过大小上限（v1/v2 为 1 MiB，v3 为 16 MiB）。 |
| `workfile_too_deep` | depth over 16 | 稿件文件嵌套过深。 |
| `workfile_too_many_entries` | an array over 128 items, or a v3 count over its limit | 稿件文件条目过多。 |
| `workfile_too_many_fields` | an object over 32 fields | 稿件文件字段过多。 |
| `workfile_forbidden_field` | `__proto__`, `constructor` or `prototype` key | 稿件文件含不支持的字段。 |
| `workfile_unsupported_format` | unknown `format`, or wrong top-level keys | 不支持此稿件格式或版本。请导入“保存稿件”生成的文件。 |
| `workfile_invalid_content` | a v1/v2 part is invalid | 稿件内容、选择或位置依据无效；当前稿件未被替换。 |
| `workfile_duplicate_choices` | two choices for one occurrence, in a v1/v2 part or in one record | 稿件包含同一位置的重复选择，未导入。 |
| `workfile_segment_invalid` | malformed record, segment choice, history choice or basis: unknown status, unknown segmentation version, bad hex, range outside the text, status, basis and report that do not agree, or a report that is not valid for its cores | 稿件的分段记录无效；当前稿件未被替换。 |
| `workfile_segment_order` | an index that is not its position (duplicate or out of order), or overlapping or backward ranges | 稿件的分段顺序或位置无效；当前稿件未被替换。 |
| `workfile_segment_hash_mismatch` | a report's revisions differ from its record's hashes | 稿件的分段内容摘要与其结果不符；当前稿件未被替换。 |
| `workfile_segment_basis_mismatch` | a record's basis differs from its report's | 稿件的分段判定依据与其结果不符；当前稿件未被替换。 |
| `workfile_segment_anchor_invalid` | a choice outside its core, not reading the same, or a confirmed choice without its finding or candidate | 稿件的逐段术语选择位置无效；当前稿件未被替换。 |
| `workfile_progress_invalid` | `progress` malformed, or pointing at a missing or not-done record | 稿件的进度记录无效；当前稿件未被替换。 |

Web 0.2.0 and Windows 0.4.2 say "稿件文件不能超过 1 MiB。" for `workfile_too_large`. New
clients use the message above.

## Fixtures

`cases.json` lists every fixture. Each case has `file`, an optional `pad_to_bytes`, a
`note` and `legacy_error`. Valid cases also have `canonical`; invalid cases have
`error`.

- `pad_to_bytes`: read `file` and append ASCII spaces (U+0020) until its UTF-8 length
  equals this number. The padding is JSON whitespace, so the parsed value is unchanged.
  This keeps the 1 MiB and 16 MiB boundary cases out of the working tree.
- `canonical` (valid cases): the file whose exact bytes a conforming writer produces
  from the parsed value.
- `error` (invalid cases): the code a v3 reader must report.
- `legacy_error`: what Web 0.2.0 and Windows 0.4.2 report (`null` = accepted).

All text is synthetic. Hashes, revisions and candidate ids are computed by the
generator and never typed. The 128-segment fixtures use short paragraphs whose ranges
are not a segmentation-v1 result; parsers do not run segmentation. The other v3
fixtures use ranges that `pairSegments` produces for their text.
