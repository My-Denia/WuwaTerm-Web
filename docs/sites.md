# WuwaTerm anonymous public beta Site

The current public entry is
<https://wuwaterm.denia-official.chatgpt.site>. It is anonymously reachable,
requires no WuwaTerm account, and offers Chinese-English official-term lookup,
bidirectional term-locked sentence translation, and a review workbench that
checks an existing translation against the dictionary and saves resumable local
manuscript files, all through one shared public beta pool. It is a best-effort
hobby service: one visitor can exhaust the pool, requests can be busy or fail,
and there is no SLA.

## Evidence boundaries

- **Repository fact:** This repository is a separately built Hosted / Cloudflare Worker
  BFF. The browser calls only same-origin `/api/pool`, `/api/terms`,
  `/api/translations`, `/api/reviews`, `/api/capabilities`, `/api/semantic-reviews`,
  `/api/structure-checks` and the on-demand `/api/meta`; the server-side proxy holds the device credential and
  calls the published `/v1` contract. There is no visitor account system in
  this application code.
- **Hosted platform control:** the hosting platform owns deployment versions,
  resources and any platform-level access control. Those values are not encoded
  by the application tree. Anonymous reachability does not prove a particular
  ACL value or immutable deployed-version identity.
- **VPS fact:** the supported production topology keeps dictionary lookup,
  ranking, direction detection, term locking and model calls on the authoritative
  VPS API. The Site contains no second translation pipeline. A documentation
  check or public response is not a fresh attestation of a particular VPS
  process, container or commit.
- **Current production observation (2026-09-06):** cookie-free requests reached
  the public pages and same-origin API; exact lookup and one tested sentence in
  each direction succeeded, while another admitted translation first returned a
  busy response and later succeeded after the suggested wait. This establishes
  the tested behavior, not universal model accuracy or future availability.
- **Current production observation (2026-09-13):** fresh, cookie-free browser
  sessions showed the review workbench on the public page. Exact lookups,
  Chinese-to-English sentence translations and one review check succeeded; the
  first lookup attempt returned an upstream timeout and later attempts
  succeeded. The same limits apply: this is tested behavior, not an availability
  promise.

`/api/capabilities` reports which optional features the service lists
(`ambiguous-mention-v1`, `semantic-review-v1`, `structure-check-v1`,
`translation-context-v1`); any other name is dropped. The probe is not charged to
the shared pool and its result is cached for a few minutes. An old service that
answers 404 is treated as listing nothing. `/api/semantic-reviews` sends one
paired segment to the service's model only when the service lists
`semantic-review-v1`. It is charged as one translation, with characters equal to
the longer side, and so shares the translation switch and daily allowance. When
the service does not list it, the Site answers 503 `semantic_review_unavailable`
without charging anything. The public Site's Core does not list
`semantic-review-v1` (the feature is experimental and off by default), so on the
public Site this path is idle.

`/api/structure-checks` forwards a Layer 1 deterministic structure check (Core
`POST /v1/structure-checks`, `structure-check-v1`, Core ADR 0022) only when the
service lists `structure-check-v1`; otherwise it answers 503
`structure_check_unavailable` and charges nothing. Each call is charged as one review.
The request is 1 to 64 paired segments of at most 2,000 characters per side and
20,000 in all, at most 64 KiB; the answer, which can be larger than the 64 KiB every
other endpoint allows, is read up to 256 KiB and validated against the request (spans,
rule ids, segment ids and layout counts). No model is called and nothing is stored.

Optional `/api/meta` is not requested when the page loads. In 「运行详情」,
「查看词典版本」 asks once for the dictionary the running service reports: database schema
version, source commit, game version, resource version, changelist, term count,
and the request id. Closing and reopening that panel reuses the read.
「重新读取」asks again. Each ask spends one shared meta admission (60 per UTC
day). If the service meta body has no game, resource, or changelist fields,
those three are null and the page says they were not provided. A failed read
says the current version cannot be confirmed. The page does not substitute the
repository pin, a candidate database, or a deployment claim. The browser
response does not include the device token, backend URL, `llm_configured`, or
service configuration. The Telegram bot, Windows client and API contract are
separate surfaces and are unchanged by public Site access.

## One document workspace

