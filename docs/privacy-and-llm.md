# Public Web privacy boundary

Backend processing and operator configuration remain documented in the
[backend privacy guide](https://github.com/My-Denia/WuwaTerm/blob/main/docs/privacy-and-llm.md).

## Anonymous Public Beta Site

The no-account public beta is
<https://wuwaterm.denia-official.chatgpt.site>. Its browser sends terms and
sentences only to same-origin `/api/*`; the Hosted server-side proxy forwards
them to the authoritative VPS `/v1` API with a credential that never enters the
browser. Dictionary-first processing and term locking remain backend behavior,
not a second implementation in the Site.

Semantic review is experimental and off by default (not enabled on the public
Site). Where a self-hosted service turns it on, it sends both the source segment and its translation, plus the
optional previous-segment context and human precedents you chose, to the
service's model. The Site does not store or log them. Translation may likewise
send optional context when the service supports it.

The WuwaTerm application does not create visitor profiles or history and does
not read, parse, store or infer visitor IP addresses. Its shared-pool row stores
aggregate time windows, admitted request counts and translation input-character
totals — not input, output, request IDs, browser identifiers or per-person
allowances. Results remain in the current page. The review workbench asks before
link navigation when that page cannot restore the work from the manuscript
imported in the visit. Cross-page links load full documents, so Back, Forward
and reload request the browser's own warning; cancelling keeps the current work.
The site cannot confirm a manuscript download reached disk, and a crash or
forced quit can still discard the page.

That application boundary is not a promise that every infrastructure layer has
zero logs or retention. Hosting, network transport and the configured model
provider may process technical data for operation, security or fault diagnosis.
Do not submit personal information, passwords, tokens or other sensitive text.
The shared beta is first-come, has no per-visitor fairness guarantee and no SLA;
see [Public Beta Site](sites.md) and the live
[privacy notice](https://wuwaterm.denia-official.chatgpt.site/privacy).
