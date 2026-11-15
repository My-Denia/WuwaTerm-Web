# Manuscript format v3 (`wuwaterm-manuscript-v3`)

Status: contract for WuwaTerm-Web and WuwaTerm-Windows. Both parsers and both writers
implement this file. `cases.json` in this directory is the shared fixture index.
Regenerate the fixtures with `node scripts/build-manuscript-v3-fixtures.mjs --write`;
without `--write`, the script only checks that the committed bytes are current.

v3 makes long-manuscript term review resumable. For each segment, it saves a compact
term result, the inputs and basis that the result was computed under, and the user's
term choices in that segment. It also saves the user's position. v1 and v2 stay
readable and keep their meaning ([`docs/manuscript-v2.md`](../../docs/manuscript-v2.md)).

## Design note: what changes in the import rule, and why

**The rule being changed.** Core ADR 0015 decided that imported reports are history:
"报告历史与当前可信状态分开，避免把导入的旧结果当作新检查". An imported file's report may
have been computed on other text, other inputs, an older dictionary or older matching
rules. Treating it as a fresh check would show the user a verdict that the current
service never made. The same rule keeps imported choices pending until a fresh review
(`reconcileChoice` code `awaiting_fresh_basis`; an imported `not_a_term` always returns
to pending as `imported_not_a_term`).

**Why v3 changes it.** The 2026-11-15 phase brief asks for three things: a user who
handled part of a long manuscript can save, close, reopen and continue; edited content
is checked again; and completed parts are not reviewed again ("不用反复审校已经完成的部分").
Under the old rule, every reopen re-checks every segment. That costs one review
admission per segment, and every choice in the file has to be confirmed again.

**What now prevents a stale result from passing as a new check.** A saved segment
result counts as current only when all four of these hold:

1. **Content.** The SHA-256 of the segment's current source core and of its target
   core equal the hashes stored with the result. Those hashes are the
   `source_revision` and `target_revision` that Core returned for exactly the text it
   checked. Any edit inside a core changes its hash, whether a client or a person made
   it. An edit outside every core, such as whitespace between segments, changes no hash
   and does not change what Core checks.
2. **Request inputs.** The record stores the direction and the alignment input of the
   request that produced the result (see "Segment request"). Both must equal what that
   request would send now. Core's verdicts depend on them: review-v2 maps sentences
   only when `alignments` is omitted.
3. **Basis.** After opening, the client makes one live review-v2 request with
   `X-WuwaTerm-Matcher-Basis: 1`. Its response gives the current basis: `rule_version`,
   the dictionary's `schema_version`, `revision`, `source_commit` and `term_count`, and
   `matcher_revision`. The stored basis must equal it in all six values. `/v1/meta`
   cannot supply this basis, because it returns no dictionary revision, matcher revision
   or rule version.
4. **Status.** The writer stored the record as `done`. A record that the writer already
   knew needed a re-check is stored as `stale` and is never reused.

Core still checks every choice that the client sends. A choice goes out as a review-v2
resolution whose `resolution_context` carries the current basis, and Core rejects a
stale context. The limits of this guarantee are listed under "Known limits".

**Scope of the change.** Only v3 segment records are reused, and segment records exist
only in long mode, where either side exceeds 2,000 scalars. Document mode keeps the old
rule unchanged. That covers the v1 `choices` and `history`, and the v2 semantic
decisions and semantic history. For a v3 record that is current, its confirmed choices
take effect without being confirmed again, `not_a_term` included. This deliberately
replaces `imported_not_a_term` for such records.

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
  - `docs/products.md`: around line 27, "两端稿件文件格式为 `wuwaterm-manuscript-v1`".
  - `contracts/products.json`: `contracts.manuscript` lists only
    `wuwaterm-manuscript-v1`, and its note says that interchange "does not certify
    historical reports against the current dictionary". The format mentions in the
    shipped-release records (around lines 249 and 396) describe past releases and stay
    as they are.
- Web:
  - `lib/manuscript.js`: the header comment says "never reusable certification".
  - `docs/sites.md`: the section "Resumable bilingual manuscripts"; the paragraph that
    starts "Per-segment term results of a long manuscript are not written to the
    manuscript file"; and the download list around line 289 ("the manuscript JSON
    (`wuwaterm-manuscript-v1`)").
  - `docs/manuscript-v2.md`.
  - `docs/cross-repository-delivery.md`: "a manuscript import is not fresh
    certification", and the format list.
  - `lib/semantic-messages.ts`: `runTermHint` and `segmentTermsNotSaved`.
  - `lib/messages.ts`: `segmentTermsNote`.
- Windows:
  - the module docstring of `src/wuwaterm_client/manuscript.py`;
  - `README.md`: around lines 16 and 17 (the manuscript formats), and the manuscript
    section around lines 181 to 185.

## Terms