The home page holds one document: a source, its translation, the target language
and one undo and redo history (50 steps each). Quick translation and manuscript
review are two layouts of that document, not two tools. Quick mode shows the term
lookup beside the two editors and translates the whole source in one request of
up to 2,000 characters, with the direction detected automatically unless the
user picks one. When either side passes 2,000 characters, a manuscript file is
imported, or the user opens manuscript review, the page switches to manuscript
review in place: the texts, the history, the caret and an IME composition stay,
and nothing asks to hand the text over. It never switches back on its own, and
quick mode is unavailable while the document is past the limit.

One status line shows the pool snapshot, the dictionary the latest report or a
requested provenance names, the features the service lists and whether the
manuscript is saved. The 「运行详情」 drawer holds the shared-pool explanation,
every allowance, the dictionary provenance and the product notes. A page load
reads `/api/pool` and `/api/capabilities` once each; the pool is read again only
after a request that spends it or an explicit refresh. Nothing is written to
browser storage.

## Resumable bilingual manuscripts

The review workbench saves a user-initiated JSON file in the lowest manuscript
format that holds the work: `wuwaterm-manuscript-v1`, `wuwaterm-manuscript-v2`
once it holds semantic decisions or history, `wuwaterm-manuscript-v3` once it
holds long-manuscript segment state (below), `wuwaterm-manuscript-v4` once a
list is over 32 items or a finding carries a `reason` (below), or
`wuwaterm-manuscript-v5` once it records results made with a review feature or
gap-tolerant segment records (below). It reads all five.
It contains source, target, direction, up to 32 occurrence-specific decisions (128
in v4), their dictionary/rule/candidate basis, explicit scalar correspondences and
the last two reports. Import is local and bounded to 1 MiB (44 MiB for v3 and v4);
it never sends a request.
Undoing an import restores the prior manuscript and its historical reports; it still requires an explicit fresh check.
There are no accounts, cloud manuscripts, automatic uploads or browser-storage
history. The user must download and later import the file to resume. The page
can show whether current work still matches the latest manuscript download or
the file imported in this visit, but it cannot confirm that download reached
disk. Link departures ask first when the work cannot be restored from that
imported file. Cross-page links use full document navigation so browser Back,
Forward and reload request the browser's own warning. Cancelling retains the
manuscript, decisions and reports. A crash or forced quit can still discard the page.

**My terms (reference).** A collapsible panel in the workspace holds a personal term
list in the format `wuwaterm-termbase-v1`
([contract](../contracts/termbase-v1/SPEC.md)): import and export are explicit file
actions, entries are added, edited and deleted in page memory, and a reload empties
the list. It writes to no `localStorage`, `sessionStorage`, IndexedDB or cookie,
sends no request, and is never part of a `.wuwaterm` manuscript. An entry found in
the current source text is shown as a user reference, apart from the official
dictionary; it takes no part in translation, term locking or review.

The 2,000-character review request limit does not restrict manuscript storage:
long translations can be saved and reopened intact within the file size cap
(1 MiB for v1 and v2, 44 MiB for v3, v4 and v5).
A manuscript with either side over 2,000 scalars is in long mode: it is paired
into segments with `segmentation-v1` (Core's rules and fixtures; at most 1,800
scalars per side) and checked one segment at a time. The user's term choices are
kept per segment (see "Long manuscripts in v3"). Both replacement
actions refuse edits that would exceed the review limit without changing the
draft.

### Long manuscripts in v3

A long manuscript saves as v3 ([specification](../contracts/manuscript-v3/SPEC.md)).
Per segment, the file holds a compact term result, the inputs and basis it was
computed under, and the user's term choices in that segment; it also holds a
history of choices whose segment no longer exists, the finished segments and the
current position. v3 files are minified JSON of up to 44 MiB. A manuscript without
segment state or choice history still saves as v1 or v2, byte for byte as before,
when that fits in 1 MiB.

Opening a v3 file sends no request. A saved segment result is reused only when
the content hashes of the segment's source and target, the request inputs
(direction and alignment input) and the basis (rule version, dictionary schema
version, revision, source commit and term count, and matcher revision) all equal
the current ones. The current basis comes from one live review-v2 request with
`X-WuwaTerm-Matcher-Basis: 1`, which is the first request of the term run the
user starts after opening. Until it answers, saved results show as saved, not as
checked against the current service, and no choices are sent. An unchanged
manuscript with an unchanged basis costs that one request. Edited segments and
segments whose basis changed are checked again, also from the run button; a
finished mark survives a basis change. Document mode keeps the earlier rule: v1
choices and history and v2 semantic data are history until a fresh check.

