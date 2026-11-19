// Synthetic manuscripts and review-v2 answers for the term-group browser specs and the viewport screenshots.
// Public game terms only (椿 / Camellya, 声骸 / Echo, 今汐 / Jinhsi, 调谐器 / Tuner) and generic filler; nothing from a real manuscript.
import { createHash } from 'node:crypto';
import { FRESH_MATCHER_REVISION } from '../fixtures/manuscript.mjs';

const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const scalars = text => Array.from(text);
const sourceOf = (term, n) => ({ source_file: 'synthetic/terms.json', source_id: `${term}-${n}` });
const term = (zh, en, category) => ({ zh, en, category, candidate_id: sha(`term-group:${zh}:${en}:${category}`), sources: [sourceOf(en.toLowerCase().replace(/\W+/gu, '-'), 1)] });
export const CAMELLYA = term('椿', 'Camellya', 'character');
export const JINHSI = term('今汐', 'Jinhsi', 'character');
export const ECHO = term('声骸', 'Echo', 'item');
export const TUNER = term('调谐器', 'Tuner', 'item');
export const DICTIONARY = { schema_version: '2', source_commit: 'synthetic-term-groups', term_count: 1204, revision: sha('dictionary:term-groups') };

// ---- generic filler, so a segment is long enough to stand alone ----
const ZH_BANK = ['他们沿着荒原继续前行。', '风从远处的山脊吹来。', '夜里的营火慢慢暗了下来。', '没有人再提起那件旧事。', '远方传来低沉的钟声。', '她把地图折好放进袋中。', '天亮之前必须赶到渡口。', '路上的石头被雨水冲得发亮。'];
const EN_BANK = ['They kept walking along the wasteland.', 'The wind came in from the distant ridge.', 'The campfire slowly burned low in the night.', 'Nobody mentioned the old affair again.',
  'A deep bell sounded somewhere far away.', 'She folded the map and put it in her bag.', 'They had to reach the ferry before dawn.', 'The stones on the road shone with rain.'];
export const zhFiller = (sentences = 100) => Array.from({ length: sentences }, (_, k) => ZH_BANK[k % ZH_BANK.length]).join('');
export const enFiller = (sentences = 30) => Array.from({ length: sentences }, (_, k) => EN_BANK[k % EN_BANK.length]).join(' ');
const paragraphs = list => list.join('\n\n');

/**
 * A zh→en manuscript (direction `en`) of four ready segments and a fifth that cannot be paired: the Camellya terms in the first three
 * (two verified, one without a hit, a 香椿 and a 红椿蕊 that Core does not evaluate), 声骸 in the fourth.
 */
export function camellyaManuscript({ withMismatch = true } = {}) {
  const leads = [
    ['椿站在声骸旁，今汐微微点头。', 'Camellya stood beside the Echo, and Jinhsi nodded slightly.'],
    ['椿回头看了一眼。香椿的味道很好。', 'The traveler turned back. The Toon sprouts smelled good.'],
    ['红椿蕊落在地上，椿又笑了。', 'The red camellia stamen fell, and Camellya smiled again.'],
    ['声骸安静下来。', 'The sound fell quiet.'],
  ];
  const source = leads.map(([zh]) => `${zh}${zhFiller(100)}`);
  const target = leads.map(([, en]) => `${en} ${enFiller(30)}`);
  if (withMismatch) {
    // Both sides far over the segment limit with different sentence counts: segmentation-v1 cannot pair them and asks for a manual split.
    source.push(zhFiller(320));
    target.push(enFiller(110));
  }
  return { source: paragraphs(source), target: paragraphs(target), direction: 'en' };
}

