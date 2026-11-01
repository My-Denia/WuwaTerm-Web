# WuwaTerm Web project rules

This is the public Web workbench repository. Python core, API, Bot, dictionary
builder, Windows client and VPS deployment tools belong to My-Denia/WuwaTerm.
Keep the existing Linear WuwaTerm Project as the shared task authority.

Use conventional work-based branches and signed commits. Changes go through
pull requests, current-head CI and review, then squash merge. Do not push normal
changes directly to main, force-push, or add AI co-author trailers. Resolve only
confirmed in-scope findings; record pre-existing or unrelated findings separately.
Clean merged local branches and worktrees after recording restore SHAs and
confirming ancestry or patch equivalence. Preserve unrelated dirty files.

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
