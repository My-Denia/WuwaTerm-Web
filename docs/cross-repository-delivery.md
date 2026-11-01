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

Keep `/v1`, report `schema_version`, `matcher_basis` and
`wuwaterm-manuscript-v1` distinct. Their actual validators and fixtures are the
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
