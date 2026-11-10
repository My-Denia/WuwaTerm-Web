// Synthetic local routes and page helpers for the semantic review browser specs.
// Every /api request is fulfilled here; nothing reaches a real service or model.
import { expect } from '@playwright/test';
import { fixture, freshApiReport } from '../fixtures/manuscript.mjs';
import { capabilitiesBody, defaultSemanticResponse, semanticResponse } from './semantic-fixture.mjs';
import { semanticMsg } from '../../lib/semantic-messages.ts';

export const BASE = process.env.WUWATERM_BROWSER_URL ?? '';
export const S = semanticMsg('zh');
export const SE = semanticMsg('en');
export const fill = (template, params) => template.replace(/\{(\w+)\}/gu, (_, key) => (key in params ? String(params[key]) : `{${key}}`));
export const FULL = ['semantic-review-v1', 'translation-context-v1'];

export const poolBody = ({ reviews = 60, translations = 100, characters = 100000 } = {}) => ({
  status: 'available', translation_enabled: true,
  terms: { used: 0, limit: 100, remaining: 100 },
  translations: { used: 100 - translations, limit: 100, remaining: translations },
  characters: { used: 0, limit: 100000, remaining: characters },
  reviews: { used: 60 - reviews, limit: 60, remaining: reviews },
  reset_at: '2099-01-01T00:00:00Z',
});

export const failure = (status, reason, extra = {}) => ({ status, body: { status: 'unavailable', reason, ...extra } });
export const busy = () => failure(429, 'shared_pool_busy', { retry_after_seconds: 5 });

/**
 * Installs the routes. Options:
 *  capabilities: string[] | 'not-found' | 'network-error'   (default FULL)
 *  pool: arguments for poolBody
 *  failures: { [callNumber]: {status, body} }   semantic-review failures by 1-based call number
 *  respond: async (request, callNumber) => response | undefined   replaces the default plan
 *  delayMs: per semantic request latency
 *  translate: (body, callNumber) => string
 * Returned recorder: semantic / translations / reviews (request bodies), maxInflight,
 * gate(n) -> {release} holding semantic call n open until released.
 */
export async function installRoutes(page, options = {}) {
  const { capabilities = FULL, pool = {}, failures = {}, respond, delayMs = 0, translate, translateFailures = {} } = options;
  const rec = { semantic: [], translations: [], reviews: [], capabilityCalls: 0, inflight: 0, maxInflight: 0, gates: new Map() };
  rec.gate = n => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    rec.gates.set(n, held);
    return { release };
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/pool') return route.fulfill({ json: poolBody(pool) });
    if (path === '/api/capabilities') {
      rec.capabilityCalls++;
      if (capabilities === 'not-found') return route.fulfill({ status: 404, json: { status: 'unavailable', reason: 'not_found' } });
      if (capabilities === 'network-error') return route.abort('failed');
      return route.fulfill({ json: capabilitiesBody(capabilities) });
    }
    if (path === '/api/semantic-reviews') {
      const body = route.request().postDataJSON();
      rec.semantic.push(body);
      const n = rec.semantic.length;
      rec.inflight++; rec.maxInflight = Math.max(rec.maxInflight, rec.inflight);
      try {
        if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        const held = rec.gates.get(n);
        if (held) await held;
        if (failures[n]) return await route.fulfill({ status: failures[n].status, json: failures[n].body });
        const custom = respond ? await respond(body, n) : undefined;
        return await route.fulfill({ json: custom ?? await defaultSemanticResponse(body) });
      } finally { rec.inflight--; }
    }
    if (path === '/api/reviews') {
      const body = route.request().postDataJSON();
      rec.reviews.push(body);
      return route.fulfill({ json: freshApiReport(fixture(body.source, body.target, body.direction).report) });
    }
    if (path === '/api/translations') {
      const body = route.request().postDataJSON();
      rec.translations.push(body);
      const failed = translateFailures[rec.translations.length];
      if (failed) return route.fulfill({ status: failed.status, json: failed.body });
      const text = translate ? translate(body, rec.translations.length) : `Translated ${rec.translations.length}.`;
      return route.fulfill({ json: { kind: 'exact', text, direction: body.to ?? 'en', dictionary_miss: false, request_id: 'synthetic-translation' } });
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  return rec;
}

export async function openWorkbench(page, options = {}) {
  const rec = await installRoutes(page, options);
  await page.goto(BASE + '/');
  await expect(page.locator('.review-quota')).toContainText('/ 60', { timeout: 30_000 });
  await expect.poll(() => rec.capabilityCalls, { timeout: 15_000 }).toBeGreaterThan(0);
  return rec;
}

export async function switchTo(page, language) {
  const button = page.locator(`.lang-toggle button:text-is("${language}")`);
  await expect(async () => {
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }).toPass({ timeout: 10_000 });
}

export async function fillPair(page, source, target) {
  await page.locator('#review-source').fill(source);
  await page.locator('#review-target').fill(target);
}

export async function downloadFrom(page, name) {
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const download = await waiting;
  const stream = await download.createReadStream();
  const parts = [];
  for await (const part of stream) parts.push(part);
  return { name: download.suggestedFilename(), text: Buffer.concat(parts).toString('utf-8') };
}

/** Move focus off any button so the J/K/Enter shortcuts apply. */
export const blurFocus = page => page.evaluate(() => document.activeElement && document.activeElement.blur());

// ---- synthetic manuscripts ----
/** A Chinese paragraph of about 1,100 scalars made of distinct short sentences. */
export const zhParagraph = (i, sentences = 80) => Array.from({ length: sentences }, (_, k) => `第${i}段第${k + 1}句是合成句子。`).join('');
/** An English paragraph of about 1,150 scalars. */
export const enParagraph = (i, sentences = 34) => Array.from({ length: sentences }, (_, k) => `Paragraph ${i} line ${k + 1} is synthetic. `).join('').trim();
export const longPair = (n = 6) => ({
  paragraphs: n,
  source: Array.from({ length: n }, (_, i) => zhParagraph(i + 1)).join('\n\n'),
  target: Array.from({ length: n }, (_, i) => enParagraph(i + 1)).join('\n\n'),
});

/** Scalar range of the first occurrence of needle (BMP-only texts, so UTF-16 equals scalars). */
export const rng = (text, needle, from = 0) => {
  const at = text.indexOf(needle, from);
  if (at < 0) throw new Error(`needle not found: ${needle}`);
  return [at, at + needle.length];
};
export { semanticResponse, defaultSemanticResponse };

// ---- a short pair with three model issues (quantity, negation, time) ----
export const TRIO = { source: '她看见三只鸟。他没有来。我们明天出发。', target: 'She saw two birds. He came. We leave today.' };
/** respond() for TRIO: each issue replaces its target word; the first also has an alternative. */
export const trioResponse = (overrides = {}) => async request => {
  const plan = [
    { category: 'quantity_change', src: '三只', tgt: 'two', replacement: 'three', alternative: 'several' },
    { category: 'negation_change', src: '没有', tgt: 'came', replacement: 'did not come' },
    { category: 'meaning_shift', src: '明天', tgt: 'today', replacement: 'tomorrow' },
  ];
  const specs = plan.map((p, i) => {
    const o = overrides[i] ?? {};
    const target = rng(request.target, p.tgt);
    return { category: p.category, source: rng(request.source, p.src), target, confidence: 'high', alternative: p.alternative,
      withheld: o.withheld ?? null, suggestion: { target, replacement: p.replacement, term_effect: o.term_effect ?? 'none' } };
  });
  return semanticResponse(request, specs);
};