- **Scalar**: a Unicode scalar value. All offsets count scalars, as in v1 and v2. In
  Python they are `str` indexes; in JavaScript, `Array.from(text)` indexes.
- **Segment core**: segmentation-v1 (Core `contracts/segmentation-v1.json`; Web
  `lib/segmentation.js`, `pairSegments`) splits the whole `source` and `target` into
  pairs. Each side's core is its region without leading and trailing segmentation-v1
  whitespace: `core_start..core_end`. A client sends exactly the core to Core for that
  segment's term check.
- **Long mode**: either side of the manuscript has more than 2,000 scalars, and term
  checks run per segment. Document mode, where both sides have at most 2,000 scalars,
  uses the v1 `choices` and `history` unchanged.
- **Content hash**: the lowercase hexadecimal SHA-256 of the UTF-8 encoding of a core.
  There is no normalization: no NFC or NFKC, no line-ending conversion, and no trimming
  beyond the core boundaries. The content hash equals Core `text_revision(core)`, the
  review-v2 `source_revision` or `target_revision` for a request that sent this core,
  and Web `revisionOf(core)`. The hash of an empty core is
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- **Basis**:
  `{rule_version, dictionary: {schema_version, source_commit, term_count, revision}, matcher_revision}`.
  Two bases are the **same** when all six values are equal. A v3 basis must have:
  - `rule_version` `review-v2`;
  - a non-empty `schema_version` and `source_commit`, each at most 4,096 scalars;
  - a safe-integer `term_count` of 0 or more;
  - a 64-hex `revision` and `matcher_revision`.

  No value may be null or missing, so a basis fails closed. A response with a null
  `schema_version` or `source_commit`, or without `matcher_revision`, cannot be stored
  as a result and cannot serve as the current basis.

## Segment request

Both clients send exactly this term check for a segment. Web today omits `alignments`
in segment checks; it adopts this rule in M1.

- `source` and `target` are the two cores, `direction` is the manuscript's
  `direction`, and `review_version` is `review-v2`. The request carries the header
  `X-WuwaTerm-Matcher-Basis: 1`.
