# WuwaTerm Web project rules

This is the public Web workbench repository. Python core, API, Bot, dictionary
builder, Windows client and VPS deployment tools belong to My-Denia/WuwaTerm.
Keep the existing Linear WuwaTerm Project as the shared task authority.

Use conventional work-based branches and prefer signed commits. Changes go through
pull requests, current-head CI and review, then squash merge. Do not push normal
changes directly to main, force-push, or add AI co-author trailers. Resolve only
confirmed in-scope findings; record pre-existing or unrelated findings separately.

Validation: Node 24, npm 11.6.2; npm ci --no-audit; npm audit --json; npm test;
npm run typecheck; npm run lint; npm run build; npm run verify:no-client-secret;
npm run test:built; WUWATERM_BROWSER_BUILT=1 npm run test:browser.
The contract job also installs the pinned backend and runs real API-to-BFF and
label checks. Keep strict response filtering and record both repository SHAs.

Do not send test Telegram messages or use live production quota for tests.
Do not commit credentials, private endpoints, identifiable logs, generated
term databases or upstream game data. Inspect every outgoing diff.
Repository work does not authorize production deployment, resource rebinding,
credential changes or database migrations. Preserve the existing hosting binding.

## Review guidelines

Flag only what breaks real behaviour, data or secrets. Do not ask for extra
tests, process or defensive code.

- A change that makes a production secret, private endpoint or user text reach
  the client bundle, logs or an outgoing request it should not.
- The same-origin proxy (BFF) breaking against the real backend: a `/v1`
  response shape or dictionary label key that the strict response filtering
  now drops, rejects or passes through unfiltered.
- Silent loss of user work: manuscripts, imports, exports or term-locked
  translations that are corrupted, truncated or discarded without the existing
  unsaved-work prompts.
- Review or translation output that ignores locked official terms or reports
  success on a failed upstream call.
- Tests or scripts that start consuming live production quota or send Telegram
  messages.