A result JSON or Markdown export is not a resumable manuscript and not a backup.
Web 0.2.0 and Windows 0.4.2 reject v3 files with an explicit error.

### Dense reviews in v4

v1 to v3 cap every list of findings, choices and resolutions at 32. A client can ask
for more with the request header `X-WuwaTerm-Review-Features`: `dense-128` raises
the findings of one answer and the resolutions of one request to 128, and
`reason-v1` lets a `not_evaluated` finding say why (`not_a_term`, `ordinary_word`,
`no_target_region`, `found_outside_region`, `ambiguous_repeat`). The workbench
sends both on every review-v2 request, and only there. The BFF forwards the
header only when the client sent it (an unknown or repeated token, or a token on a
review-v1 request, is `site_invalid_request`), accepts up to 64 KiB for
`/api/reviews` (32 KiB everywhere else) and keeps 32 findings, 32 resolutions and
seven keys for a client that did not ask. A service that does not know the
features answers in the old shape, which is still read.

A manuscript that holds more than that, or a reason, is written as
`wuwaterm-manuscript-v4` ([specification](../contracts/manuscript-v4/SPEC.md)); one
that does not keeps v1, v2 or v3. Web 0.3.1 and Windows 0.5.1 reject v4 files with
an explicit error and keep the manuscript they already have open.

### Layered review and v5

The manuscript review pane has three layers. Layer 1, deterministic structure checks,
runs when the user starts it (`/api/structure-checks`, above): empty translations,
numbers, placeholders and tags, and paragraph and line layout, segment by segment.
Its findings are shown for the texts they were made for and dropped when a segment
changes; they are never written to a manuscript file, an export or browser storage.
Layer 2 is the experimental semantic review: high- and medium-confidence findings are
listed, low-confidence ones are folded at the end, and an unhandled issue that a
Layer 1 finding of its segment already describes (a missing number, placeholder or
translation) is not raised again; the list says how many it left out. Layer 3 is a
reserved place for style suggestions: off by default, it sends nothing.

When the service lists `ambiguous-mention-v1`, every review-v2 request also asks for it
(`X-WuwaTerm-Review-Features: dense-128,reason-v1,ambiguous-mention-v1`; the BFF
refuses it without `reason-v1`, as Core does, and accepts an `ambiguous_mention`
finding only on a request that asked for it). Core then reports a one-character
resonator name it could not settle as `not_evaluated` with the reason
`ambiguous_mention`. The workbench lists these after the judged findings, folded, and
does not count them as conflicts or problems; the user adopts a candidate pair (the
next check judges it) or ignores it as an ordinary word.

A manuscript whose results were made with that feature saves as
`wuwaterm-manuscript-v5` ([specification](../contracts/manuscript-v5/SPEC.md)), which
records the feature in `review_features`, so a result is reused only under the same
features. v5 also holds gap-tolerant segment records: when explicit alignments leave
text outside every span (an edit invalidated one alignment of many), the aligned
segments keep their results and only the gap becomes a segment that needs a manual
split, instead of the whole manuscript. Web 0.4.5 and the Windows client pinned in
`contracts/windows-ref.txt` reject v5 files with an explicit error and keep the
manuscript they already have open.

### Term groups

In long mode the term list groups every segment's findings by term: how many
places, which segments, the translation actually used at each place (for example
`Camellya ×2`, no hit ×1) and a status (inconsistent or in conflict, to do, not
evaluated, confirmed). A place from a saved result that this session has not yet
checked against the live dictionary and matcher basis is to do and says so, so a
reopened manuscript's groups never read confirmed, and stay out of that filter,
until the live basis makes their segments current. Each place shows its context
and can adopt an official pair, be marked not a term, be confirmed again, have
only that place replaced with a candidate, or, when the translation has no hit
there, open an editor for that one segment's translation; each is one undo step.
Segments that could not be paired automatically are counted in a banner above the
segment list, with a jump to the first one that needs a manual split.

## Semantic review workbench

