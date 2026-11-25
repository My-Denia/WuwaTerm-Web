# Local user termbase (`wuwaterm-termbase-v1`)

Status: contract for WuwaTerm-Web and WuwaTerm-Windows. Both readers and both writers implement this file.
[`schema.json`](schema.json) is the machine-readable form of the structure,
[`cases.json`](cases.json) indexes the shared fixtures in [`fixtures/`](fixtures/), and the TypeScript and Python types are
generated from the schema by `npm run generate:contracts` (`lib/generated/termbase-contract.ts`,
`contracts/generated/termbase_contract.py`). Regenerate the fixtures with
`node scripts/build-termbase-v1-fixtures.mjs --write`; without `--write` the script only checks that the committed bytes are
current. The format is specified by the Core repository's ADR 0021.

A termbase is a list of terms one person keeps for themself: community and guide wording, preferred renderings, and surfaces
that stay untranslated. It is a reading aid. It is not part of the official dictionary and not part of a manuscript.

## What a termbase never does in Web

- It is held in page memory only. Web writes it to no `localStorage`, `sessionStorage`, IndexedDB or cookie; a reload empties it.
- It leaves the page only when the person exports it to a file. No request to `/api/translate`, `/api/review`,
  `/v1/translations`, `/v1/reviews` or any other endpoint carries a termbase or any entry of it.
- It is never written into a `.wuwaterm` manuscript (`wuwaterm-manuscript-v1` to `-v4`), and importing a manuscript does not
  touch it.
- A match is shown as the person's own reference. It does not take part in machine translation, does not lock a term, and
  does not change any official dictionary lookup or review verdict.

## File

UTF-8 JSON, no byte order mark. The writer produces the canonical form: keys in the order below, two-space indent, LF line
ends, one trailing newline. A reader accepts any RFC 8259 JSON that meets the rules below, including other whitespace.

```json
{
  "format": "wuwaterm-termbase-v1",
  "schema_version": 1,
  "updated_at": "2026-11-25T00:00:00Z",
  "entries": [
    {
      "id": "tb-001",
      "source": "主C",
      "target": "main DPS",
      "direction": "en",
      "kind": "community_term",
      "note": "Community team role shorthand in guides.",
      "updated_at": "2026-11-25T00:00:00Z"
    }
  ]
}
```

### Top level

Exactly these four keys, all required.

| Key | Value |
|---|---|
| `format` | the string `wuwaterm-termbase-v1` |
| `schema_version` | the integer `1` |
| `updated_at` | a timestamp (below) |
| `entries` | an array of at most 2,000 entries, possibly empty |

### Entry

Exactly these seven keys, all required. Lengths count Unicode scalars (an astral character is one scalar, two UTF-16 code
units, four UTF-8 bytes).

| Key | Value |
|---|---|
| `id` | a string of 1 to 64 scalars, unique in the file |
| `source` | the surface to look for, 1 to 120 scalars |
| `target` | the rendering, 1 to 160 scalars; for `do_not_translate` the surface kept as written |
| `direction` | `"en"` for Chinese into English (the text read is Chinese), `"zh"` for English into Chinese (the text read is English) |
| `kind` | `"community_term"`, `"preferred_term"` or `"do_not_translate"` |
| `note` | a string of 0 to 160 scalars; a hint to the reader, never an instruction |
| `updated_at` | a timestamp (below) |

`direction` names the language of the translation, as on every other WuwaTerm surface.

### Timestamp

RFC 3339 in UTC: `YYYY-MM-DDTHH:MM:SS`, an optional fraction of one to nine digits, and `Z`. `T` and `Z` are uppercase,
offsets such as `+08:00` are not allowed, the day exists in its month, and the second is 00 to 59 (a leap second `:60` is
not allowed). The Web writer emits whole seconds.

## Limits and refusals

A file over a limit or breaking a rule is refused whole: nothing is repaired or truncated, and the previous termbase stays
as it was. Each refusal has one code.

| Code | When |
|---|---|
| `termbase_too_large` | more than 1,048,576 bytes (1 MiB) of UTF-8, counted on the file's bytes before decoding |
| `termbase_not_json` | not valid UTF-8, a byte order mark, or not JSON (comments, trailing commas, single quotes, leading zeros, raw control characters in strings, content after the value) |
| `termbase_nul` | a NUL byte anywhere, or a `\u0000` escape |
| `termbase_forbidden_key` | an object key `__proto__`, `constructor` or `prototype`, at any depth |
| `termbase_duplicate_key` | the same key twice in one object, at any depth |
| `termbase_surrogate` | an isolated UTF-16 surrogate: a `\ud800` to `\udfff` escape that is not half of a high-then-low pair |
| `termbase_non_finite` | `NaN`, `Infinity`, `-Infinity`, or a number too large to be finite (`1e999`) |
| `termbase_too_many_entries` | more than 2,000 entries |
| `termbase_invalid_content` | anything else against the structure above: an unknown or missing key, a wrong type or value, a length out of range, a bad timestamp, a duplicate `id`, nesting deeper than 8 |

Where a file breaks several rules the reader reports one, in this precedence: the byte size; then invalid UTF-8; then a raw NUL byte anywhere;
then, while reading, whichever of `termbase_not_json`, `termbase_nul` (escape), `termbase_forbidden_key`,
`termbase_duplicate_key`, `termbase_surrogate` and `termbase_non_finite` comes first in the file; then
`termbase_too_many_entries`; then `termbase_invalid_content`. An error carries a location such as `entries[3].source` and
never the file's content.

The JSON Schema states the structure (the entry count and every `termbase_invalid_content` rule except uniqueness of `id`, the month length of a timestamp and
nesting depth). It cannot state the byte limit, duplicate keys, NUL, isolated surrogates or non-finite numbers, which are
properties of the bytes rather than of the parsed value; those belong to the reader. `cases.json` records, for each invalid
fixture, whether the schema alone rejects it (`rejects`), accepts it (`accepts`), or cannot be applied because the file is not
JSON (`not-json`).

## Matching (reference only)

The Web page shows which entries occur in the current source text. The rule, so two clients agree on what a hit is:

- Only entries whose `direction` equals the document's translation direction are considered, and only the source text is read.
- `source` is searched literally, ignoring case. No other normalization is applied (no width folding, no Unicode
  normalization, no stemming), and no regular expression or wildcard is read from a surface.
- Where the surface begins or ends with a letter, digit or underscore that is not a CJK character, the occurrence must not
  be adjacent to another such character on that side. A surface edge that is a CJK character or a symbol matches as a plain
  substring.
- Occurrences do not overlap within one entry, and are reported with scalar offsets.
- Web reads at most the first 100,000 UTF-16 code units of a text, and reports when it stopped there.

## Fixtures

`cases.json` lists every valid and invalid fixture with its expected refusal code and the schema outcome. Four fixtures are
too large to commit and are built from the descriptors under `generated` by `buildGenerated` in
`scripts/build-termbase-v1-fixtures.mjs`: exactly 2,000 entries, a file of exactly 1,048,576 bytes, 2,001 entries, and a file
of 1,048,577 bytes.
