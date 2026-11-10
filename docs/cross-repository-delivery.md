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

Current pins: `contracts/windows-ref.txt` is `9010190cd8dfbbb75c241a4caf21bacabc10826c`
(WuwaTerm-Windows PR #3, which reads and writes `wuwaterm-manuscript-v2`), so the Web and
Windows manuscript contract test now exchanges v2 files in both directions: every valid
`contracts/manuscript-v2/` fixture, a Web-written file and a Windows-built file are read by
the other side, and every invalid fixture is rejected by both. `contracts/backend-ref.txt`
stays `7122ea7cb41e5987aac80b23fc27bd071fcfa22b` (Core PR #198, which added the
`semantic-review-v1` and `segmentation-v1` contracts). To do: raise `backend-ref.txt` to the
Core commit that implements the semantic review engine once that PR is merged, and record
the resulting producer and consumer SHAs.

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
opt-in `matcher_revision` hash and `wuwaterm-manuscript-v1` format distinct.
The matcher hash is requested with `X-WuwaTerm-Matcher-Basis: 1`; it is not
a report field named `matcher_basis`. Their actual validators and fixtures are the
contracts; a manuscript import is not fresh certification against the live DB.

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
