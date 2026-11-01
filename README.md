# WuwaTerm Web

The public WuwaTerm workbench: official-term lookup, term-locked translation,
review of existing translations, and resumable local manuscripts. The browser
uses a same-origin proxy; authoritative terminology and translation logic remain
in the [Python backend](https://github.com/My-Denia/WuwaTerm).

Public beta: <https://wuwaterm.denia-official.chatgpt.site>. This is a shared,
best-effort pool with no SLA or per-visitor fairness guarantee.

The workbench cannot confirm the download reached disk. Ordinary navigation
and refresh ask first when work cannot be restored from the imported manuscript;
a crash or forced quit can still discard the page. See the
[privacy boundary](docs/privacy-and-llm.md) and [product guide](docs/sites.md).

## Development and verification

Use Node 24 and npm 11.6.2, then run:

```sh
npm ci
npm audit --json
npm audit --omit=dev --json
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

Work remains coordinated through the existing Linear WuwaTerm Project. Do not
create a parallel authoritative backlog. Python core, API, Bot, dictionary
builder and VPS tools stay in the backend repository; Windows stays there too.

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