/** An en→zh manuscript (direction `zh`): the Tuner is 调谐器 twice and 调音师 once (not the official rendering), and 调音师 stands once more elsewhere. */
export function tunerManuscript() {
  const leads = [
    ['The Tuner hums softly.', '调谐器轻轻地嗡鸣。'],
    ['She asked the Tuner for help.', '她向调音师求助。'],
    ['Another Tuner waited outside.', '另一台调谐器在外面等着。'],
  ];
  const source = leads.map(([en]) => `${en} ${enFiller(30)}`);
  // A 调音师 in the third translation that is not a Tuner place at all: replacing one place must leave it alone.
  const target = leads.map(([, zh], i) => `${zh}${zhFiller(100)}${i === 2 ? '后来调音师也来了。' : ''}`);
  return { source: paragraphs(source), target: paragraphs(target), direction: 'zh' };
}

function finding(id, span, targetSpan, verdict, candidate, reason) {
  return {
    id, rule_id: 'review.term_pair', verdict, source_span: span, target_span: targetSpan,
    candidates: [{ zh: candidate.zh, en: candidate.en, category: candidate.category, candidate_id: candidate.candidate_id, sources: candidate.sources }],
    candidates_truncated: false, ...(reason ? { reason } : {}),
  };
}

/**
 * The BFF's review-v2 answer for one segment request: every official term found in the source, in text order. A term takes the next
 * translation of it in the target, in order; none found is needs_review (a Tuner rendered 调音师 is a conflict with its own target
 * span), and a 香椿 or 红椿蕊 match is not evaluated, with its reason.
 */
export function termGroupReport(body, { requestId = 'synthetic-term-groups' } = {}) {
  const source = scalars(body.source);
  const target = body.target;
  const text = body.source;
  const zhSource = body.direction === 'en';
  const terms = zhSource ? [CAMELLYA, JINHSI, ECHO] : [TUNER];
  const used = new Map();
  const findings = [];
  const positions = [];
  for (const candidate of terms) {
    const needle = zhSource ? candidate.zh : candidate.en;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) positions.push({ candidate, needle, at });
  }
  positions.sort((a, b) => a.at - b.at);
  for (const { candidate, needle, at } of positions) {
    const start = scalars(text.slice(0, at)).length;
    const span = { start, end: start + scalars(needle).length, text: needle };
    const id = `${span.start}:${span.end}:${needle}`;
    const before = source[start - 1];
    if (candidate === CAMELLYA && before === '香') { findings.push(finding(id, span, null, 'not_evaluated', candidate, 'not_a_term')); continue; }
    if (candidate === CAMELLYA && before === '红') { findings.push(finding(id, span, null, 'not_evaluated', candidate, 'ordinary_word')); continue; }
    const forms = zhSource ? [candidate.en] : [candidate.zh, '调音师'];
    const from = used.get(candidate.zh) ?? 0;
    const hits = forms.map(form => ({ form, at: target.indexOf(form, from) })).filter(h => h.at >= 0).sort((a, b) => a.at - b.at);
    const hit = hits[0];
    if (!hit) {
      findings.push(candidate === ECHO ? finding(id, span, null, 'not_evaluated', candidate, 'no_target_region') : finding(id, span, null, 'needs_review', candidate));
      continue;
    }
    used.set(candidate.zh, hit.at + hit.form.length);
    const targetStart = scalars(target.slice(0, hit.at)).length;
    const targetSpan = { start: targetStart, end: targetStart + scalars(hit.form).length, text: hit.form };
    findings.push(finding(id, span, targetSpan, hit.form === '调音师' ? 'confirmed_conflict' : 'verified_constraint', candidate));
  }
  const notEvaluated = findings.filter(f => f.verdict === 'not_evaluated').length;
  return {
    request_id: requestId, source_revision: sha(body.source), target_revision: sha(body.target), rule_version: 'review-v2', matcher_revision: FRESH_MATCHER_REVISION,
    dictionary: { ...DICTIONARY }, coverage: { evaluated: findings.length - notEvaluated, not_evaluated: notEvaluated, rules: ['review.term_pair', 'review.sentence_meaning'] },
    findings, truncated: false,
  };
}