Semantic review is an experimental Core feature that is off by default. The
public Site does not enable it; a self-hosted Core can turn it on explicitly.
The track appears only when `/api/capabilities` lists `semantic-review-v1`, and
then carries an "Experimental" label. Without it the workbench shows no semantic
panel and everything else works the same: term review (per segment for long
manuscripts), translation with previous-segment context and precedents when
`translation-context-v1` is listed, segment progress, manual splitting, import,
export and re-review. A v2 manuscript imported there keeps its semantic decisions
and writes them back unchanged. Issues are listed in two tracks: term constraints
(literal dictionary matches, deterministic, no model) and semantic issues (model
output, labelled as possibly wrong). They can be filtered by status, category and
segment. Each issue shows both excerpts, the model's reason, the suggestion and at
most one alternative as a strike-through preview, and a fixed note when the
suggestion changes or introduces an official term form. The user accepts, adjusts
or ignores one issue at a time; the workbench then moves to the next open issue.
There is no accept-all. A withheld suggestion (`span_too_long`,
`replacement_too_long`) offers only adjust and ignore, and every accept first
checks that the complete range still reads the same. `J`/`K` move between issues
and `Enter` selects the issue in the text box. Every handling step can be undone.

Segments are sent one at a time. A run can be paused and continued; a failed
segment can be retried on its own. Only `shared_pool_busy`, which the Site returns
before admitting (and charging) a request, waits for the stated time and then
continues by itself. Every failure after admission was already charged and is never
resent automatically: an upstream rate limit stops the run at that segment until the
user continues, a timeout or server error marks the segment failed for a manual
retry, and two consecutive identical failures stop the run. A used-up daily quota
pauses the run with finished segments kept. Segment translation assembles the text
in order, so it stops at any failed segment instead of skipping it. Within the same
session it can continue from the failed segment. After a partially translated
manuscript is reopened (either with explicit untranslated `alignments` or as an
unaligned partial prefix where translated paragraphs are fewer than source paragraphs),
batch translation can resume the remaining segments in sequence while keeping finished
translations and remapping/filling explicit `alignments`, and individual `untranslated` or
`ready` segments can also be translated/retranslated from the segment list with alignments
preserved and localized target edits remapped cleanly. Every run keeps
the direction it started with: a reply for another direction is not used.
Edits during a run never abort a request that is already charged; a result whose segment
text changed meanwhile is not used.

When the two sides cannot be paired (`needs_manual_split`), the segment list shows
both paragraph and sentence counts. One action turns every single line break into
a blank line on both sides, which resolves the most common cause (one side breaks
paragraphs with a single newline). A split helper lines paragraphs up by number,
marks rows whose length ratio is unlike the rest of the document, and inserts a
blank line between two sentences or merges two paragraphs with one click. When
both sides already have the same number of paragraphs, a split waits for the
matching place on the other side so the pairing is never broken half-way. Pairs
are never guessed; every step is an ordinary, undoable text edit.

Translation and review requests carry the previous segment (at most 400 scalars per side) as read-only
context and, by default, the manuscript's own human decisions before that
segment as occurrence-scoped precedents (Core ADR 0019); the user can turn
precedents off. A request over 32 KiB drops the furthest precedent first, then
shortens the context. Untranslated segments, and a blank translation of a long
source, can be translated segment by segment with the same context.
Semantic decisions are saved in manuscript v2 ([format](manuscript-v2.md));
exports list each issue with its handling status and keep
`sentence_meaning_evaluated: false`.

Import selection ownership follows a strict latest-selection policy: the latest chosen
file immediately supersedes any prior pending file read regardless of completion order.
If the latest file fails (oversize, unreadable, or invalid format), current manuscript work
is retained and that latest error is shown; obsolete earlier files never become a hidden
fallback. Starting an import read does not freeze editing or stop a running review. Newer
edits, choice/alignment changes, clears, undos, accepted handoffs, or newly initiated checks
invalidate the pending read to preserve newer intent. If an existing check finishes while a
file is reading, an accepted import captures that newly arrived report into its acceptance-time
undo snapshot. The file picker input resets synchronously upon selection so selecting the
same file again triggers immediate processing without interference from prior completions.

