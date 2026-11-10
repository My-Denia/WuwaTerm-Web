# Manuscript v2 (semantic review decisions)

The Web owns the local manuscript file format. `wuwaterm-manuscript-v1` is unchanged.
`wuwaterm-manuscript-v2` adds the user's decisions on model-backed semantic review
issues (Core ADR 0018/0019). Cross-repository fixtures: `contracts/manuscript-v2/`
(`cases.json` indexes them; regenerate with `node scripts/build-manuscript-v2-fixtures.mjs --write`,
default mode only checks). The Windows client ports against these.

## When v2 is written

`serializeWorkfile` writes v2 only when there is at least one semantic decision or
history snapshot; otherwise it writes exactly the v1 bytes. A v2 file cannot be
opened by Web 0.1.x or Windows 0.3.x (they reject the format); v1 files stay readable
everywhere. `parseWorkfile` accepts both and returns the object as stored; its
`format` field tells the caller which one. `semanticPartsOf(parsed)` returns the three
semantic arrays (empty for v1).

The web review workbench reads and writes v2. Opening a v2 file restores its decisions,
stored old texts and history snapshots; saving writes them back, so no semantic state is
lost between sessions. Without a Core that offers `semantic-review-v1`, the semantic
features are hidden and the decisions in an opened file are kept as they are.

## Fields

Top level (exact keys): the v1 keys (`format`, `source`, `target`, `direction`,
`alignments`, `choices`, `history`) plus:

- `semantic_decisions` (at most 128). Exact keys `issue_id`, `fingerprint` (32 hex),
  `category`, `segment_index` (reference only), `source_revision`, `target_revision`
  (64 hex, sha256 of the WHOLE source and WHOLE target the issue was reported against,
  before any adoption), `source_span`, `target_span` (`{start,end,text}` in whole-document
  scalar coordinates, or null, never both null), `decision` (`accepted`, `adjusted`,
  `ignored`), `applied_text` (null exactly for `ignored`), `basis`
  (`review_version: semantic-review-v1`, `term_basis{dictionary_revision, matcher_revision}`).
  No two decisions share the occurrence key `[category, source_revision, target_revision,
  source start/end, target start/end]` (`workfile_duplicate_choices`).
- `semantic_texts` (at most 16): `{revision, text}`, unique revisions. The old whole texts
  that `ignored` decisions need to recover their spans when the text has since changed
  (an `ignored` decision leaves the text untouched, so the old text is otherwise lost once
  the user edits another line). Parsing checks structure only; hashes are verified before
  use. The writer drops entries no `ignored` decision references.
- `semantic_history` (at most 2): untrusted reference snapshots `{source, target, direction,
  segments}`; each segment carries the scalar ranges of the cores sent to Core and a
  `semantic-review-v1` report valid for those slices.

Writing keeps the last 2 history snapshots. Over 1 MiB the oldest snapshots are dropped
first; if the file is still too large the write fails with `workfile_too_large`. Decisions
are never dropped.

## What the web writer stores

- `semantic_texts` holds only revisions that an `ignored` decision references and that
  differ from the current text, newest first, at most 16, within 1 MiB. When they do not
  fit, the oldest are dropped first. An `ignored` decision whose text was dropped gets
  `old_text_unavailable` at the next re-review and returns to needing reconfirmation; the
  decision itself is kept.
- A `semantic_history` snapshot includes only segments whose current slice still equals the
  content that was sent to Core, at most 64 segments.
- Processing the same occurrence again replaces the earlier decision for it.
- At 128 decisions the workbench refuses a new decision and says so.
- Precedents and request context are never written into the manuscript.

## Re-review merge rules (`lib/semantic-decisions.js`)

Spans of a fresh review are shifted into whole-document coordinates with `toDocumentIssue`
(the request carried the segment core). Then `reconcileSemanticDecisions`:

1. The fingerprint only finds candidates: same fingerprint and same category.
2. Only `ignored` can carry over automatically, and only when both old texts are available
   and verified (the current text if its sha256 equals the revision, else a hash-verified
   `semantic_texts` entry), each non-null span recovers uniquely by `recoverSpan`
   (identical, unique, complete line block), exactly one candidate exists in the whole
   report, and its spans equal the recovered spans. Status `carried`.
3. `accepted` and `adjusted` never carry (the text already changed). Reported again at the same
   source place: `previously_applied` (stays pending). Otherwise `needs_reconfirmation`.
4. Any unmet condition with candidates present: `needs_reconfirmation`, the old decision
   shown as reference. No candidates: `not_reported`.
5. Two decisions carried onto one new issue both become `needs_reconfirmation`.

Result codes: `carried`, `not_reported`, `previously_applied`, `applied_not_carried`,
`old_text_unavailable`, `source_span_unrecoverable`, `target_span_unrecoverable`,
`multiple_candidates`, `candidate_elsewhere`, `converged_on_one_issue`.
