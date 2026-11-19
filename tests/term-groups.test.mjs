import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as L from '../lib/long-review.js';
import { REASON_VALUES, parseWorkfile, serializeWorkfile } from '../lib/manuscript.js';
import { hash } from './fixtures/manuscript.mjs';

// Term groups and the single-place edits of the long-manuscript term view (lib/long-review.js). Public game terms and synthetic text.

const scalars = text => Array.from(text);
const camellya = { candidate_id: hash('camellya'), zh: '椿', en: 'Camellya', category: 'character' };
const tunerA = { candidate_id: hash('tuner-a'), zh: '调谐器', en: 'Tuner', category: 'item' };
const tunerB = { candidate_id: hash('tuner-b'), zh: '调音师', en: 'Tuner', category: 'character' };
const echo = { candidate_id: hash('echo'), zh: '声骸', en: 'Echo', category: 'item' };

function spanOf(text, needle, nth = 0) {
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1);
  assert.ok(at >= 0, `${needle} #${nth}`);
  const start = scalars(text.slice(0, at)).length;
  return { start, end: start + scalars(needle).length, text: needle };
}
// One segment whose cores are the texts themselves. `find` lists [needle, nth, verdict, targetNeedle, targetNth, candidates, extra].
function segment(index, state, source, target, find, choices = [], offset = { source: 0, target: 0 }) {
  const findings = find.map(([needle, nth, verdict, targetNeedle, targetNth = 0, candidates = [camellya], extra = {}]) => {
    const span = spanOf(source, needle, nth);
    return { id: `${span.start}:${span.end}:${needle}`, verdict, source_span: span, target_span: targetNeedle ? spanOf(target, targetNeedle, targetNth) : null,
      candidates, candidates_truncated: false, ...extra };
  });
  return {
    index, state, source_start: offset.source, source_end: offset.source + scalars(source).length, target_start: offset.target,
    target_end: offset.target + scalars(target).length, report: { findings }, choices,
  };
}
const choice = (span, kind, candidate, confirmed, view) => ({
  source_span: span, choice: kind, candidate: kind === 'official_pair' ? candidate : null, offered: [], confirmed, ...(view ? { view } : {}),
});

const SOURCE = '椿站在声骸旁边。香椿很好吃。椿回头看了看。';
const TARGET = 'Camellya stood beside the Echo. Toon is tasty. She looked back.';

test('a group counts its places, names the segments and tallies what the translation used, with no hit counted', () => {
  const segments = [segment(0, 'current', SOURCE, TARGET, [
    ['椿', 0, 'verified_constraint', 'Camellya'], ['椿', 1, 'not_evaluated', null, 0, [camellya], { reason: 'not_a_term' }], ['椿', 2, 'needs_review', null],
  ])];
  const groups = L.groupTermOccurrences(segments, SOURCE, TARGET, 'en');
  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.equal(group.surface, '椿');
  assert.equal(group.occurrenceCount, 3);
  assert.deepEqual(group.segments, [1]);
  assert.deepEqual(group.renderings, [{ text: 'Camellya', count: 1 }, { text: null, count: 2 }].sort((a, b) => b.count - a.count));
  assert.equal(group.notEvaluated, 1);
  assert.deepEqual(group.candidates, [camellya]);
  // Places are in text order, with the whole-text spans, the translation used and the not_evaluated reason.
  assert.deepEqual(group.occurrences.map(o => o.docSource.start), [0, 8, 14].map(n => scalars(SOURCE).indexOf('椿', n === 0 ? 0 : n - 1)).map((_, i) => group.occurrences[i].docSource.start));
  assert.deepEqual(group.occurrences.map(o => o.docSource.text), ['椿', '椿', '椿']);
  assert.deepEqual(group.occurrences.map(o => o.translation), ['Camellya', null, null]);
  assert.deepEqual(group.occurrences.map(o => o.reason), [null, 'not_a_term', null]);
  assert.deepEqual(group.occurrences.map(o => o.segmentNumber), [1, 1, 1]);
});