Sending a translation to review accepts an empty workbench directly. Sending
the same source, translation and direction again preserves choices, ranges,
reports, undo history and any running check. A different manuscript asks for
confirmation, defaulting to keeping the current work. Cancelling leaves the
current check running; confirming preserves a snapshot before replacing the
draft and stopping the old check. Undo restores the prior work and historical
reports, but a new explicit check is still required. Handoff and undo do not
send review requests automatically.

When a fresh check cannot locate a target term, a visible candidate can open a
local revision dialog. The user enters an exact translation fragment, explicitly
selects one occurrence and previews its replacement before confirming. This
changes only that occurrence; adopting an official pair and requesting another
service check remain separate actions. Choices and historical reports are kept,
the report becomes stale, and explicit non-overlapping alignment ranges are remapped
in place (failing closed only when an edit crosses an aligned boundary).

File reports are untrusted historical records, regardless of hashes or verdicts.
The first explicit check after import obtains fresh authoritative candidates.
Unchanged official choices can then be staged for a second explicit check;
an imported `not_a_term` decision always needs user confirmation. A source edit
can recover an occurrence only within an identical, unique whole source block;
changed, deleted or duplicate blocks cannot be guessed into new positions.
Direction, dictionary/rule basis or correspondence changes require confirmation.
Free-form text edits invalidate reports and clear previously explicit correspondences.
Partial candidate/source display does not prevent reusing a visible specific
candidate whose complete identity and fresh basis match. The next request still
validates that identity against the server's full snapshot; globally truncated
reports cannot restore choices automatically.

Users may confirm selected source/target ranges, including merged or split
sentences, or explicitly leave a source region unevaluated. Correspondences are
bounded non-overlapping scalar ranges with exact text. Without explicit ranges,
v2 uses decimal-aware sentence boundaries only when both sentence counts match.
Positional correspondence is a terminology-check scope, not proof of semantic
equivalence. Target occurrences cannot satisfy multiple source mentions.

Report comparison distinguishes new findings, positively resolved terminology
constraints, still-pending items and incomparable history. Only a fresh,
comparable positive check can resolve a prior conflict; disappearance,
global report truncation, omission and changed basis never mean resolved. Imported history
cannot establish resolution. Export includes current text and explicitly states
whether its report is current; no export certifies sentence meaning.
The findings list can be filtered by verdict, moved with previous/next, and
one finding can be the active item. Those controls are a local projection:
they do not call `/api/reviews`, and they do not change the report, choices,
manuscript, or export. Filter badges count findings of that verdict. They are
not `coverage.not_evaluated`, and the verified filter does not mean the
manuscript is current. Source and target jumps run only when the current text
still matches the report span exactly, converting Unicode scalar offsets to
the textarea's UTF-16 selection. A stale or edited manuscript keeps the
historical findings browsable and leaves an inexact jump disabled. Each
candidate can expand the `source_file` and `source_id` stored on that report.
That evidence is not the service's `/api/meta` dictionary provenance.
Each runtime report also records the decisions actually submitted. A changed
decision is incomparable, not a resolved old constraint. For a partially shown
candidate/source list, only the identical explicitly selected, visible candidate
under the same full basis can support a resolved terminology constraint;
automatic partial evidence and globally truncated reports remain incomparable.

The endpoint remains `/v1/reviews`: absent `review_version` retains the original
v1 request/response and segmentation behavior. The Site opts into `review-v2`,
which adds candidate identities and a content-derived dictionary revision from
one read snapshot. Nonempty choices require current source/rule/dictionary
context and are checked against the authoritative snapshot. The Site performs
one upstream call per admitted explicit check; save/import/edit/select/compare
and export perform none. Deploy the dual-protocol API before the v2 Site;
roll back the Site to its v1 version before reverting the API.
`review-v2` stays the request protocol. Its default response retains the old
key set and omits `matcher_revision`. Without a capability header, nonempty
three-key resolution contexts remain fresh when source, rule, and dictionary
revisions match. An explicitly supplied matcher revision must also match.

The new Site sends `X-WuwaTerm-Matcher-Basis: 1` on v2 upstream requests.
Only that exact value opts into reports carrying `matcher_revision`, a separate
identity for the ordinary-word span rule. In this mode a nonempty resolution
context must carry the current matcher revision; omission or mismatch is stale.
Other header values are invalid for v2; v1 ignores the header and omits the field.
Deploy the compatible API first, then the Site that sends this header. Roll back
that Site first, while the new API still accepts legacy three-key resolutions,
then revert the API. A historical manuscript still imports, but a kept span
whose saved basis lacks the new matcher is `basis_changed` on the new Site.

