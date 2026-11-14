import { Suspense, lazy } from 'react';
import { useStudio } from '../state/store';
import { useSaveFlow } from '../state/saveFlow';

/** The save dialogs (wave 4: warn before saving; a newer version was saved first) are a separate download, mounted only while one is open. */
const SaveDialogs = lazy(() => import('./SaveDialogs'));
export function SaveDialogsHost() {
  const warning = useSaveFlow((s) => !!s.warning);
  const conflict = useStudio((s) => !!s.saveConflict);
  if (!warning && !conflict) return null;
  return <Suspense fallback={null}><SaveDialogs /></Suspense>;
}