test('Camellya x2 and no hit x1 is inconsistent until every place is decided; a homograph that is not a term stays out of the way', () => {
  const find = [['椿', 0, 'verified_constraint', 'Camellya'], ['椿', 2, 'verified_constraint', 'Camellya', 0], ['椿', 1, 'needs_review', null]];
  const segments = [segment(0, 'current', SOURCE, TARGET, find)];
  const [group] = L.groupTermOccurrences(segments, SOURCE, TARGET, 'en');
  assert.deepEqual(group.renderings, [{ text: 'Camellya', count: 2 }, { text: null, count: 1 }]);
  assert.equal(group.status, 'inconsistent');
  // Every place has a confirmed choice that applies: confirmed.
  const decided = (view = 'applies') => [0, 1, 2].map(nth => choice(spanOf(SOURCE, '椿', nth), 'official_pair', camellya, true, view));
  assert.equal(L.groupTermOccurrences([segment(0, 'current', SOURCE, TARGET, find, decided())], SOURCE, TARGET, 'en')[0].status, 'confirmed');
  // The same choices waiting for the next check: decided, not yet in force: pending.
  assert.equal(L.groupTermOccurrences([segment(0, 'stale', SOURCE, TARGET, find, decided('waiting'))], SOURCE, TARGET, 'en')[0].status, 'pending');
  // One place decided and the others not: still inconsistent.
  const one = [choice(spanOf(SOURCE, '椿', 1), 'not_a_term', null, true, 'applies')];
  assert.equal(L.groupTermOccurrences([segment(0, 'current', SOURCE, TARGET, find, one)], SOURCE, TARGET, 'en')[0].status, 'inconsistent');
  // The place with no hit marked not a term and a pair adopted at the others: no longer inconsistent, and not pending.
  const rest = [0, 1, 2].map(nth => (nth === 1 ? one[0] : choice(spanOf(SOURCE, '椿', nth), 'official_pair', camellya, true, 'applies')));
  assert.equal(L.groupTermOccurrences([segment(0, 'current', SOURCE, TARGET, find, rest)], SOURCE, TARGET, 'en')[0].status, 'confirmed');
});

test('Tuner x2 and a second Chinese rendering x1; the status of a conflict, an unconfirmed choice, a stale segment and no evaluation', () => {
  const source = 'Tune the Tuner. The Tuner hums. Ask the Tuner.';
  const target = '调整调谐器。调谐器在嗡嗡响。问问调音师。';
  const find = [['Tuner', 0, 'verified_constraint', '调谐器', 0, [tunerA, tunerB]], ['Tuner', 1, 'verified_constraint', '调谐器', 1, [tunerA, tunerB]], ['Tuner', 2, 'verified_constraint', '调音师', 0, [tunerA, tunerB]]];
  const [group] = L.groupTermOccurrences([segment(0, 'current', source, target, find)], source, target, 'zh');
  assert.deepEqual(group.renderings, [{ text: '调谐器', count: 2 }, { text: '调音师', count: 1 }]);
  assert.equal(group.status, 'inconsistent');
  assert.equal(group.candidates.length, 2);
  // A confirmed_conflict that no choice settles is inconsistent even with one rendering.
  const conflict = [['Tuner', 0, 'confirmed_conflict', '调音师', 0, [tunerA]]];
  assert.equal(L.groupTermOccurrences([segment(0, 'current', source, target, conflict)], source, target, 'zh')[0].status, 'inconsistent');
  // Verified, one rendering: confirmed. The same in a stale segment, with an unconfirmed choice, or with a needs_review: pending.
  const verified = [['Tuner', 0, 'verified_constraint', '调谐器', 0, [tunerA]]];
  assert.equal(L.groupTermOccurrences([segment(0, 'current', source, target, verified)], source, target, 'zh')[0].status, 'confirmed');
  assert.equal(L.groupTermOccurrences([segment(0, 'stale', source, target, verified)], source, target, 'zh')[0].status, 'pending');
  assert.equal(L.groupTermOccurrences([segment(0, 'saved', source, target, verified)], source, target, 'zh')[0].status, 'confirmed');
  const unconfirmed = [choice(spanOf(source, 'Tuner', 0), 'official_pair', tunerA, false, 'needs_reconfirmation')];
  assert.equal(L.groupTermOccurrences([segment(0, 'current', source, target, verified, unconfirmed)], source, target, 'zh')[0].status, 'pending');
  assert.equal(L.groupTermOccurrences([segment(0, 'current', source, target, [['Tuner', 0, 'needs_review', null, 0, [tunerA]]])], source, target, 'zh')[0].status, 'pending');
  // Nothing evaluated: not_evaluated, with its reason, and a decision on it settles it.
  const unevaluated = [['Tuner', 0, 'not_evaluated', null, 0, [tunerA], { reason: 'ambiguous_repeat' }]];
  assert.equal(L.groupTermOccurrences([segment(0, 'current', source, target, unevaluated)], source, target, 'zh')[0].status, 'not_evaluated');
  const notATerm = [choice(spanOf(source, 'Tuner', 0), 'not_a_term', null, true, 'applies')];
  assert.equal(L.groupTermOccurrences([segment(0, 'current', source, target, unevaluated, notATerm)], source, target, 'zh')[0].status, 'confirmed');
});

