# Manuscript JSON Schema and Generated DTOs

`manuscript.schema.json` is the machine-readable Draft 2020-12 schema for the
`wuwaterm-manuscript-v1` through `wuwaterm-manuscript-v5` wire/file formats.
`../manuscript-v5/schema.json` is the v5 part alone (ManuscriptV5 and every definition it
reaches), cut from this file by the generator for consumers that read only v5.

## Boundary of Responsibility

**Owned by `manuscript.schema.json` (and emitted DTOs):**
- Top-level and nested object key sets (`additionalProperties: false`, required keys)
- Closed enum string sets (`Direction`, `Verdict`, `ReasonValue`, `ReasonValueV5`, `ReviewFeature`, `SegmentationVersionV5`, `ChoiceKind`, `RecordStatus`, `SemanticCategory`, `TermEffect`, etc.)
- Digest patterns (`Hex64`, `Hex32`) and fixed protocol versions (`segmentation-v1`, `review-v2`, `semantic-review-v1`)
- Format-specific list caps (`32` in v1–v3 vs `128` in v4 and v5; `512` segments/history; `8` review features)
- Structural discriminants (`not_evaluated`-only `reason`, `pending` vs `done`/`stale` records, `official_pair` vs `not_a_term`, `ignored` decision `applied_text: null`, `suggestion: null` vs `alternatives`)

**Retained by client business validators (`lib/manuscript.js` and `WuwaTerm-Windows` `manuscript.py`):**
- Unicode scalar lengths (e.g., `<= 2000` core scalars vs `44 MiB` workfile UTF-8 byte caps) and lone-surrogate rejection
- Span text slice verification against `source`/`target` strings (`highlightSegments`, `recoverSpan`)
- Monotonic ordering, non-overlapping segment ranges, and duplicate-choice/duplicate-finding detection
- Confirmed choice verification against reported `findings` and candidate lists
- JSON nesting depth / field count / prototype-pollution key guards (`__proto__`, `constructor`, `prototype`)
- Runtime reuse eligibility (`source_hash`/`target_hash`, `alignment_input`, live session basis, session review features)
- v5 cross-field rules: an `ambiguous_mention` reason only with `ambiguous-mention-v1` in `review_features`, one segmentation label per file

## Schema Validator Keyword Allowlist

[`scripts/validate-json-schema.mjs`](../../scripts/validate-json-schema.mjs) is a zero-dependency Draft 2020-12 subset engine gated by `assertSupportedSchema` (failing closed if any schema introduces an unsupported keyword, unknown `type`, or missing `$ref`):
- Metadata/definitions: `$schema`, `$id`, `title`, `description`, `$defs`, `$ref`
- Types & scalars: `type` (`null`, `boolean`, `string`, `number`, `integer`, `array`, `object`), `const`, `enum`, `minLength`, `maxLength` (Unicode code points), `pattern` (`/u`), `minimum`, `maximum`
- Arrays: `minItems`, `maxItems`, `uniqueItems` (structural deep equality), `prefixItems`, `items`
- Objects: `required`, `properties`, `additionalProperties`, prototype-pollution key blocks
- Combinators: `allOf`, `anyOf`, `oneOf`, `not`

## Regenerating and Checking DTOs

```bash
npm run generate:contracts   # regenerate lib/generated/manuscript-contract.ts, contracts/generated/manuscript_contract.py and contracts/manuscript-v5/schema.json
npm run check:contracts      # fail if generated artifacts drift from manuscript.schema.json
```
