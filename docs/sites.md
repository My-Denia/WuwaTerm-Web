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
  `/api/translations`, `/api/reviews`, `/api/capabilities`, `/api/semantic-reviews`
  and the on-demand `/api/meta`; the server-side proxy holds the device credential and
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
(`semantic-review-v1`, `translation-context-v1`). The probe is not charged to
the shared pool and its result is cached for a few minutes. An old service that
answers 404 is treated as listing nothing. `/api/semantic-reviews` sends one
paired segment to the service's model only when the service lists
`semantic-review-v1`. It is charged as one translation, with characters equal to
the longer side, and so shares the translation switch and daily allowance. When
the service does not list it, the Site answers 503 `semantic_review_unavailable`
without charging anything. The public Site's Core does not list
`semantic-review-v1` (the feature is experimental and off by default), so on the
public Site this path is idle.

Optional `/api/meta` is not requested when the page loads. Opening 「词典版本」
asks once for the dictionary the running service reports: database schema
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

## Resumable bilingual manuscripts

The review workbench saves a user-initiated `wuwaterm-manuscript-v1` JSON file
(`wuwaterm-manuscript-v2` once it holds semantic decisions or history).
It contains source, target, direction, up to 32 occurrence-specific decisions,
their dictionary/rule/candidate basis, explicit scalar correspondences and the
last two reports. Import is local and bounded to 1 MiB; it never sends a request.
Undoing an import restores the prior manuscript and its historical reports; it still requires an explicit fresh check.
There are no accounts, cloud manuscripts, automatic uploads or browser-storage
history. The user must download and later import the file to resume. The page
can show whether current work still matches the latest manuscript download or
the file imported in this visit, but it cannot confirm that download reached
disk. Link departures ask first when the work cannot be restored from that
imported file. Cross-page links use full document navigation so browser Back,
Forward and reload request the browser's own warning. Cancelling retains the
manuscript, decisions and reports. A crash or forced quit can still discard the page.

The 2,000-character review request limit does not restrict manuscript storage:
long translations can be saved and reopened intact within the 1 MiB file cap.
A manuscript over the limit is paired into segments with `segmentation-v1`
(Core's rules and fixtures; at most 1,800 scalars per side) and checked one
segment at a time. Term results of a long manuscript are read-only: they can
be located but per-occurrence term choices still need a manuscript within the
limit. Both replacement actions refuse edits that would exceed the review limit
without changing the draft.

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
in order, so it stops at any failed segment instead of skipping it. Every run keeps
the direction it started with: a reply for another direction is not used.

Per-segment term results of a long manuscript are not written to the manuscript
file: the format's report history holds two reports of at most 2,000 characters,
and changing it would break the current WuwaTerm-Windows reader. The page says so;
the results are in the current-result and Markdown exports. Edits
during a run never abort a request that is already charged; a result whose segment
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
the report becomes stale, and confirmed alignment ranges need reconfirmation.

File reports are untrusted historical records, regardless of hashes or verdicts.
The first explicit check after import obtains fresh authoritative candidates.
Unchanged official choices can then be staged for a second explicit check;
an imported `not_a_term` decision always needs user confirmation. A source edit
can recover an occurrence only within an identical, unique whole source block;
changed, deleted or duplicate blocks cannot be guessed into new positions.
Direction, dictionary/rule basis or correspondence changes require confirmation.
Text edits invalidate reports and clear previously explicit correspondences.
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

Downloads remain local: the manuscript JSON (`wuwaterm-manuscript-v1`), the
result JSON (`wuwaterm-result-v2`), the translation TXT, and a readable
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