test('English singular and plural surfaces merge only when they share a candidate set; a Chinese surface never merges', () => {
  const source = 'The Tuner and the Tuners. A tuner too.';
  const target = '调谐器和调谐器们。还有调谐器。';
  const same = [['Tuner', 0, 'verified_constraint', '调谐器', 0, [tunerA]], ['Tuners', 0, 'verified_constraint', '调谐器', 1, [tunerA]], ['tuner', 0, 'verified_constraint', '调谐器', 2, [tunerA]]];
  const merged = L.groupTermOccurrences([segment(0, 'current', source, target, same)], source, target, 'zh');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].occurrenceCount, 3);
  assert.equal(merged[0].surface, 'Tuner', 'the surface used most, then the first one seen');
  assert.deepEqual([...merged[0].surfaces].sort(), ['Tuner', 'Tuners', 'tuner'], 'every spelling that was merged, as written');
  assert.equal(merged[0].occurrences.length, 3, 'tuner and Tuner are one surface; Tuners is the plural');
  // Different candidate sets: two groups. (A plural of a different term is not folded into the singular.)
  const different = [['Tuner', 0, 'verified_constraint', '调谐器', 0, [tunerA]], ['Tuners', 0, 'verified_constraint', '调谐器', 1, [tunerB]]];
  assert.equal(L.groupTermOccurrences([segment(0, 'current', source, target, different)], source, target, 'zh').length, 2);
  // Chinese source: the same surface is one group, a longer surface another (红椿蕊 is not 椿).
  const zh = '椿看着红椿蕊。';
  const zhGroups = L.groupTermOccurrences([segment(0, 'current', zh, 'Camellya looked at the red camellia stamen.', [
    ['椿', 0, 'verified_constraint', 'Camellya'], ['红椿蕊', 0, 'not_evaluated', null, 0, [camellya], { reason: 'ordinary_word' }],
  ])], zh, 'Camellya looked at the red camellia stamen.', 'en');
  assert.deepEqual(zhGroups.map(g => g.surface).sort(), ['椿', '红椿蕊'].sort());
});

test('a place carries about 36 scalars of context on each side, whole-text spans, and a target excerpt when there is no hit', () => {
  const lead = Array.from({ length: 80 }, (_, i) => `前${i}`).join('');
  const source = `${lead}椿站在这里。${Array.from({ length: 80 }, (_, i) => `后${i}`).join('')}`;
  const target = `${Array.from({ length: 30 }, (_, i) => `Sentence ${i}.`).join(' ')}`;
  const offset = { source: 0, target: 0 };
  const [group] = L.groupTermOccurrences([segment(0, 'current', source, target, [['椿', 0, 'needs_review', null]], [], offset)], source, target, 'en');
  const [place] = group.occurrences;
  assert.equal(scalars(place.sourceContext.before).length, L.GROUP_CONTEXT_RADIUS);
  assert.equal(place.sourceContext.hit, '椿');
  assert.equal(place.sourceContext.clippedBefore, true);
  assert.equal(place.sourceContext.clippedAfter, true);
  assert.ok(L.GROUP_CONTEXT_RADIUS >= 28 && L.GROUP_CONTEXT_RADIUS <= 48);
  assert.equal(place.targetContext, null);
  assert.ok(place.targetExcerpt && place.targetExcerpt.text.length > 0 && place.targetExcerpt.approximate === true, 'the target side is never blank');
  assert.match(place.targetExcerpt.text, /^Sentence \d+\.$/u);
  // With a hit, the target has a context and no excerpt.
  const [hit] = L.groupTermOccurrences([segment(0, 'current', source, target, [['椿', 0, 'verified_constraint', 'Sentence 0']])], source, target, 'en')[0].occurrences;
  assert.equal(hit.targetExcerpt, null);
  assert.equal(hit.targetContext.hit, 'Sentence 0');
  assert.equal(hit.translation, 'Sentence 0');
  // A segment that does not start at 0: the whole-text spans shift, the core-relative ones do not.
  const doc = `第一段。\n\n${source}`;
  const docTarget = `First.\n\n${target}`;
  const shifted = segment(1, 'current', source, target, [['椿', 0, 'verified_constraint', 'Sentence 0']], [], { source: scalars('第一段。\n\n').length, target: scalars('First.\n\n').length });
  const [at] = L.groupTermOccurrences([shifted], doc, docTarget, 'en')[0].occurrences;
  assert.equal(at.segmentIndex, 1);
  assert.equal(at.segmentNumber, 2);
  assert.equal(at.coreSource.start, 80 * 0 + scalars(lead).length);
  assert.equal(at.docSource.start, at.coreSource.start + scalars('第一段。\n\n').length);
  assert.equal(scalars(doc).slice(at.docSource.start, at.docSource.end).join(''), '椿');
  assert.equal(scalars(docTarget).slice(at.docTarget.start, at.docTarget.end).join(''), 'Sentence 0');
});

