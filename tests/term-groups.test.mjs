import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as L from '../lib/long-review.js';
import { REASON_VALUES, parseWorkfile, serializeWorkfile } from '../lib/manuscript.js';
import { hash } from './fixtures/manuscript.mjs';
import { camellyaManuscript } from './helpers/term-group-fixture.mjs';

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
  // The place Core did not evaluate is no miss of the term: it is counted apart, last.
  assert.deepEqual(group.renderings, [{ text: 'Camellya', count: 1, kind: 'hit' }, { text: null, count: 1, kind: 'none' }, { text: null, count: 1, kind: 'not_evaluated' }]);
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
  assert.deepEqual(group.renderings, [{ text: 'Camellya', count: 2, kind: 'hit' }, { text: null, count: 1, kind: 'none' }]);
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
  assert.deepEqual(group.renderings, [{ text: '调谐器', count: 2, kind: 'hit' }, { text: '调音师', count: 1, kind: 'hit' }]);
  assert.equal(group.status, 'inconsistent');
  assert.equal(group.candidates.length, 2);
  // A confirmed_conflict that no choice settles is inconsistent even with one rendering.
  const conflict = [['Tuner', 0, 'confirmed_conflict', '调音师', 0, [tunerA]]];
  assert.equal(L.groupTermOccurrences([segment(0, 'current', source, target, conflict)], source, target, 'zh')[0].status, 'inconsistent');
  // Verified, one rendering: confirmed. The same in a stale segment or in a saved one this session has not checked against the live
  // basis, with an unconfirmed choice, or with a needs_review: pending.
  const verified = [['Tuner', 0, 'verified_constraint', '调谐器', 0, [tunerA]]];
  assert.equal(L.groupTermOccurrences([segment(0, 'current', source, target, verified)], source, target, 'zh')[0].status, 'confirmed');
  assert.equal(L.groupTermOccurrences([segment(0, 'stale', source, target, verified)], source, target, 'zh')[0].status, 'pending');
  assert.equal(L.groupTermOccurrences([segment(0, 'saved', source, target, verified)], source, target, 'zh')[0].status, 'pending');
  const unconfirmed = [choice(spanOf(source, 'Tuner', 0), 'official_pair', tunerA, false, 'needs_reconfirmation')];
  assert.equal(L.groupTermOccurrences([segment(0, 'current', source, target, verified, unconfirmed)], source, target, 'zh')[0].status, 'pending');
  assert.equal(L.groupTermOccurrences([segment(0, 'current', source, target, [['Tuner', 0, 'needs_review', null, 0, [tunerA]]])], source, target, 'zh')[0].status, 'pending');
  // Nothing evaluated: not_evaluated, with its reason, and a decision on it settles it.
  const unevaluated = [['Tuner', 0, 'not_evaluated', null, 0, [tunerA], { reason: 'ambiguous_repeat' }]];
  assert.equal(L.groupTermOccurrences([segment(0, 'current', source, target, unevaluated)], source, target, 'zh')[0].status, 'not_evaluated');
  const notATerm = [choice(spanOf(source, 'Tuner', 0), 'not_a_term', null, true, 'applies')];
  assert.equal(L.groupTermOccurrences([segment(0, 'current', source, target, unevaluated, notATerm)], source, target, 'zh')[0].status, 'confirmed');
});