- **Alignment input.** If the manuscript's `alignments` is `null`, the request omits
  `alignments`, and Core maps sentences automatically. The record's `alignment_input`
  is then `"automatic"`.

  Otherwise, the request sends a list built from the manuscript's alignments, in their
  order. Windows `_alignments_for` already builds it this way:
  1. Intersect the alignment's source span with the source core: `start =
     max(span.start, core_start)` and `end = min(span.end, core_end)`. If `start >=
     end`, leave the alignment out.
  2. If the alignment's target is not null, intersect it with the target core the same
     way. If that intersection is empty, leave the alignment out.
  3. Otherwise, emit `{source: {start, end, text}, target: null | {start, end, text}}`,
     with offsets relative to the core and `text` taken as the core slice.

  The list can be `[]`, and `[]` is a real input that differs from omitting
  `alignments`. The record's `alignment_input` is then the lowercase hexadecimal
  SHA-256 of the UTF-8 bytes of the list's minified JSON. That is
  `JSON.stringify(list)` in JavaScript, and
  `json.dumps(list, ensure_ascii=False, separators=(",", ":"))` in Python. Keys are in
  the order `source`, `target`, and then `start`, `end`, `text`. The digest of `[]` is
  `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`.
- `resolutions` and `resolution_context` follow "Runtime", step 6.

## File layout

The top level has exactly these 13 keys, in this order:

| Key | Content |
|---|---|
| `format` | `"wuwaterm-manuscript-v3"` |
| `source`, `target`, `direction`, `alignments`, `choices`, `history` | as in v1 |
| `semantic_decisions`, `semantic_texts`, `semantic_history` | as in v2 |
| `segments` | segment records, at most 512; empty in document mode |
| `segment_choice_history` | history choices, at most 512 |
| `progress` | the progress object |

The v1 and v2 parts keep their v2 validation and error codes. Their limits are in the
table under "Limits"; only the text and file size limits change.

### Segment record

Exact keys, in this order:

| Key | Rule |
|---|---|
| `index` | integer, equal to the record's position in `segments` (0-based) |
| `segmentation_version` | `"segmentation-v1"` |
| `source_start`, `source_end` | integers: the source core range in the saved `source`, with `0 <= start <= end <= scalar length` |
| `target_start`, `target_end` | the same for the target core in the saved `target` |
| `source_hash`, `target_hash` | content hashes of the cores (64 lowercase hex) |
| `status` | `"pending"`, `"done"` or `"stale"` |
| `direction` | `null` when pending; otherwise `"en"` or `"zh"`, the request's direction |
| `alignment_input` | `null` when pending; otherwise `"automatic"` or a 64-hex digest (see "Segment request") |
| `basis` | `null` when pending; otherwise a v3 basis |
| `result` | `null` when pending; otherwise a compact term result for the two cores |
| `choices` | segment choices, at most 32 |

- **pending**: there is no result for this content. `direction`, `alignment_input`,
  `basis` and `result` are null. A record is pending in any of these cases:
  - it was never checked;
  - its check failed;
  - the segment is not ready (for example `needs_manual_split`);
  - its content changed since the last result, which was dropped.

  The record may still hold choices; they wait for the next check.
- **done**: `result` is Core's review-v2 response for exactly these cores and inputs,
  compacted as described below. The request that produced it carried exactly the
  record's confirmed choices as resolutions ("Runtime", step 6). `basis` is that
  response's basis.
- **stale**: like done, but the writer knew that the record needs a re-check, because
  of one of these:
  - a later response in the session had a different basis;
  - the request inputs changed;
  - the confirmed choices changed after the result.

  A reader never reuses a stale result.

For done and stale records, both cores must have 1 to 2,000 scalars, Core's request
limit.

In long mode, records cover every segment of the writer's segmentation, in order.
Consecutive records do not overlap: each `source_start` is at least the previous
`source_end`, and likewise for the target.

### Compact term result

A done or stale record stores only what the review UIs render and what reconciling
choices needs. The result has exact keys, in this order:

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
| `candidates` | at most 8 objects `{candidate_id, zh, en, category}`. Ids are distinct and 64-hex. `zh` and `en` are non-empty, at most 2,000 scalars. `category` is non-empty, at most 256 |
| `candidates_truncated` | boolean |

No two findings may have the same `source`.

**What is dropped from the review-v2 response, and why.**

| Field | Why it is not stored |
|---|---|
| `source_revision`, `target_revision` | Equal to the record's `source_hash` and `target_hash` |
| `rule_version`, `matcher_revision`, `dictionary` | Equal to the record's `basis` |
| `request_id` | Not stored. A reused result has no request id; the Windows request-id label shows its placeholder for it |
| `coverage.rules` | Always `["review.term_pair", "review.sentence_meaning"]` in review-v2 |
| finding `id` | Equal to the mention id of the source span, `` `${start}:${end}:${text}` `` |
| finding `rule_id` | Always `review.term_pair` in review-v2. A response with another rule id is not stored, and the writer writes the record as pending |
| span `text` | The core slice at the span |
| candidate `sources` | Only the Web document-mode report shows them, and document mode keeps full reports in v1 `history`. Long mode shows none: neither the Web `semantic-workbench.tsx` term rows nor Windows `_show_segment_term_report` render them |

The kept fields have these uses:

- Both long-mode UIs render `verdict`, the spans, and the candidates' `zh` and `en`.
- `candidate_id`, `zh`, `en` and `category` together are the candidate identity that
  reconciliation checks.
- The Windows status line (`manuscript_view.py`, around lines 1840-1841) shows
  `truncated`, `candidates_truncated` and the coverage counts.

A client that renders through its existing report code rebuilds the dropped fields from
the record. The Web current-result JSON export (`segment_term_reports`, in
`semantic-workbench.tsx` `semanticExport`) writes the same rebuilt report for a reused
segment:

- `request_id` is null, and every candidate has `sources: []`;
- the revisions come from the hashes;
- `rule_version`, `matcher_revision` and `dictionary` come from the basis;
- `coverage.rules` is the review-v2 constant;
- finding ids, `rule_id` and span texts are derived as listed above.

Nothing else is invented.

The compact result keeps a strict subset of the response's fields, so its minified size
is never larger than Core's response. Core caps that response at 65,536 bytes
(`REVIEW_MAX_JSON_BYTES`).

### Segment choice

A segment choice is a user's term decision at one occurrence in a segment. Exact keys,
in this order:

| Key | Rule |
|---|---|
| `source_span` | `{start, end, text}`, relative to the record's source core. `end > start`. `text` is non-empty and at most 2,000 scalars, and `end - start` equals its scalar length |
| `choice` | `"official_pair"` or `"not_a_term"` |
| `candidate` | for `official_pair`, `{candidate_id, zh, en, category}`, with the field rules of a result candidate; for `not_a_term`, `null` |
| `offered` | for `not_a_term`, the candidate ids the occurrence showed when the user decided: distinct 64-hex strings, ascending, at most 8; for `official_pair`, `[]` |
| `confirmed` | boolean: the user made or confirmed the choice against the record's current result. Always `false` in a pending record |

The occurrence's mention id is `` `${start}:${end}:${text}` ``, the same as a review-v2
finding `id`. A choice therefore maps one to one onto a review-v2 resolution,
`{mention_id, choice, candidate_id}`.

- The span must lie inside the record's source core and read the same there.
- In a done or stale record, every confirmed choice must match a finding of the result
  with the same source span:
  - for an `official_pair`, that finding must have a candidate with the same
    `candidate_id`, `zh`, `en` and `category`;
  - for a `not_a_term`, its candidate ids must equal `offered` as a set, whatever its
    `candidates_truncated` is.
- Two choices in one record may not have the same `start` and `end`.
- In a done or stale record, a choice that is not confirmed **needs reconfirmation**. It
  is shown with its surface text and candidate. It is never sent to Core and never
  applied.
- In a pending record, no choice is confirmed. Its choices wait for the next check and
  are realigned against it ("Runtime", step 7).

### Segment choice history

The history holds choices whose occurrence no longer has a segment: the user edited the
occurrence itself, deleted its segment, or left long mode. They are kept so that the
user's decision is not lost silently. They are never applied and never sent to Core.

Each entry has exact keys, in this order: `source_hash`, `source_span`, `choice`,
`candidate`, `offered`. `source_hash` is 64 hex: the content hash of the source core
the choice was last placed in. The other fields follow the segment choice rules, but the
span is not checked against any text. The array is ordered oldest first.

### Progress

`{current, completed}`, exact keys in this order.

- `current`: `null`, or the `index` of an existing record. It is the segment the user
  was working on.
- `completed`: the indexes that the user marked as finished, strictly ascending. Each
  must be a record whose status is `done` or `stale`. A finished segment whose result is
  stale shows as "finished, re-check pending". A change of basis never removes a
  finished mark. An index leaves `completed` only in these cases:
  - the user unmarks it;
  - its content changes, so the record becomes pending;
  - its segment is deleted.

## Limits

| Limit | v1 / v2 | v3 | Reason |
|---|---|---|---|
| File size (UTF-8 bytes) | 1 MiB (1,048,576) | 44 MiB (46,137,344) | See "Size arithmetic" |
| `source`, `target` | 1,048,576 scalars | 46,137,344 scalars | Bounded by the file size |
| Array items, any array | 128 | 512 | v3 needs more segments. Old clients reject a v3 file with an array over 128 items as `workfile_too_many_entries` |
| Object fields, any object | 32 | 32 | Unchanged. The largest v3 object is the segment record, with 14 fields |
| Nesting depth | 16 | 16 | Unchanged. The deepest value in a v3 part is at depth 8; v1 and v2 parts reach depth 10 |
| `segments` | none | 512 | See "Capacity" |
| findings per result | none | 32 | Core returns at most 32 findings |
| candidates per finding | none | 8 | Core returns at most 8 candidates |
| `choices` per record | none | 32 | One choice per occurrence, and Core returns at most 32 |
| `offered` per choice | none | 8 | Core returns at most 8 candidates |
| `segment_choice_history` | none | 512 | Replacing a whole source can displace many choices at once |
| `progress.completed` | none | 512 | At most one per record |
| `choices` (document mode) | 32 | 32 | Document mode is unchanged; one check of at most 2,000 scalars returns at most 32 findings |
| `history` (document reports) | 2 | 2 | As above |
| `alignments` | 64 | 64 | Core accepts at most 64 per request |
| `semantic_decisions` | 128 | 128 | Semantic review stays experimental and off by default. Raising this is a follow-up if semantic review is enabled for long manuscripts |
| `semantic_texts` | 16 | 16 | Each entry is a whole old text, bounded by the file size |
| `semantic_history` | 2 | 2 | Reference data |
| Segments per `semantic_history` snapshot | 64 | 64 | Reference data. The writer stores the segments that still match, so a run over more segments keeps 64 |

Over any limit, the parser rejects the file with the code given below, and the writer
fails the save with that code. Nothing is truncated silently. The only exceptions are
the two reference-data cases that v2 already defines:

- the writer keeps the last 2 document reports;
- the writer drops the oldest `semantic_history` snapshots first while the file is over
  its size cap.

A failed save leaves the existing file and the open work untouched. Its message says how
to continue: split the manuscript into parts, or remove entries from the choice history,
which the client lists for removal.

### Capacity

segmentation-v1 caps each core at 1,800 scalars on both sides, so the longer side sets
the segment count. Adjacent ready pairs merge while both sides still fit. As a result,
every two consecutive segments hold more than 1,800 scalars on the longer side, and a
segment averages more than 900. For 512 segments, that gives these source
capacities for text without hard cuts or manual-split pairs (a hard-cut piece or a
non-ready pair never merges, so such text can hold less):

| Direction and target length | Source capacity |
|---|---|
| zh→en, 3x the source | 512 x 900 / 3 = 153,600 scalars |
| zh→en, 2x the source | 230,400 scalars |
| en→zh (the source is the longer side) | 460,800 scalars |

A 100,000-scalar Chinese source with a target three times as long needs at most 334
segments. The paragraph model below needs 219. 512 covers the bound with 53% margin.

### Size arithmetic

All sizes are canonical bytes, which are minified (see "Canonical bytes"). The test
`tests/manuscript-v3.test.mjs` builds these models in memory with `budgetManuscript`
from the fixture generator, prints their sizes and asserts the cap margin.

In the manuscript models, the source paragraphs have 20 to 400 scalars, drawn by a
fixed pseudo-random sequence, and each target paragraph is the source length times the
ratio. The zh side is CJK (3 bytes per scalar) and the en side is ASCII. Segments come
from `pairSegments`. Each done record has:

- one finding per 104 source scalars, at most 32, with every fourth finding having 2
  candidates;
- one choice per four findings, half of them `not_a_term` with full `offered`;
- a full basis.

| Direction | Target length | Source scalars | Segments | File |
|---|---|---|---|---|
| zh→en | 2x | 20,000 | 27 | 0.19 MiB |
| zh→en | 2x | 100,000 | 133 | 0.93 MiB |
| zh→en | 3x | 20,000 | 44 | 0.22 MiB |
| zh→en | 3x | 100,000 | 219 | 1.09 MiB |
| en→zh | 1/2 | 20,000 | 12 | 0.13 MiB |
| en→zh | 1/2 | 100,000 | 61 | 0.63 MiB |
| en→zh | 1/3 | 20,000 | 12 | 0.12 MiB |
| en→zh | 1/3 | 100,000 | 61 | 0.59 MiB |

The cap models fill all 512 segments with 1,800-scalar cores: CJK source, ASCII target.

| Model | Per result | Choices | File |
|---|---|---|---|
| Dense | Core's 32-finding cap, 2 candidates each | 8 | 11.62 MiB |
| Limit | 32 findings x 8 candidates | 32, 8 offered | 32.81 MiB |
| Extreme | 32 x 8, candidate strings lengthened until each minified result is just under Core's 65,536-byte response cap | 32, 8 offered | 43.96 MiB |

**Cap arithmetic.** The limit model reaches every count cap at 32.81 MiB. With a 25%
margin that is 41.01 MiB, and rounding up to the next 4 MiB gives the 44 MiB cap. That
is above the earlier 12 MiB because the segment cap went from 128 to 512, and the
arithmetic requires it.

The extreme model is bounded by Core itself, because no result can be larger than
Core's response, and it fits with 0.04 MiB to spare. A save exceeds 44 MiB only through
text far beyond these models, such as very long whitespace between segments or many
4-byte scalars, or through semantic data. Such a save fails explicitly.

Real manuscripts are far smaller. A 100,000-scalar Chinese source with an English
target three times as long is about 1.1 MiB.

## Reading

A reader decides by these steps, in order. The first failure gives the code. Both
parsers must report the same code for the same bytes.

1. If the file's bytes are not valid UTF-8, the code is `workfile_not_json`. If they
   exceed 44 MiB, the code is `workfile_too_large`. How a parser function treats an
   argument that is not a string is a local API detail, outside this contract.
2. If the content parses as JSON, its top level is an object, and its `format` is
   `"wuwaterm-manuscript-v3"`, continue with step 3. Otherwise, apply the v2 reader
   unchanged, starting with its 1 MiB check. Every non-v3 input therefore gets the v2
   reader's result and code. A non-JSON input over 1 MiB is `workfile_too_large`, as
   before.
3. Apply the v3 tree caps, checked in the same way as v2:
   - an array over 512 items: `workfile_too_many_entries`;
   - an object over 32 fields: `workfile_too_many_fields`;
   - depth over 16: `workfile_too_deep`;
   - a `__proto__`, `constructor` or `prototype` key: `workfile_forbidden_field`.
4. If the top-level keys are not exactly the 13 v3 keys, the code is
   `workfile_unsupported_format`.
5. Check the v1 and v2 parts with exactly the v2 checks and codes
   (`workfile_invalid_content`, `workfile_duplicate_choices`), including v2's own counts
   such as 32 `choices` and 128 `semantic_decisions`. The only exception is the text
   limits that v2 ties to the file size: `source`, `target`, `semantic_texts[].text`
   and the `semantic_history` texts may have up to 46,137,344 scalars.
6. Check the structure of each record, in array order:
   - `segments` is an array of at most 512 records, and each record has the exact keys.
   - Each field has a valid type and value, and the ranges lie within the texts.
     `index` only has to be an integer here; its value is checked in step 7.
   - `direction`, `alignment_input`, `basis` and `result` are null exactly when the
     status is `pending`.
   - Every basis is valid.
   - The result has its exact keys and value types. Each finding has its exact keys, a
     known verdict, and `[start, end]` pairs with `0 <= start < end`. Each candidate has
     its exact keys and valid values, and the candidate ids within a finding are
     distinct.
   - Each choice has a valid structure, including the `offered` rules, and `confirmed`
     is false in a pending record.

   A count over its cap gives `workfile_too_many_entries`. The caps are segments 512,
   findings 32, candidates 8, choices 32 and `offered` 8. Any other failure in this step
   gives `workfile_segment_invalid`.
7. Check the order across records. If an `index` differs from the record's position, or
   if ranges overlap or go backwards, the code is `workfile_segment_order`.
8. Check the content of each record, in array order:
   1. Done and stale records only: the cores must have 1 to 2,000 scalars. Each
      finding's `source` must lie within the source core, and its `target`, when
      present, within the target core. No two findings may share a `source`. Otherwise
      the code is `workfile_segment_invalid`.
   2. Each choice's span must lie inside the source core and read the same there. In a
      done or stale record, each confirmed choice must also match its finding as
      described above. Otherwise the code is `workfile_segment_anchor_invalid`.
   3. If two choices share `start` and `end`, the code is `workfile_duplicate_choices`.
9. Check `segment_choice_history`: an array of at most 512 entries, each checked like a
   segment choice in step 6 but without `confirmed`. An `offered` over 8 gives
   `workfile_too_many_entries`; any other failure gives `workfile_segment_invalid`.
10. Check `progress`: it must have exact keys, `current` must be null or the index of an
    existing record, and `completed` must be strictly ascending, with every entry the
    index of a done or stale record. Otherwise the code is `workfile_progress_invalid`.

Integer fields accept any JSON number whose value is a safe integer, so `3.0` reads as
`3`. JavaScript cannot tell the two apart after parsing, so Python must accept and
normalize them as well. The canonical form writes plain integers. Python's existing
strict-integer check on v2 decision fields is unchanged in v3; it is a known
difference.

**Parsing checks structure, ranges, and the result and choices against the current
cores. It computes no hashes or digests.** Web `parseWorkfile` is synchronous, and
SHA-256 in the browser is not, so the v2 precedent applies: hashes are verified before
use. A record whose stored hash, direction or alignment input differs from the current
value is therefore a valid file. Its result is simply not current at runtime (see the
fixtures `valid-v3-hash-not-current.json` and `valid-v3-inputs-not-current.json`).

## Writing

**Which format.** A writer emits the lowest format that holds the payload:

1. If `segments` and `segment_choice_history` are empty, and the v2 writer's output fits
   1 MiB, the writer emits exactly those v1 or v2 bytes. The v2 writer's output is v1
   without semantic data; otherwise it is v2, with v2's oldest-first `semantic_history`
   trimming. Old clients keep opening these files.
2. Otherwise, it writes v3. In v3, the oldest `semantic_history` snapshots are dropped
   only while the file exceeds 44 MiB. Records, choices, history choices and semantic
   decisions are never dropped. If the file is still too large, the save fails with
   `workfile_too_large`.

In long mode, the writer stores a record for every segment. `segments` is therefore
never empty, a long manuscript always saves as v3, and old clients cannot open it. A
reopened v3 file without segment state and without history choices is written back as
v2 or v1 (fixture `valid-v3-from-v2.json`).

**Records.** In long mode, at save time, the writer stores one record per segment of
the current segmentation-v1 pairing, using the current `alignments`, in order:

- If a done or stale record's content changed since its result, the record becomes
  pending: its hashes are recomputed; its result, basis and inputs are dropped; its
  choices become unconfirmed; and its index leaves `progress.completed`.
- If the direction changes, every record becomes pending.
- If only the alignment input or the basis changed, the record becomes stale.
- If the manuscript has more than 512 segments, the save fails with
  `workfile_too_many_entries`, and the message tells the user to split the manuscript.
  Saving without segment records is allowed only as the user's explicit choice; their
  choices then move to `segment_choice_history`, and if that history would exceed its cap,
  the user is told which choices will be dropped before the save.

**Leaving long mode.** When both sides drop to 2,000 scalars or fewer, the records go
away. Their choices move to `segment_choice_history`, each with the hash of its
record's source core. The file stays v3 while that history is not empty. Nothing is
dropped silently.

**Choices.** A choice stays in the record whose source core holds its occurrence.

- The writer relocates it through edits so that its span still reads the same in that
  core. Any mapping that preserves the text is acceptable, for example Web's
  `diffSplice`/`mapSpan`. Across a whole-text replacement, the reference rule is v1's
  `recoverSpan` (identical, unique, complete line block).
- A choice that cannot be placed moves to `segment_choice_history`, with the hash of the
  source core it was last in. If that history would exceed 512 entries, the save fails
  with `workfile_too_many_entries`. The client then lists the history entries, and the
  user removes some. Nothing is dropped silently.
- Adding, changing or confirming a choice in a done record makes the record stale.

**Progress.** `current` is the user's segment. `completed` follows the rules under
"Progress".

**Canonical bytes.** A v3 file is minified JSON: `JSON.stringify(value)` in
JavaScript, which is byte-identical to Python
`json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)`. That
means no whitespace between tokens, non-ASCII written as is, and no trailing newline.
Keys are in the orders given in this document. The v1 and v2 parts keep the values and
key order that the v2 writer gives them, and in a v3 file they are minified like the
rest. v1 and v2 files themselves stay pretty-printed, exactly as today.

## Runtime: reopening and re-checking

1. **No request on import.** Parsing never sends anything. Until the live basis arrives
   (step 4), the client shows saved results as saved, not as current, and sends no
   resolutions.
2. **Matching records to segments.** The reader pairs the current text with
   segmentation-v1. If the number of segments and every core range equal the records,
   records map by position. Otherwise:
   - Each current segment takes the first unused record with equal `source_hash` and
     `target_hash`.
   - A segment still unmatched takes the first unused record with an equal
     `source_hash`. It keeps that record's choices, unconfirmed; the result is not
     reused.
   - Every other segment is pending.
   - Choices of records left unused move to `segment_choice_history`.
   - `progress` follows the mapping.
3. **Content and input check, before any use.** The reader computes the hashes of the
   current cores, and the alignment input that a request would carry now (see
   "Segment request"). A result is a reuse candidate only if all of these hold:
   - its record is done;
   - both hashes are equal;
   - `direction` equals the manuscript's direction;
   - `alignment_input` equals the current alignment input.
4. **Live basis.** The client sends one review-v2 term check with
   `X-WuwaTerm-Matcher-Basis: 1`. It goes to the first of these:
   1. the segment at `progress.current`, if that segment needs a check;
   2. the first segment that needs a check;
   3. the segment at `progress.current`, or index 0.

   The probe costs one review admission, like any segment check. Its response basis is
   the current basis. If the response has no `matcher_revision`, or has a null
   `schema_version` or `source_commit`, there is no current basis, and no saved result
   is reused in this session.

   The probe carries no resolutions, because the current basis is not known yet. What
   happens to its response depends on the probed record:
   - If the record turns out current by step 5, it stays as stored. The probe only
     supplied the basis.
   - Otherwise, the probe counts as that segment's first request without resolutions in
     step 6.

   Reopening an unchanged manuscript whose basis is unchanged therefore costs exactly
   one review request.
5. **Current or stale.** A reuse candidate whose basis is the same as the current basis
   is current. It is not checked again, and its confirmed choices take effect without
   being confirmed again. Every other record with a result is stale and is checked
   again. Its finished mark, if any, stays; the segment shows as finished with a
   re-check pending. Whenever a later response carries a different basis, that basis
   becomes current, and every record is evaluated again by this step.
6. **Re-check.** A segment is checked in one or two requests.
   - If its source hash, direction and basis are unchanged from the record, one request
     sends the confirmed choices as resolutions. This is the case when only the target
     or the alignment input changed, or when its choices changed. The
     `resolution_context` is
     `{source_revision: source core hash, rule_version, dictionary_revision, matcher_revision}`,
     from the current basis.
   - Otherwise, the first request carries no resolutions, and the choices are realigned
     against its findings (step 7). If any choice was kept, the segment is checked once
     more with them.

   The stored result is always the compact form of the last response, together with
   that request's direction and alignment input.
7. **Realignment** is by occurrence and candidate, against the new result:
   - An `official_pair` is kept if the finding at the same source span still has a
     candidate with the same `candidate_id`, `zh`, `en` and `category`.
   - A `not_a_term` is kept if a finding at the same source span still exists and its
     candidate ids equal `offered` as a set. `candidates_truncated` plays no part, the
     same as at parse time.
   - A kept choice becomes confirmed.
   - Any other choice is unconfirmed and needs reconfirmation. It is shown and never
     dropped automatically. The user confirms it again, which for a `not_a_term` sets
     `offered` from the current finding, or removes it.
8. **History choices** are never applied. If a current segment's source hash equals an
   entry's `source_hash`, the client may offer to restore that entry as an unconfirmed
   choice.
9. **Failures.** A failed or cancelled check changes only that segment. The results of
   other segments, the choices and `progress` are kept, and the run can continue from
   the failed segment.

## Known limits

These limits are accepted for v3, with no change now.

- The Core basis does not cover the `free_text_lock_exclusions*` dictionary metadata,
  or judging changes that ship without a `MATCHER_REVISION` bump. Either one can change
  a verdict while all six basis values stay equal. This is a Core follow-up.
- segmentation-v1 packs pairs greedily, so an insertion early in the text can move every
  later segment boundary. Those segments' cores and hashes change, so they are checked
  again. Their choices are carried by the matching rules in "Runtime", step 2.
- A v3 file from another person shows that person's verdicts as current when the hashes,
  inputs and basis all match, just as for one's own file. The result describes the same
  text under the same service state, but the choices in it are the other person's.

## Compatibility

- **New clients** read v1, v2 and v3, and write by the format rule above.
- **Old clients** (Web 0.2.0, Windows 0.4.2 and anything earlier) reject every v3 file
  explicitly. They read nothing from it, never load it partially, and keep the
  manuscript that is already open. The code depends on the file:
  - `workfile_too_large` ("稿件文件不能超过 1 MiB") when the file is over 1 MiB, their
    first check;
  - `workfile_too_many_entries` when an array has more than 128 items, for example more
    than 128 segments;
  - `workfile_unsupported_format` ("不支持此稿件格式或版本") otherwise.

  `cases.json` records each case's expected old-client code as `legacy_error`. Web's
  test asserts it against `lib/manuscript.js`. When this spec was added, that file was
  unchanged since tag `v0.2.0` (5aabe80), so the test checks the Web 0.2.0 parser.
  Before M1 changes `lib/manuscript.js`, it must freeze a copy of the v0.2.0 parser for
  this check. Windows `parse_workfile` (`src/wuwaterm_client/manuscript.py`, unchanged
  since tag v0.4.2) gives every case its `legacy_error`: 61 of 61.
- **v2 contract.** Every input that is not a v3 object is read exactly as before. Every
  case in `contracts/manuscript-v2/cases.json` keeps its code under a v3 reader, which
  Web's test asserts.
- **Core API.** No change is needed:
  - A segment check is an ordinary review-v2 request of at most 2,000 scalars per side
    and at most 64 alignments.
  - Segment choices go out as review-v2 `resolutions`, with a `resolution_context` of
    `{source_revision, rule_version, dictionary_revision, matcher_revision}`. Core
    accepts these today, and the Web BFF forwards up to 32 resolutions with that
    four-key context.
  - Windows `ApiClient.review_pair` does not send resolutions yet. Adding them is a
    Windows client change in M2.

## Error codes

Both parsers use these codes. The messages are the canonical Chinese data form; UIs
localize by code.

| Code | Case | Message |
|---|---|---|
| `workfile_not_json` | not UTF-8, or not JSON | 无法读取 JSON 稿件文件。 |
| `workfile_too_large` | over 44 MiB, or a non-v3 input over 1 MiB | 稿件文件超过大小上限（v1/v2 为 1 MiB，v3 为 44 MiB）；请把稿件拆成较小的几份。 |
| `workfile_too_deep` | depth over 16 | 稿件文件嵌套过深。 |
| `workfile_too_many_entries` | an array over its cap, or a v3 count over its limit | 稿件文件条目过多；超过 512 段的稿件请拆成几份保存，选择历史过多时请先移除部分记录。 |
| `workfile_too_many_fields` | an object over 32 fields | 稿件文件字段过多。 |
| `workfile_forbidden_field` | a `__proto__`, `constructor` or `prototype` key | 稿件文件含不支持的字段。 |
| `workfile_unsupported_format` | an unknown `format`, or wrong top-level keys | 不支持此稿件格式或版本。请导入“保存稿件”生成的文件。 |
| `workfile_invalid_content` | an invalid v1/v2 part | 稿件内容、选择或位置依据无效；当前稿件未被替换。 |
| `workfile_duplicate_choices` | two choices for one occurrence, in a v1/v2 part or in one record | 稿件包含同一位置的重复选择，未导入。 |
| `workfile_segment_invalid` | a malformed record, result, finding, segment choice, history choice, basis or request input; for example an unknown status, segmentation version or alignment input, bad hex, a range outside the text or core, or a status that disagrees with its inputs, basis and result | 稿件的分段记录无效；当前稿件未被替换。 |
| `workfile_segment_order` | an index that is not its position (duplicated or out of order), or ranges that overlap or go backwards | 稿件的分段顺序或位置无效；当前稿件未被替换。 |
| `workfile_segment_anchor_invalid` | a choice outside its core or not reading the same there, or a confirmed choice without its finding or candidate | 稿件的逐段术语选择位置无效；当前稿件未被替换。 |
| `workfile_progress_invalid` | a malformed `progress`, or one that points at a missing or pending record | 稿件的进度记录无效；当前稿件未被替换。 |

Web 0.2.0 and Windows 0.4.2 say "稿件文件不能超过 1 MiB。" for `workfile_too_large`. New
clients use the message above.

## Fixtures

`cases.json` lists every fixture case. Every case has `file`, an optional
`pad_to_bytes`, a `note` and `legacy_error`. A valid case also has `canonical`, and an
invalid case also has `error`.

- `pad_to_bytes`: read `file` and append ASCII spaces (U+0020) until its UTF-8 length
  equals this number. The padding is JSON whitespace, so the parsed value is unchanged.
  This keeps the 1 MiB and 44 MiB boundary cases out of the working tree.
- `canonical`: the file whose exact bytes a conforming writer produces from the parsed
  value.
- `error`: the code that a v3 reader must report.
- `legacy_error`: what Web 0.2.0 and Windows 0.4.2 report (`null` means accepted).

All text is synthetic. The generator computes all hashes, digests and candidate ids;
none are typed. Two groups of fixtures use ranges that are not a segmentation-v1
result: the 512-segment fixtures, which use short paragraphs, and the core-length
boundary fixtures. Parsers do not run segmentation. The other v3 fixtures use the
ranges that `pairSegments` produces for their text; this includes
`valid-v3-over-1mib.json`.
