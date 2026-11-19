# Cross-repository delivery

The Web repository owns the browser, same-origin BFF, Node dependencies and
hosting build. The backend repository owns authoritative matching, application
logic, HTTP API, Bot, builder and VPS operations. Linked PRs implement changes
that cross this boundary; the existing Linear WuwaTerm Project tracks the result.

## Contract checks

The Web CI pins the backend using `contracts/backend-ref.txt`; the backend CI
pins a Web commit independently. A passing pair proves compatibility for those
two commits, not arbitrary future releases. Update pins in reviewed PRs and
record the producer and consumer SHAs. Do not replace a SHA with a moving branch.

Current pins: `contracts/backend-ref.txt` is
`9a4f680f3ec3909e23afc2394f2c7eccf00af6e3` (Core PR #279: the MY-355 attribution fixes, the
MY-356 `dense-128`/`reason-v1` review-v2 features with the 64 KiB review body, and the
MY-359 regroup guard). It was raised from `d5c35d299dc8c6d467b8e3a2f8c6b03cf2720a45` (Core
PR #199, the semantic review engine: semantic review is experimental and off unless
`WUWATERM_SEMANTIC_REVIEW_ENABLED=1`, and `translation-context-v1` is always listed when a
model is configured), which was raised from `7122ea7cb41e5987aac80b23fc27bd071fcfa22b`
(Core PR #198, the contracts) by Web PR #16.
`contracts/windows-ref.txt` names the Windows commit the manuscript contract runs against.
It moves to the Windows 0.6.0 merge commit when that release lands, the first consumer that
reads and writes `wuwaterm-manuscript-v4`.

The Web and Windows manuscript contract test exchanges manuscripts in every format in both
directions: the Unicode v1 case, every valid `contracts/manuscript-v2/`,
`contracts/manuscript-v3/` and `contracts/manuscript-v4/` fixture, is read alike by both and written back to its canonical
bytes, every invalid fixture is rejected by both with its code, the explicit-alignments
fixture gets the same alignment input digests, and a long manuscript with choices, a
target-only edit and progress, built by each client's own runtime, gives the same v3 bytes
and is kept unchanged by the other. The v4 cases take their expectation from
`contracts/windows-ref.txt` itself: a consumer that implements v3 only (Windows 0.5.1)
must still give each file the v3 code, and Windows 0.6.0 must read and write every one of
them, so raising the pin is the whole change.

The dense review contract runs against the live pinned Core, not a recorded body: the
contract suite starts the Core's own application object on a loopback socket and sends a
`/api/reviews` request through the real parser and BFF, once with
`X-WuwaTerm-Review-Features: dense-128,reason-v1` and once without it, including a body
above 32 KiB. Both features are a consumer-side opt-in, and the BFF reads a dense answer
and the published 32-finding one, so the Web works against a Core with them and against one
without.

The meta contract sends actual Python API response bodies through the real BFF.
The label contract compares the Python category/reason keys and existing Windows
Chinese labels with Web projections. Web-only unit and browser tests do not need
a backend checkout. Missing contract inputs fail the explicit contract command.

The BFF rejects unapproved response keys. An additive API change can therefore
break an older consumer. Keep the public allowlist; decide the order for each
schema change. For a consumer accepting an expanded shape, release that compatible
consumer first. For matcher/report capabilities required by a new consumer,
release a backward-compatible API first, then the Web. Roll back in reverse order
only while the paired versions remain compatible. Do not assume these two cases
have the same deployment order.

Keep the `/v1` API path, report `rule_version`, dictionary `schema_version`,
opt-in `matcher_revision` hash and the `wuwaterm-manuscript-v1`, `-v2`, `-v3` and
`-v4` formats distinct.
The matcher hash is requested with `X-WuwaTerm-Matcher-Basis: 1`; it is not
a report field named `matcher_basis`. Their actual validators and fixtures are the
contracts. A document-mode import (v1 choices and history, v2 semantic data) is not
fresh certification against the live DB. A v3 segment result is reused only when
its content hashes, request inputs and all six basis values equal the current ones,
where the current basis comes from a live review-v2 request
([contract](../contracts/manuscript-v3/SPEC.md)).

Web 0.2.0 and Windows 0.4.2 reject v3 files; Web 0.3.1 and Windows 0.5.1 reject v4
files. Cross-client v3 and v4 interchange is verified against the Windows client pinned
in `contracts/windows-ref.txt`.

## Deployment receipt

Reuse the existing Site source-blob receipt and backend deployment manifest.
For an authorized release, record the combination in one receipt:

- Web repository full SHA, build/hosting version and source-blob mapping.
- API repository full application SHA and actual container image identity.
- Dictionary SHA256 and its upstream provenance.
- API/report schema, matcher basis and manuscript format observed in the pair.
- Exact contract-test pair, acceptance evidence and rollback pair.

Dictionary `source_commit` describes upstream game data, not the API application.
Updating a service image does not prove that the host updater script changed.
A commit or green CI does not prove that the deployed product adopted it.

The extraction receipt is `migration/source.json`. It identifies imported source,
not a new hosting release. No deployment or production mutation is part of this
repository migration. Credentials stay on the hosting platform and VPS.
