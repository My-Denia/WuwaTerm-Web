'use client';

import { useCallback, useRef, useState } from 'react';
import { fill, msg } from '../../../lib/messages';
import {
  inferDirection,
  promoteTermbaseEntry,
  type TermbaseDirection,
  type TermbaseEntry,
  type TermbaseKind,
} from '../../../lib/termbase';
import type { UiLanguage } from '../../../lib/ui-language';
import type { Span } from '../../../lib/workbench-model';
import type { TermbaseDraftSeed, TermbaseExternalFeedback } from '../my-terms';

export function useTermbaseWorkspace(options: {
  lang: UiLanguage;
  quick: boolean;
  autoDirection: boolean;
  source: string;
  direction: 'en' | 'zh';
  onOpenTermsInspector: () => void;
}) {
  const { lang, quick, autoDirection, source, direction, onOpenTermsInspector } = options;
  const [termbaseEntries, setTermbaseEntries] = useState<TermbaseEntry[]>([]);
  const [termbaseOpen, setTermbaseOpen] = useState(false);
  const [termbaseDraftSeed, setTermbaseDraftSeed] = useState<TermbaseDraftSeed | null>(null);
  const [termbaseFeedback, setTermbaseFeedback] = useState<TermbaseExternalFeedback | null>(null);
  const termbaseSeq = useRef(0);

  const effectiveTermbaseDirection: TermbaseDirection = quick && autoDirection ? inferDirection(source) : direction;

  const emitTermbaseFeedback = useCallback((kind: 'notice' | 'error', text: string) => {
    termbaseSeq.current += 1;
    setTermbaseFeedback({ key: termbaseSeq.current, kind, text });
  }, []);

  const promoteToTermbase = useCallback((candidate: {
    source: string;
    target: string;
    direction?: TermbaseDirection;
    kind?: TermbaseKind;
    note?: string;
  }) => {
    const m = msg(lang);
    const targetDirection = candidate.direction ?? effectiveTermbaseDirection;
    const outcome = promoteTermbaseEntry(termbaseEntries, {
      source: candidate.source,
      target: candidate.target,
      direction: targetDirection,
      kind: candidate.kind ?? 'preferred_term',
      note: candidate.note,
    });
    if (outcome.status === 'added') {
      setTermbaseEntries(outcome.entries);
      emitTermbaseFeedback('notice', fill(m.termbase.notices.promoted, { source: outcome.entry.source, target: outcome.entry.target }));
      return;
    }
    if (outcome.status === 'duplicate') {
      emitTermbaseFeedback('notice', fill(m.termbase.notices.alreadyPresent, { source: outcome.entry.source, target: outcome.entry.target }));
      return;
    }
    if (outcome.status === 'incomplete') {
      termbaseSeq.current += 1;
      const seedKey = termbaseSeq.current;
      setTermbaseOpen(true);
      if (!quick) onOpenTermsInspector();
      setTermbaseDraftSeed({
        key: seedKey,
        source: outcome.source,
        target: outcome.target,
        direction: outcome.direction,
        kind: outcome.kind,
        note: candidate.note ?? '',
      });
      emitTermbaseFeedback('notice', outcome.source || outcome.target ? m.termbase.notices.prefilled : m.termbase.notices.selectHint);
      return;
    }
    const fieldName = outcome.field === 'target' ? m.termbase.fieldTarget
      : outcome.field === 'note' ? m.termbase.fieldNote : m.termbase.fieldSource;
    if (outcome.error === 'list_full') emitTermbaseFeedback('error', m.termbase.errors.listFull);
    else if (outcome.error === 'list_too_large') emitTermbaseFeedback('error', m.termbase.errors.listTooLarge);
    else if (outcome.error === 'field_too_long') emitTermbaseFeedback('error', fill(m.termbase.errors.fieldTooLong, { field: fieldName, max: outcome.max ?? 0 }));
    else emitTermbaseFeedback('error', fill(m.termbase.errors.fieldInvalid, { field: fieldName }));
  }, [lang, effectiveTermbaseDirection, termbaseEntries, emitTermbaseFeedback, quick, onOpenTermsInspector]);

  const promoteSelectionToTermbase = useCallback((
    getSourceSelection: () => Span | null,
    getTargetSelection: () => Span | null,
  ) => {
    const selectedSource = getSourceSelection()?.text.trim() ?? '';
    const selectedTarget = getTargetSelection()?.text.trim() ?? '';
    promoteToTermbase({
      source: selectedSource,
      target: selectedTarget,
      direction: effectiveTermbaseDirection,
      kind: 'preferred_term',
    });
  }, [promoteToTermbase, effectiveTermbaseDirection]);

  return {
    termbaseEntries,
    setTermbaseEntries,
    termbaseOpen,
    setTermbaseOpen,
    termbaseDraftSeed,
    termbaseFeedback,
    effectiveTermbaseDirection,
    promoteToTermbase,
    promoteSelectionToTermbase,
  };
}