test('a saved result is to do until the live basis makes it current: saved, current and stale on the same 椿 -> Camellya data', () => {
  const source = '椿站在这里。';
  const target = 'Camellya stood here.';
  const verified = [['椿', 0, 'verified_constraint', 'Camellya']];
  const group = state => L.groupTermOccurrences([segment(0, state, source, target, verified)], source, target, 'en')[0];

  // Reopened before the live check: the place and the translation used are still shown, but the group waits and says so.
  const saved = group('saved');
  assert.equal(saved.status, 'pending');
  assert.equal(saved.pendingCount, 1);
  assert.equal(saved.confirmedCount, 0);
  assert.equal(saved.savedCount, 1);
  assert.equal(saved.occurrences[0].freshness, 'saved');
  assert.equal(saved.occurrences[0].attention, 'pending');
  assert.deepEqual(saved.renderings, [{ text: 'Camellya', count: 1, kind: 'hit' }]);
  // The live check agreed with the saved basis: current, and only then confirmed.
  const current = group('current');
  assert.deepEqual([current.status, current.pendingCount, current.confirmedCount, current.savedCount], ['confirmed', 0, 1, 0]);
  // The live check says the saved result is out of date: pending again, and nothing is left of the saved basis.
  const stale = group('stale');
  assert.deepEqual([stale.status, stale.pendingCount, stale.confirmedCount, stale.savedCount], ['pending', 1, 0, 0]);
  // The filters follow the status: saved and stale are under to do with their place, only current is under confirmed.
  assert.deepEqual(L.termGroupCounts([saved]), { all: 1, inconsistent: 0, pending: 1, not_evaluated: 0, confirmed: 0 });
  assert.deepEqual(L.termGroupCounts([current]), { all: 1, inconsistent: 0, pending: 0, not_evaluated: 0, confirmed: 1 });
  assert.deepEqual(L.termGroupCounts([stale]), { all: 1, inconsistent: 0, pending: 1, not_evaluated: 0, confirmed: 0 });
  for (const [, g] of [['saved', saved], ['current', current], ['stale', stale]]) {
    const counts = L.termGroupCounts([g]);
    for (const f of L.TERM_GROUP_FILTERS) assert.equal(L.filterTermGroups([g], f).length, counts[f], f);
  }
  assert.equal(L.filterTermGroups([saved], 'pending')[0].occurrences[0].freshness, 'saved');
  assert.deepEqual(L.filterTermGroups([saved], 'confirmed'), []);
  assert.equal(L.filterTermGroups([current], 'confirmed').length, 1);
  assert.deepEqual(L.filterTermGroups([current], 'pending'), []);

  // A confirmed not_a_term at a saved place is the user's decision, and it still waits for the live check: saved, not settled.
  const notATerm = [choice(spanOf(source, '椿'), 'not_a_term', null, true, 'applies')];
  const unevaluated = [['椿', 0, 'not_evaluated', null, 0, [camellya], { reason: 'not_a_term' }]];
  const savedNotATerm = L.groupTermOccurrences([segment(0, 'saved', source, target, unevaluated, notATerm)], source, target, 'en')[0];
  assert.deepEqual([savedNotATerm.status, savedNotATerm.pendingCount, savedNotATerm.confirmedCount, savedNotATerm.savedCount], ['pending', 1, 0, 1]);
  // The same decision on a current result settles the place.
  const currentNotATerm = L.groupTermOccurrences([segment(0, 'current', source, target, unevaluated, notATerm)], source, target, 'en')[0];
  assert.deepEqual([currentNotATerm.status, currentNotATerm.pendingCount, currentNotATerm.confirmedCount], ['confirmed', 0, 1]);
  // A confirmed choice that applies at a saved place does not settle it either; the same choice on a current place does.
  const adopted = [choice(spanOf(source, '椿'), 'official_pair', camellya, true, 'applies')];
  const savedAdopted = L.groupTermOccurrences([segment(0, 'saved', source, target, verified, adopted)], source, target, 'en')[0];
  assert.deepEqual([savedAdopted.occurrences[0].attention, savedAdopted.status, savedAdopted.pendingCount], ['pending', 'pending', 1]);
  const currentAdopted = L.groupTermOccurrences([segment(0, 'current', source, target, verified, adopted)], source, target, 'en')[0];
  assert.deepEqual([currentAdopted.occurrences[0].attention, currentAdopted.status], ['settled', 'confirmed']);
  // A confirmed conflict stays the more urgent trait of a saved group, and it is still to do.
  const conflict = L.groupTermOccurrences([segment(0, 'saved', source, target, [['椿', 0, 'confirmed_conflict', 'Camellya']])], source, target, 'en')[0];
  assert.deepEqual([conflict.status, conflict.pendingCount, conflict.savedCount, conflict.occurrences[0].attention], ['inconsistent', 1, 1, 'conflict']);
  assert.equal(L.filterTermGroups([conflict], 'pending').length, 1);

  // One current place and one saved place of the same surface: the saved place keeps the group from reading confirmed, and the to do
  // filter shows that place, not the checked one.
  const docSource = `${source}\n\n${source}`;
  const docTarget = `${target}\n\n${target}`;
  const [mixed] = L.groupTermOccurrences([
    segment(0, 'current', source, target, verified, [], { source: 0, target: 0 }),
    segment(1, 'saved', source, target, verified, [], { source: scalars(`${source}\n\n`).length, target: scalars(`${target}\n\n`).length }),
  ], docSource, docTarget, 'en');
  assert.deepEqual([mixed.status, mixed.pendingCount, mixed.confirmedCount, mixed.savedCount], ['pending', 1, 1, 1]);
  assert.deepEqual(L.termGroupCounts([mixed]), { all: 1, inconsistent: 0, pending: 1, not_evaluated: 0, confirmed: 0 });
  const under = L.filterTermGroups([mixed], 'pending');
  assert.deepEqual(under.map(g => [g.occurrences.length, g.hidden, g.occurrences[0].freshness]), [[1, 1, 'saved']]);
  assert.deepEqual(L.filterTermGroups([mixed], 'confirmed'), []);
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

test('the traits behind the status: every place is in one of three counts, and a group with one place to check is still found under pending', () => {
  const find = [
    ['椿', 0, 'verified_constraint', 'Camellya'], ['椿', 1, 'not_evaluated', null, 0, [camellya], { reason: 'not_a_term' }], ['椿', 2, 'needs_review', null],
  ];
  const [group] = L.groupTermOccurrences([segment(0, 'current', SOURCE, TARGET, find)], SOURCE, TARGET, 'en');
  assert.equal(group.status, 'inconsistent', 'the most urgent trait names the group');
  assert.equal(group.inconsistent, true);
  assert.deepEqual([group.pendingCount, group.notEvaluatedCount, group.confirmedCount], [1, 1, 1]);
  assert.equal(group.pendingCount + group.notEvaluatedCount + group.confirmedCount, group.occurrenceCount);
  assert.deepEqual(group.unverifiedSegments, []);
  // A decided place leaves its count: the not_evaluated one marked not a term is settled, the verified one with no choice is nothing to do.
  const decided = [choice(spanOf(SOURCE, '椿', 1), 'not_a_term', null, true, 'applies')];
  const [after] = L.groupTermOccurrences([segment(0, 'current', SOURCE, TARGET, find, decided)], SOURCE, TARGET, 'en');
  assert.deepEqual([after.pendingCount, after.notEvaluatedCount, after.confirmedCount], [1, 0, 2]);
  assert.equal(after.notEvaluated, 1, 'Core still did not evaluate it');
  // A conflict nobody settled and a stale segment both need an action.
  const conflict = [['椿', 0, 'confirmed_conflict', 'Camellya'], ['椿', 1, 'verified_constraint', 'Camellya', 0]];
  assert.equal(L.groupTermOccurrences([segment(0, 'current', SOURCE, TARGET, conflict)], SOURCE, TARGET, 'en')[0].pendingCount, 1);
  assert.equal(L.groupTermOccurrences([segment(0, 'stale', SOURCE, TARGET, conflict)], SOURCE, TARGET, 'en')[0].pendingCount, 2);
});

test('the filters count groups by the traits they hold, and what a count says is what the filter shows', () => {
  // 椿: 19 verified and one place to check; 声骸: two places Core did not evaluate; 今汐: settled.
  const source = `${'椿在这里。'.repeat(20)}声骸一，声骸二，今汐来了。`;
  const target = `${'Camellya is here. '.repeat(19)}She is here. The Echo one, the Echo two, Jinhsi came.`;
  const find = [
    ...Array.from({ length: 19 }, (_, nth) => ['椿', nth, 'verified_constraint', 'Camellya', nth]),
    ['椿', 19, 'needs_review', null],
    ['声骸', 0, 'not_evaluated', null, 0, [echo], { reason: 'no_target_region' }], ['声骸', 1, 'not_evaluated', null, 0, [echo], { reason: 'no_target_region' }],
    ['今汐', 0, 'verified_constraint', 'Jinhsi', 0, [{ ...camellya, candidate_id: hash('jinhsi'), zh: '今汐', en: 'Jinhsi' }]],
  ];
  const groups = L.groupTermOccurrences([segment(0, 'current', source, target, find)], source, target, 'en');
  assert.deepEqual(groups.map(g => [g.surface, g.status]), [['椿', 'inconsistent'], ['声骸', 'not_evaluated'], ['今汐', 'confirmed']]);
  assert.deepEqual(L.termGroupCounts(groups), { all: 3, inconsistent: 1, pending: 1, not_evaluated: 1, confirmed: 1 });
  // Pending is not "groups whose status is pending": the group with one place to check is under it, showing that one place.
  const pending = L.filterTermGroups(groups, 'pending');
  assert.deepEqual(pending.map(g => [g.surface, g.occurrences.length, g.hidden]), [['椿', 1, 19]]);
  assert.equal(pending[0].occurrences[0].verdict, 'needs_review');
  // Inconsistent surfaces the one place that needs a decision instead of listing all twenty.
  const inconsistent = L.filterTermGroups(groups, 'inconsistent');
  assert.deepEqual(inconsistent.map(g => [g.surface, g.occurrences.length, g.hidden]), [['椿', 1, 19]]);
  assert.equal(L.filterTermGroups(groups, 'not_evaluated').map(g => g.surface).join(), '声骸');
  assert.equal(L.filterTermGroups(groups, 'confirmed').map(g => g.surface).join(), '今汐');
  assert.equal(L.filterTermGroups(groups, 'all').flatMap(g => g.occurrences).length, 20 + 2 + 1);
  // The rest of a group opens on request, and for every filter the number of groups shown is the number on its button.
  assert.equal(L.filterTermGroups(groups, 'pending', { expanded: new Set([groups[0].key]) })[0].occurrences.length, 20);
  const counts = L.termGroupCounts(groups);
  for (const f of L.TERM_GROUP_FILTERS) assert.equal(L.filterTermGroups(groups, f).length, counts[f], f);
  // One segment selected: counts and lists follow the same scope. 椿 has no place there, so the filters that need one drop it.
  const two = [segment(0, 'current', source, target, find), segment(1, 'current', '声骸三。', 'The Echo three.', [['声骸', 0, 'verified_constraint', 'Echo', 0, [echo]]], [], { source: 0, target: 0 })];
  const scoped = L.groupTermOccurrences(two, `${source}声骸三。`, `${target}The Echo three.`, 'en');
  const inSecond = L.termGroupCounts(scoped, 1);
  assert.deepEqual(inSecond, { all: 1, inconsistent: 0, pending: 0, not_evaluated: 0, confirmed: 0 });
  for (const f of L.TERM_GROUP_FILTERS) assert.equal(L.filterTermGroups(scoped, f, { segment: 1 }).length, inSecond[f], f);
});

test('a ready segment without a result that holds the term keeps its group from reading confirmed; the others do not', () => {
  const source = 'Tune the Tuner. The Tuner hums.';
  const target = '调整调谐器。调谐器在嗡嗡响。';
  const verified = [['Tuner', 0, 'verified_constraint', '调谐器', 0, [tunerA]], ['Tuner', 1, 'verified_constraint', '调谐器', 1, [tunerA]]];
  const checked = [segment(0, 'current', source, target, verified)];
  assert.equal(L.groupTermOccurrences(checked, source, target, 'zh')[0].status, 'confirmed');
  // Segment 2 was edited and has no result; its source holds the Tuner (a plural and another case too).
  const holds = [{ index: 1, sourceCore: 'She asked the tuners for help.' }];
  const [group] = L.groupTermOccurrences(checked, source, target, 'zh', holds);
  assert.deepEqual(group.unverifiedSegments, [2]);
  assert.equal(group.status, 'pending');
  assert.equal(group.pendingCount, 0, 'no place of the group needs an action: the segment has none yet');
  assert.deepEqual(L.termGroupCounts([group]), { all: 1, inconsistent: 0, pending: 1, not_evaluated: 0, confirmed: 0 });
  assert.deepEqual(L.filterTermGroups([group], 'pending').map(g => [g.occurrences.length, g.hidden]), [[0, 2]], 'its head says why; the places open on request');
  // A segment without the term, a longer English word and the same term in another group do not count.
  const others = [{ index: 1, sourceCore: 'Nothing of interest. Tuneful sounds.' }, { index: 2, sourceCore: 'Intuners and tunerless.' }];
  assert.deepEqual(L.groupTermOccurrences(checked, source, target, 'zh', others)[0].unverifiedSegments, []);
  assert.equal(L.groupTermOccurrences(checked, source, target, 'zh', others)[0].status, 'confirmed');
  // A Chinese source matches as a substring; the spellings of a merged group all count.
  const zhSource = '椿看着椿。';
  const zhGroup = L.groupTermOccurrences([segment(0, 'current', zhSource, 'Camellya looked at Camellya.', [['椿', 0, 'verified_constraint', 'Camellya', 0], ['椿', 1, 'verified_constraint', 'Camellya', 1]])],
    zhSource, 'Camellya looked at Camellya.', 'en', [{ index: 1, sourceCore: '香椿很好吃。' }, { index: 2, sourceCore: '今汐。' }])[0];
  assert.deepEqual(zhGroup.unverifiedSegments, [2]);
  const plural = 'The Tuner and the Tuners.';
  const merged = L.groupTermOccurrences([segment(0, 'current', plural, '调谐器和调谐器们。', [['Tuner', 0, 'verified_constraint', '调谐器', 0, [tunerA]], ['Tuners', 0, 'verified_constraint', '调谐器', 1, [tunerA]]])],
    plural, '调谐器和调谐器们。', 'zh', [{ index: 1, sourceCore: 'TUNERS everywhere.' }])[0];
  assert.deepEqual(merged.unverifiedSegments, [2]);
  // No unchecked list, nothing changes (the argument is optional).
  assert.deepEqual(L.groupTermOccurrences(checked, source, target, 'zh')[0].unverifiedSegments, []);
});

test('uncheckedTermSegments lists the ready segments that hold no result, with their source cores; a segment that has one is left out', () => {
  const manuscript = camellyaManuscript();
  const draft = { source: manuscript.source, target: manuscript.target, direction: manuscript.direction, alignments: null };
  const long = L.longFromWorkfile({ ...manuscript, alignments: null, segments: [], segment_choice_history: [], progress: { current: null, completed: [] } });
  const ctx = { draft, basis: null };
  const items = L.segmentInputs(draft).items;
  assert.deepEqual(items.map(i => i.pair.status), ['ready', 'ready', 'ready', 'ready', 'needs_manual_split']);
  // Nothing was checked: the four ready segments, not the one that needs a manual split.
  assert.deepEqual(L.uncheckedTermSegments(long, ctx).map(u => u.index), [0, 1, 2, 3]);
  assert.equal(L.uncheckedTermSegments(long, ctx)[1].sourceCore, items[1].sourceCore);
  // A segment that has a result is not listed.
  const checked = { ...long, records: long.records.map((r, i) => (i === 1 ? { ...r, result: { findings: [], truncated: false } } : r)) };
  assert.deepEqual(L.uncheckedTermSegments(checked, ctx).map(u => u.index), [0, 2, 3]);
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
  assert.deepEqual(camellyaGroup.renderings, [{ text: 'Camellya', count: 123 + 33, kind: 'hit' }, { text: null, count: 2, kind: 'not_evaluated' }]);
  assert.equal(camellyaGroup.status, 'pending', 'the choices wait for the next check');
  assert.deepEqual(groups.flatMap(g => g.occurrences).filter(o => o.reason).map(o => o.reason).sort(), [...REASON_VALUES].sort());
  assert.equal(groups.every(g => g.occurrences.every(o => o.sourceContext && o.sourceContext.hit === o.docSource.text)), true);
  // The same state written and read again keeps every reason (v4).
  const again = serializeWorkfile({ ...parsed, ...L.workfileParts(long, draft, { basis: null }) });
  assert.equal(JSON.parse(again).format, 'wuwaterm-manuscript-v4');
  assert.equal(JSON.parse(again).segments[1].result.findings.filter(f => Object.hasOwn(f, 'reason')).length, 5);
});
