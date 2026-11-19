# Manuscript format v4 (`wuwaterm-manuscript-v4`)

Status: contract for WuwaTerm-Web and WuwaTerm-Windows. Both parsers and both writers
implement this file together with [`../manuscript-v3/SPEC.md`](../manuscript-v3/SPEC.md),
which v4 changes only where this file says so. `cases.json` in this directory is the
shared fixture index. Regenerate the fixtures with
`node scripts/build-manuscript-v4-fixtures.mjs --write`; without `--write`, the script
only checks that the committed bytes are current.

v4 exists because one review can now return, and one person can now decide, more than 32
things at once. The v1 to v3 formats cap every list of findings, choices and resolutions
at 32, which was Core's `review-v2` cap. A dense review (Core feature `dense-128`) returns
up to 128 findings, and a not-evaluated finding can say why (feature `reason-v1`). A file
that holds such a review or the choices made on it needs v4. A manuscript that does not
need it keeps its lower format, so old clients keep opening it.

## What changes

| | v1 / v2 | v3 | v4 |
|---|---|---|---|
| Top-level keys | 7 / 10 | 13 | the same 13 as v3 |
| `format` | `wuwaterm-manuscript-v1` / `-v2` | `wuwaterm-manuscript-v3` | `wuwaterm-manuscript-v4` |
| File size | 1 MiB | 44 MiB | 44 MiB (46,137,344 bytes) |
| Findings per document-mode report (`history[].report.findings`) | 32 | 32 | 128 |
| Resolutions per history snapshot (`history[].resolutions`) | 32 | 32 | 128 |
| `choices` (document mode) | 32 | 32 | 128 |
| Findings per record result (`segments[].result.findings`) | none | 32 | 128 |
| `choices` per record | none | 32 | 128 |
| Finding `reason` | not allowed | not allowed | allowed on `not_evaluated` |

Everything else is exactly v3: the 13 top-level keys and their order, segment records,
the compact result, the segment choice and history entry shapes, `progress`, canonical
bytes (minified UTF-8 JSON, no trailing newline), the text limit of 46,137,344 scalars,
the nesting depth of 16, at most 32 fields per object, at most 512 items in the whole tree,
the forbidden keys `__proto__`, `constructor` and `prototype`, `alignments` at most 64,
`history` at most 2, `semantic_decisions` at most 128, `semantic_texts` at most 16,
`semantic_history` at most 2, `candidates` per finding at most 8 and `offered` at most 8.
The runtime rules of "Runtime: reopening and re-checking" apply unchanged.

The v1, v2 and v3 readers do not change: a file labelled with one of those formats keeps
its 32-item limits and rejects `reason`, whatever its content. Only the label `v4` brings
the v4 limits.

## Finding `reason`

A `not_evaluated` finding says why Core did not evaluate it, with one of these five
values. They are the whole set, and a reader rejects any other string. Core defines what
each one means (its review-v2 contract); a client only labels them, and the manuscript
only stores them.

`not_a_term`, `ordinary_word`, `no_target_region`, `found_outside_region`,
`ambiguous_repeat`.

The rules:

- `reason` is present only when `verdict` is `not_evaluated`. A finding without one has no
  `reason` key. `reason: null`, an unknown string, or a `reason` on any other verdict makes
  the file invalid.
- In a document-mode report (`history[].report.findings[]`), a finding has exactly these 7
  keys when it has no reason: `id`, `rule_id`, `verdict`, `source_span`, `target_span`,
  `candidates`, `candidates_truncated`. With a reason it has exactly 8: the same 7, and
  `reason` as the last one. The key order is not checked by a reader; the writer keeps
  the order it was given.
- In a record result (`segments[].result.findings[]`), a compact finding has exactly these
  5 keys when it has no reason, in this order: `verdict`, `source`, `target`, `candidates`,
  `candidates_truncated`. With a reason it has exactly 6, in this order: the same 5, and
  `reason` last.
- Rebuilding a review report from a compact result (v3 SPEC "Compact term result") keeps
  `reason` where the record has one, after `candidates_truncated`.

## Limits

Over any limit, the parser rejects the file with the code given under "Reading", and the
writer fails the save with that code. Nothing is truncated silently.

| Limit | v1 / v2 / v3 | v4 |
|---|---|---|
| Array items, any array of the file | 128 (v1/v2), 512 (v3) | 512 |
| Array items, any array of the v1 and v2 parts (`choices`, `history`, `alignments`, `semantic_*`, `history[].resolutions`, `history[].report.findings`) | 128 | 128 |
| `segments`, `segment_choice_history`, `progress.completed` | 512 | 512 |
| `choices` (document mode) | 32 | 128 |
| `history[].resolutions` | 32 | 128 |
| `history[].report.findings` | 32 | 128 |
| findings per record result | 32 | 128 |
| `choices` per record | 32 | 128 |

The 128 of the v1 and v2 parts is the same array cap that v3 already applies there
(fixture `invalid-v3-129-decisions.json`), so a list of 129 items in a v4 document-mode
part gives `workfile_too_many_entries` before any content check, as in v3.

The web request cap changed with the format. A review request of up to 128 resolutions is
larger than 32 KiB, so the Web BFF accepts up to 64 KiB for `/api/reviews` and keeps 32 KiB
for every other endpoint. The cap of the manuscript file is not affected.

## Reading

A reader follows v3 "Reading", with these differences:

1. Step 2: the content parses as JSON, its top level is an object, and its `format` is
   `"wuwaterm-manuscript-v3"` **or** `"wuwaterm-manuscript-v4"`: continue with step 3. The
   size cap of both is 44 MiB. Every other input is read by the v2 reader unchanged,
   starting with its 1 MiB check, so a label that is neither (for example
   `wuwaterm-manuscript-v5`) gives `workfile_unsupported_format`.