The dictionary also carries two free-text lock exclusion metadata keys,
`free_text_lock_exclusions` and `free_text_lock_exclusions_zh`, recording
corpus evidence that a surface is usually an ordinary word: it is locked
at least ten times in official text while the parallel official line
carried the official form in under one fifth of those lines. `review-v2`
consumes the same evidence for a different purpose than sentence locking,
which keeps its own behavior. An unresolved mention of such a surface
keeps its finding and every candidate but is returned `not_evaluated`
with no target span, so it consumes no target occurrence. 未评估 with
candidates means selectable, not asserted: the presence of an official
form in the target alone does not verify it. An explicit `official_pair`
resolution still runs the authoritative check — verified with the exact
target span, `confirmed_conflict`, or `not_evaluated` per the existing
rules — while `not_a_term` records user intent, not official verification.

A report whose findings are all such mentions reaches
`coverage.evaluated = 0`, and the exports then show the zero-coverage
line. That is honest: nothing was evaluated, and zero findings or zero
evaluation never means the translation passed. In report comparison, a
finding downgraded from `needs_review` or `verified_constraint` to
`not_evaluated` is classified incomparable, never resolved. A database
without these keys behaves as if no surface were excluded from automatic
assessment; an invalid key is ignored with one warning naming that key
only, while the other key still applies.

This is an automatic-assessment policy change and nothing else:
`rule_version` stays `review-v2`, and the exclusion metadata is not part
of the content-derived term-row dictionary revision. The request
protocol, candidate identity, matcher-basis behavior and the deployment
ordering above are unchanged by it.

## Interface language and report exports

The interface is bilingual (Chinese and English). The choice is a single
`wuwaterm-lang` preference cookie (`zh`/`en`, one year, no other value),
read server-side so the first paint matches the saved choice; first visits
default to Chinese and any missing translation falls back to Chinese copy.
Switching languages re-renders copy only: it never rewrites the manuscript,
user input, terms, proper nouns, source evidence or the translation
direction, keeps the active finding, expansions and report currency, and
sends no translation, review or meta request. Browser tests check that the
language choice is the only cookie and that exercised workbench state is not
written to browser storage. The client-secret scan checks emitted artifacts.

Downloads remain local: the manuscript JSON (`wuwaterm-manuscript-v1`, `-v2`, `-v3` or `-v4`,
the lowest that holds the work), the result JSON (`wuwaterm-result-v2`), the translation TXT, and a readable
Markdown snapshot of the full report (`wuwaterm-report.md`). The Markdown is
generated from the current workbench state without requests and without
state changes; it lists every finding unfiltered with spans, excerpts,
official candidate pairs and their source records, the report's own rule
version, dictionary revision, source commit, revisions and request id (never
the application version), coverage including zero-coverage semantics,
truncation flags, submitted decisions, kept local choices with honest
status, and the previous-report comparison. Current, stale-edited and
imported-untrusted reports are worded differently and never merged; zero
findings does not mean the translation passed, and no export certifies
sentence meaning. User text in the Markdown is literal (code spans and
fences that grow past any backtick run), so report structure, links and
HTML cannot be forged by manuscript content.

## Shared pool contract

There is no per-visitor, per-IP or personal fair-use allowance. A single caller
can exhaust the entire pool. D1 stores one singleton row of aggregate counters:
second/minute/day window numbers and admitted request/input counts. It never
stores or derives visitor identifiers, IPs, hashes, input, output, request IDs,
accounts or history. No cleanup scheduler is required: the row is overwritten
as active windows advance; inactive old aggregate windows can remain until
another admission. This is not a time-based deletion promise.

| Boundary | Public beta ceiling |
| --- | --- |
| All upstream routes combined | 6 admissions / fixed UTC minute; 1 / UTC second |
| Translation | 1 admission / fixed UTC minute |
| Terms | 240 admissions / UTC day |
| Translation | 30 admissions and 12,000 raw Unicode characters / UTC day |
| Optional meta | 60 admissions / UTC day |
| Review | 60 admissions / UTC day; does not increment translation or character counters |
| Inputs | query <=200 trimmed Unicode characters; translation <=2,000 raw characters; review source and target each <=2,000 raw characters; streamed body <=32,768 bytes |

