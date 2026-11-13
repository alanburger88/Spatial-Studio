import { useEffect, useMemo, useState } from 'react';
import type { Project } from '@iss/model';
import { checkWording, wordingRulesInForce, type WordingCheck, type WordingTextScope } from '@iss/scenarios';
import { useStudio } from '../../state/store';

/**
 * The wording checker for the screens. `useTextWording` checks the one text being typed, after a short pause (the same
 * pure function the server and the Blockers screen use). `useDocumentWording` checks the whole document.
 */

/** The text's findings, worked out 250 ms after the person stops typing. Null while there are no wording rules. */
export function useTextWording(text: string, scope: WordingTextScope, locale = 'en-US'): WordingCheck | null {
  const project = useStudio((s) => s.project);
  const rules = useMemo(() => (project ? wordingRulesInForce(project) : []), [project?.houseWordingRules, project?.wordingRules, project?.libraryLinks]); // eslint-disable-line react-hooks/exhaustive-deps
  const [check, setCheck] = useState<WordingCheck | null>(null);
  useEffect(() => {
    if (!project || !rules.length) { setCheck(null); return; }
    const h = setTimeout(() => setCheck(checkWording(project, { rules, text: { text, scope, locale } })), 250);
    return () => clearTimeout(h);
  }, [text, scope, locale, rules]); // eslint-disable-line react-hooks/exhaustive-deps
  return rules.length ? check : null;
}

/** Every finding in the document (recomputed after a pause when the document changes). */
export function useDocumentWording(project: Project | null): WordingCheck | null {
  const [check, setCheck] = useState<WordingCheck | null>(null);
  useEffect(() => {
    if (!project) return;
    const h = setTimeout(() => setCheck(checkWording(project)), 150);
    return () => clearTimeout(h);
  }, [project]);
  return check;
}