test('groups are ordered by urgency, then by where they first stand', () => {
  const source = '声骸在前。椿在后。';
  const target = 'The Echo first. Camellya after.';
  const segments = [segment(0, 'current', source, target, [['声骸', 0, 'verified_constraint', 'Echo', 0, [echo]], ['椿', 0, 'needs_review', null]])];
  assert.deepEqual(L.groupTermOccurrences(segments, source, target, 'en').map(g => [g.surface, g.status]), [['椿', 'pending'], ['声骸', 'confirmed']]);
});

test('spliceTargetSpan replaces one place only, never every place the same word stands', () => {
  const target = 'Camellya met Camellya. 椿 and 椿。';
  const second = spanOf(target, 'Camellya', 1);
  const out = L.spliceTargetSpan(target, second, 'Camellya Prime');
  assert.equal(out.target, 'Camellya met Camellya Prime. 椿 and 椿。');
  assert.deepEqual(out.span, { start: second.start, end: second.start + scalars('Camellya Prime').length, text: 'Camellya Prime' });
  // The homograph: only the picked 椿.
  const zh = L.spliceTargetSpan(target, spanOf(target, '椿', 1), '今汐');
  assert.equal(zh.target, 'Camellya met Camellya. 椿 and 今汐。');
  // Astral scalars before the span: positions are scalars, not UTF-16 units.
  const astral = '\u{20BB7}\u{20BB7}Tuner and Tuner';
  const picked = spanOf(astral, 'Tuner', 1);
  assert.equal(L.spliceTargetSpan(astral, picked, '调谐器').target, '\u{20BB7}\u{20BB7}Tuner and 调谐器');
  // The text no longer reads what the finding saw there, the same text, a blank or a lone surrogate: an error, no change.
  assert.equal(L.spliceTargetSpan('Camellya met Echo', second, 'X').error, 'span_mismatch');
  assert.equal(L.spliceTargetSpan(target, second, 'Camellya').error, 'noop');
  assert.equal(L.spliceTargetSpan(target, second, '   ').error, 'replacement_invalid');
  assert.equal(L.spliceTargetSpan(target, second, '\uD800').error, 'replacement_invalid');
  assert.equal(L.spliceTargetSpan(target, { start: 5, end: 99, text: 'x' }, 'X').error, 'span_mismatch');
  // No length cap of document mode: a long target is fine.
  const long = `${'A '.repeat(5000)}Camellya`;
  assert.equal(L.spliceTargetSpan(long, spanOf(long, 'Camellya'), 'Jinhsi').target.endsWith('Jinhsi'), true);
});

test('reviseSegmentTarget swaps one segment core and keeps the layout around it', () => {
  const target = 'Core one.\n\nCore two.\n\nCore three.';
  const core = 'Core two.';
  const start = scalars('Core one.\n\n').length;
  const range = { start, end: start + scalars(core).length };
  assert.equal(L.reviseSegmentTarget(target, range, core, 'Second paragraph, revised.').target, 'Core one.\n\nSecond paragraph, revised.\n\nCore three.');
  assert.equal(L.reviseSegmentTarget(target, range, core, core).error, 'noop');
  assert.equal(L.reviseSegmentTarget(target, range, core, '  ').error, 'text_blank');
  assert.equal(L.reviseSegmentTarget(target, range, core, 'x'.repeat(2001)).error, 'text_too_long');
  assert.equal(L.reviseSegmentTarget(target, range, core, 'x'.repeat(2000)).target.length > 2000, true);
  assert.equal(L.reviseSegmentTarget(target, range, 'Core TWO.', 'x').error, 'core_mismatch');
  assert.equal(L.reviseSegmentTarget(target, { start: 3, end: 999 }, core, 'x').error, 'core_mismatch');
});

