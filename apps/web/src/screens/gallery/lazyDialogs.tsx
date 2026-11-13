import { Suspense, lazy, type ComponentProps } from 'react';
import { Loading } from '../../ui/common';

/**
 * The gallery's setup, import and template dialogs are each their own download, fetched the first time one is opened (and
 * in the background once the app is idle). A small loading dialog shows in the same place while the code arrives.
 */
export const dialogLoaders = {
  setup: () => import('./SetupDialog'),
  importRecords: () => import('./ImportRecords'),
  templates: () => import('./TemplateDialogs'),
};
const SetupDialogImpl = lazy(() => dialogLoaders.setup().then((m) => ({ default: m.SetupDialog })));
const ImportDialogImpl = lazy(() => dialogLoaders.importRecords().then((m) => ({ default: m.ImportDialog })));
const SaveTemplateDialogImpl = lazy(() => dialogLoaders.templates().then((m) => ({ default: m.SaveTemplateDialog })));
const ImportProjectDialogImpl = lazy(() => dialogLoaders.templates().then((m) => ({ default: m.ImportProjectDialog })));

const fallback = <div className="dialog-backdrop"><div className="dialog" role="status" aria-busy="true" style={{ padding: 24 }}><Loading label="Loading…" /></div></div>;

export function SetupDialog(props: ComponentProps<typeof SetupDialogImpl>) { return <Suspense fallback={fallback}><SetupDialogImpl {...props} /></Suspense>; }
export function ImportDialog(props: ComponentProps<typeof ImportDialogImpl>) { return <Suspense fallback={fallback}><ImportDialogImpl {...props} /></Suspense>; }
export function SaveTemplateDialog(props: ComponentProps<typeof SaveTemplateDialogImpl>) { return <Suspense fallback={fallback}><SaveTemplateDialogImpl {...props} /></Suspense>; }
export function ImportProjectDialog(props: ComponentProps<typeof ImportProjectDialogImpl>) { return <Suspense fallback={fallback}><ImportProjectDialogImpl {...props} /></Suspense>; }

export function prefetchGalleryDialogs() {
  for (const load of Object.values(dialogLoaders)) void load().catch(() => undefined);
}
