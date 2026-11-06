# WuwaTerm Web

The public WuwaTerm workbench: official-term lookup, term-locked translation,
review of existing translations, and resumable local manuscripts. The browser
uses a same-origin proxy; authoritative terminology and translation logic remain
in the [Python backend](https://github.com/My-Denia/WuwaTerm).

Public beta: <https://wuwaterm.denia-official.chatgpt.site>. This is a shared,
best-effort pool with no SLA or per-visitor fairness guarantee.

The same workbench can also run privately on your own host with a configured
Core API and an authenticated HTTPS reverse proxy. See the
[self-hosting guide](docs/self-hosting.md) for the standalone and Docker paths.

The workbench cannot confirm the download reached disk. Link departures ask first
when work cannot be restored from the imported manuscript. Cross-page links load
a full document, so Back, Forward and reload use the browser's own warning.
Cancelling leaves the current manuscript, decisions and reports in place.
A crash or forced quit can also discard the page. See the
[privacy boundary](docs/privacy-and-llm.md) and [product guide](docs/sites.md).

## Development and verification

Use Node 24 and npm 11.6.2, then run:

```sh
npm ci --no-audit
npm audit --json
npm test
npm run typecheck
npm run lint
npm run build
npm run verify:no-client-secret
npm run test:built
npx playwright install chromium
WUWATERM_BROWSER_BUILT=1 npm run test:browser
```

`npm run dev` starts local development. Tests use synthetic upstream responses
and local D1 storage; they do not consume production quota. Details and limits
of the evidence are in [tests/README.md](tests/README.md).

## Backend compatibility and delivery

[contracts/backend-ref.txt](contracts/backend-ref.txt) pins the producer checked
by CI. The contract job checks real Python `/v1/meta` responses through this
repository's BFF and compares dictionary label keys and desktop Chinese labels.
With that backend checked out locally:

```sh
WUWATERM_BACKEND_ROOT=/path/to/backend npm run test:contract
cd /path/to/backend
WUWATERM_WEB_ROOT=/path/to/web python -m pytest -m cross_component tests/test_meta_site_contract.py
```

The backend checkout needs its documented Python development dependencies.
Changes to strict response shapes require coordinated consumer/producer PRs;
adding a `/v1` field is not automatically compatible with the strict BFF.
See [cross-repository delivery](docs/cross-repository-delivery.md).

Work remains coordinated through the existing WuwaTerm Project and its
[unified GitHub entry](https://github.com/users/My-Denia/projects/1). Do not
create a parallel authoritative backlog. The Core repository owns authoritative
translation, terminology review, HTTP API, dictionary construction/validation
and common deployment/recovery tools. [Telegram](https://github.com/My-Denia/WuwaTerm-Telegram)
and [Windows](https://github.com/My-Denia/WuwaTerm-Windows) own their product
source and delivery, reusing the pinned Core package and protected HTTP API
respectively. Public and self-hosted Web use this same workbench; Sites is its
hosting target. Repository and release status is recorded separately from
production adoption.

## Source and hosting

This repository starts from the tracked `site/` tree at backend commit
`3c51ca340f0e5c1dc0c0cf4e32ff6703af9ba841`. Every original file blob is recorded
in [migration/source.json](migration/source.json); earlier history remains in
the backend repository. Extraction adapts the test paths and adds repository
CI and documentation. It does not establish a new production deployment.

The existing `.openai/hosting.json` resource binding is preserved. Publishing,
credential changes and production migrations are separate operations. Never
commit credentials, generated dictionaries, upstream game data or production logs.

Source code is MIT licensed. Game data and terminology are not redistributed.
