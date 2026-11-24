# Manuscript JSON Schema and Generated DTOs

`manuscript.schema.json` is the machine-readable Draft 2020-12 schema for the
`wuwaterm-manuscript-v1` through `wuwaterm-manuscript-v4` wire/file formats.

## Boundary of Responsibility

**Owned by `manuscript.schema.json` (and emitted DTOs):**
- Top-level and nested object key sets (`additionalProperties: false`, required keys)
- Closed enum string sets (`Direction`, `Verdict`, `ReasonValue`, `ChoiceKind`, `RecordStatus`, `SemanticCategory`, `TermEffect`, etc.)
- Digest patterns (`Hex64`, `Hex32`) and fixed protocol versions (`segmentation-v1`, `review-v2`, `semantic-review-v1`)
- Format-specific list caps (`32` in v1–v3 vs `128` in v4; `512` segments/history)
- Structural discriminants (`not_evaluated`-only `reason`, `pending` vs `done`/`stale` records, `official_pair` vs `not_a_term`, `ignored` decision `applied_text: null`, `suggestion: null` vs `alternatives`)

**Retained by client business validators (`lib/manuscript.js` and `WuwaTerm-Windows` `manuscript.py`):**
- Unicode scalar lengths (e.g., `<= 2000` core scalars vs `44 MiB` workfile UTF-8 byte caps) and lone-surrogate rejection
- Span text slice verification against `source`/`target` strings (`highlightSegments`, `recoverSpan`)
- Monotonic ordering, non-overlapping segment ranges, and duplicate-choice/duplicate-finding detection
- Confirmed choice verification against reported `findings` and candidate lists
- JSON nesting depth / field count / prototype-pollution key guards (`__proto__`, `constructor`, `prototype`)
- Runtime reuse eligibility (`source_hash`/`target_hash`, `alignment_input`, live session basis)

## Schema Validator Keyword Allowlist

[`scripts/validate-json-schema.mjs`](../../scripts/validate-json-schema.mjs) is a zero-dependency Draft 2020-12 subset engine gated by `assertSupportedSchema` (failing closed if any schema introduces an unsupported keyword, unknown `type`, or missing `$ref`):
- Metadata/definitions: `$schema`, `$id`, `title`, `description`, `$defs`, `$ref`
- Types & scalars: `type` (`null`, `boolean`, `string`, `number`, `integer`, `array`, `object`), `const`, `enum`, `minLength`, `maxLength` (Unicode code points), `pattern` (`/u`), `minimum`, `maximum`
- Arrays: `minItems`, `maxItems`, `uniqueItems` (structural deep equality), `prefixItems`, `items`
- Objects: `required`, `properties`, `additionalProperties`, prototype-pollution key blocks
- Combinators: `allOf`, `anyOf`, `oneOf`, `not`

## Regenerating and Checking DTOs

```bash
npm run generate:contracts   # regenerate lib/generated/manuscript-contract.ts and contracts/generated/manuscript_contract.py
npm run check:contracts      # fail if generated artifacts drift from manuscript.schema.json
```