2. Steps 3 and 4 are the same for both formats.
3. Step 5, the v1 and v2 parts. First the v2 array cap of 128 anywhere in them
   (`workfile_too_many_entries`). Then the v2 content checks, with the limits of the
   format: for `v3`, 32 choices, 32 resolutions per history snapshot, 32 findings per
   history report and no `reason`; for `v4`, 128 of each, and a `reason` allowed as
   above. A violation gives `workfile_invalid_content`, as in v2.
4. Step 6, the record structure. A count over its cap gives
   `workfile_too_many_entries`. The caps are segments 512, candidates 8 and `offered` 8,
   and for findings and choices per record 32 in `v3` and 128 in `v4`. A finding with a
   `reason` that is not on a `not_evaluated` verdict, is null, or is not one of the five
   values has an unknown key set or value, so the code is `workfile_segment_invalid`.
5. Steps 7 to 10 are the same.

## Writing

A writer emits the **lowest** format that holds the payload. Only the last two document
reports are written (`history`), so only they count.

1. **v1 or v2.** There is no segment state (`segments` and `segment_choice_history` are
   empty), and:
   - `choices` has at most 32 items;
   - every written `history[]` has at most 32 `resolutions` and at most 32 findings, and
     no finding has a `reason` key;
   - the v2 writer's output (v3 SPEC "Writing", step 1) fits 1 MiB.

   The bytes are the v1 or v2 bytes, pretty-printed as before.
2. **v3.** The conditions on `choices` and `history` above hold, every record has at most
   32 `choices`, and every record result has at most 32 findings with no `reason` key. It
   does not matter whether segment state exists or whether the file is over 1 MiB.
3. **v4.** Otherwise. The bytes are minified JSON as in v3, with `"format":"wuwaterm-manuscript-v4"`
   and the records in the v3 key order; a compact finding is written with its `reason` as
   the last key when it has one. The oldest `semantic_history` snapshots are dropped only
   while the file is over 44 MiB; nothing else is ever dropped. If it is still too large,
   the save fails with `workfile_too_large`.

A v4 file read back and written again follows the same rule, so one that fits a lower
format is written in that format (fixtures `valid-v4-fits-v3.json` and
`valid-v4-fits-v1.json`). A writer never writes a file that its own reader rejects.

## Compatibility

- **New clients** read v1 to v4 and write by the rule above.
- **Old clients** (Web 0.3.1, Windows at the v3 contract) read a v4 file as unsupported,
  explicitly: they read nothing from it and keep the manuscript that is already open. The
  code depends on the file:
  - `workfile_too_large` when the file is over 1 MiB, their first check;
  - `workfile_too_many_entries` when an array has more than 128 items;
  - `workfile_invalid_content` when the label is a lower one (a v2 label) and the content
    is over its limits;
  - `workfile_unsupported_format` otherwise.

  `cases.json` records each case's code under those clients as `legacy_error`. Web's test
  asserts it against `tests/legacy/web-0.3.1/manuscript.js`, a frozen copy of the Web
  0.3.1 parser (tag `v0.3.1`), and the Windows contract test asserts it against the
  Windows revision that `contracts/windows-ref.txt` pins, until that pin moves to a
  revision that implements v4.
- **v3 contract.** `contracts/manuscript-v3/` does not change. Its case
  `invalid-v3-format-v4.json`, an unknown format version for a v3 reader, is a valid v4
  payload: a v4-capable reader accepts it, and the v3 tests assert its v3 code against
  the frozen reader.
- **Core API.** No manuscript format change reaches Core. The features are negotiated per
  request by the header `X-WuwaTerm-Review-Features` (`dense-128`, `reason-v1`), which the
  Web BFF forwards only when the client sent it. A service that does not know them keeps
  answering with up to 32 findings and no reason, which v4 clients still accept.

## Error codes

The 13 codes and their messages are those of v3 "Error codes", unchanged. v4 adds no code.
The message of `workfile_too_large` still names the v1/v2 and v3 sizes; 44 MiB is also
the v4 size.

## Fixtures

`cases.json` lists every fixture case. Every case has `file`, an optional `pad_to_bytes`,
a `note` and `legacy_error`. A valid case also has `canonical`, and an invalid case also
has `error`; these have the meaning of v3 "Fixtures", with `legacy_error` the code of Web
0.3.1 (`null` means accepted).

All text is synthetic or public game terms. The generator computes all hashes, digests and
candidate ids; none are typed. The valid cases:

- `valid-v4-document-dense.json`: document mode with 40 findings in a history report
  (five of them `not_evaluated`, one per reason code), 40 resolutions and 40 choices. The
  same file padded with spaces to 1,048,577 bytes is a valid case too.
- `valid-v4-document-reason-only.json`: document mode where the only thing over the v3
  shape is a `reason`.
- `valid-v4-segments-dense.json`: long mode with a record of 128 findings and 128
  choices, all five reasons, and a record of 33 findings and 33 choices.
- `valid-v4-segment-reason-only.json`: long mode where the only thing over the v3 shape
  is a record finding's `reason`.
- `valid-v4-fits-v3.json` and `valid-v4-fits-v1.json`: v4 files that are written back as
  `valid-v3-from-v4.json` and `valid-v1-from-v4.json`.

The invalid cases are the boundaries: 129 findings, resolutions, choices or record
choices, a `reason` on a verdict that is not `not_evaluated`, `reason: null`, an unknown
reason, a v5 label, files with the v1 to v3 labels that keep the old limits, and a v4
file one byte over 44 MiB.