test('a not_evaluated reason survives compacting, expanding and the v4 file, and a bad one is not storable', () => {
  const source = '椿，声骸。';
  const target = 'Camellya, Echo.';
  const report = reasons => ({
    request_id: 'req', source_revision: L.contentHash(source), target_revision: L.contentHash(target), rule_version: 'review-v2', matcher_revision: 'c'.repeat(64),
    dictionary: { schema_version: '2', source_commit: 'synthetic', term_count: 2, revision: 'd'.repeat(64) },
    coverage: { evaluated: 1, not_evaluated: 1, rules: ['review.term_pair', 'review.sentence_meaning'] },
    findings: [
      { id: '0:1:椿', rule_id: 'review.term_pair', verdict: 'verified_constraint', source_span: spanOf(source, '椿'), target_span: spanOf(target, 'Camellya'), candidates: [{ ...camellya, sources: [] }], candidates_truncated: false },
      { id: '2:4:声骸', rule_id: 'review.term_pair', verdict: reasons.verdict ?? 'not_evaluated', source_span: spanOf(source, '声骸'), target_span: null, candidates: [{ ...echo, sources: [] }], candidates_truncated: false, ...reasons.extra },
    ], truncated: false,
  });
  for (const reason of REASON_VALUES) {
    const compact = L.compactResult(report({ extra: { reason } }));
    assert.deepEqual(compact.findings[1], { verdict: 'not_evaluated', source: [2, 4], target: null, candidates: [echo], candidates_truncated: false, reason });
    assert.deepEqual(Object.keys(compact.findings[1]).at(-1), 'reason');
    assert.equal(Object.hasOwn(compact.findings[0], 'reason'), false);
    const record = { source_hash: L.contentHash(source), target_hash: L.contentHash(target), basis: L.basisOfReport(report({ extra: { reason } })), result: compact };
    const expanded = L.expandResult(record, source, target);
    assert.equal(expanded.findings[1].reason, reason);
    assert.deepEqual(Object.keys(expanded.findings[1]).slice(-2), ['candidates_truncated', 'reason']);
    assert.deepEqual(L.compactResult(expanded), compact);
  }
  assert.equal(L.compactResult(report({ extra: { reason: 'nope' } })), null);
  assert.equal(L.compactResult(report({ extra: { reason: null } })), null);
  assert.equal(L.compactResult(report({ verdict: 'needs_review', extra: { reason: 'not_a_term' } })), null);
  // 128 findings are storable, 129 are not.
  const many = n => ({ ...report({ extra: {} }), findings: Array.from({ length: n }, (_, i) => ({ ...report({ extra: {} }).findings[0], id: `${i}:${i + 1}:椿`, source_span: { start: i, end: i + 1, text: '椿' }, target_span: null })) });
  assert.equal(L.compactResult(many(128)).findings.length, 128);
  assert.equal(L.compactResult(many(129)), null);
  assert.equal(L.MAX_SEGMENT_CHOICES, 128);
});

test('the dense v4 fixture opens into groups: 椿 places across segments, five reasons, and a pending group while the choices wait for a check', () => {
  const parsed = parseWorkfile(readFileSync(new URL('../contracts/manuscript-v4/valid-v4-segments-dense.json', import.meta.url), 'utf8'));
  const draft = { source: parsed.source, target: parsed.target, direction: parsed.direction, alignments: parsed.alignments };
  const long = L.longFromWorkfile(parsed);
  const ctx = { draft, basis: null };
  const segments = L.termSegments(long, ctx);
  assert.deepEqual(segments.map(x => [x.index, x.state]), [[1, 'saved'], [2, 'saved']].map(([i, st]) => [i, long.records[i].status === 'stale' ? 'stale' : st]));
  const groups = L.groupTermOccurrences(segments, draft.source, draft.target, 'en');
  const camellyaGroup = groups.find(g => g.surface === '椿');
  assert.equal(camellyaGroup.occurrenceCount, 123 + 2 + 33);
  assert.deepEqual(camellyaGroup.segments, [2, 3]);
  assert.deepEqual(camellyaGroup.renderings, [{ text: 'Camellya', count: 123 + 33 }, { text: null, count: 2 }]);
  assert.equal(camellyaGroup.status, 'pending', 'the choices wait for the next check');
  assert.deepEqual(groups.flatMap(g => g.occurrences).filter(o => o.reason).map(o => o.reason).sort(), [...REASON_VALUES].sort());
  assert.equal(groups.every(g => g.occurrences.every(o => o.sourceContext && o.sourceContext.hit === o.docSource.text)), true);
  // The same state written and read again keeps every reason (v4).
  const again = serializeWorkfile({ ...parsed, ...L.workfileParts(long, draft, { basis: null }) });
  assert.equal(JSON.parse(again).format, 'wuwaterm-manuscript-v4');
  assert.equal(JSON.parse(again).segments[1].result.findings.filter(f => Object.hasOwn(f, 'reason')).length, 5);
});