Terms, translations and reviews have independent daily counters. Disabling translation,
exhausting its count or character pool, or VPS model unavailability does not
disable terms or reviews. An available snapshot includes `reviews` in the same
shape as `terms`; it is a shared snapshot, not a personal reserve; a response
that omits the key is not a complete quota snapshot. Terms can still be busy under the total short window, its own
daily cap or infrastructure failure.

One atomic conditional SQLite UPSERT checks and increments all applicable
counters. No read-then-write race or partial multi-counter reservation.
Database clock determines the windows. Admission precedes exactly one BFF
fetch. There is no automatic retry or refund on error, cancellation, ambiguous
DB response or upstream timeout. Missing/invalid settings, missing D1, failed
queries and acquisition exceeding 1s fail closed, with no upstream call.
Rejected requests do not count as admitted requests.

Public beta ceilings reserve headroom against the upstream
device contract, including adjacent fixed-window bursts and dispatch delay.
The extra second gate reduces bursts. Network delay and other users of the
same credential can still produce upstream 429; upstream admission remains
authoritative. The values shown by the live Site are a changing snapshot, not
demonstrated sustainable throughput or an availability promise.

The pool limits admitted upstream work and translation input. It does not
guarantee a currency bill, fairness, availability, DDoS resistance, bounded
inbound Worker/D1 requests, or a shared budget across the API and Telegram
processes. A <=2,000-character client request uses the existing single model
attempt path, when dictionary-first processing requires it.

## Runtime configuration

Existing secret values stay server-only in the Sites environment. Never put
them in hosting metadata, browser code, source control, evidence or URLs.

| Variable | Contract |
| --- | --- |
| `WUWATERM_API_BASE_URL` | Existing pinned HTTPS mount; unchanged |
| `WUWATERM_API_ALLOWED_HOST` | Existing exact lower-case hostname; unchanged |
| `WUWATERM_SITE_DEVICE_TOKEN` | Existing dedicated device; unchanged |
| `WUWATERM_SHARED_POOL_ENABLED` | Must explicitly equal `true`; otherwise all upstream requests fail closed |
| `WUWATERM_TRANSLATION_ENABLED` | `true` enables the current public translation surface; `false` pauses translations while preserving the independent lookup pool |
| `WUWATERM_PUBLIC_ORIGIN` | Exact approved HTTPS Sites origin with no trailing slash, credentials, path, port or query; enables canonical/OG/robots/sitemap metadata |

`.openai/hosting.json` declares logical `DB` only; no real database ID or
secret. `db/schema.ts`, `drizzle.config.ts` and generated `drizzle/` migrations
own schema changes. Runtime never creates/alters tables. Sites owns production
resources and applies migrations. A failed deployment can leave migrations
applied: inspect the applied boundary before retrying and never edit applied
migration history.

The current public origin publishes canonical, robots and sitemap metadata. The
origin never derives from request or forwarded hosts. All API responses remain
no-store/noindex and public UI errors use fixed copy.

## Validation and operations

From this repository root:

~~~sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm run verify:no-client-secret
~~~

Tests include proxy failure/secret contracts, real SQLite boundary fixtures and
a genuine local Cloudflare D1/Worker concurrency test using a synthetic upstream.
They do not prove a current Hosted deployment, physical VPS binding, model
reliability or public uptime. Browser acceptance and live probes are separate
evidence and must be labelled with their observation time.

Any later change to the public slug, platform access control, D1/environment,
saved version, credentials, translation switch or deployment remains a separate
owner-authorized action. Read the exact current object before changing it and
retain rollback/readback evidence. Turning off translation preserves the
independent lookup pool; never clear live counters as a recovery shortcut.

Historical owner-only, M0, runner-blocked and private-acceptance records remain
historical evidence. The current public beta does not rewrite them into success
or prove steps that those runs left unresolved. See the original
[shared-only design](https://github.com/My-Denia/WuwaTerm/blob/3c51ca340f0e5c1dc0c0cf4e32ff6703af9ba841/docs/superpowers/specs/2026-09-02-wuwaterm-shared-beta.md).
