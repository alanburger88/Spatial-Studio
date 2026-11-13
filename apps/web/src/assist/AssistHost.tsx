import { Suspense, lazy, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { usePanel } from './panelStore';
import './panel.css';

/** The assistant panel's code (and the conversation engines behind it) is its own download, fetched on first open or when the app is idle. */
export const loadAssistPanel = () => import('./AssistPanel');
const AssistPanelBody = lazy(() => loadAssistPanel().then((m) => ({ default: m.AssistPanelBody })));

/**
 * Mounted once by the studio shell. It tells the screens the assistant exists (so the "Ask AI" button shows), and shows the
 * panel while it is open. A placeholder with the same frame shows while the panel's code arrives.
 */
export function AssistHost() {
  const { pathname } = useLocation();
  const open = usePanel((s) => s.open);
  const setAvailable = usePanel((s) => s.setAvailable);
  useEffect(() => { setAvailable(true); return () => setAvailable(false); }, [setAvailable]);
  // The AI Assistant screen is the full-size version of this panel; two copies of the conversation would be confusing.
  if (!open || /\/assistant\/?$/.test(pathname)) return null;
  return (
    <Suspense fallback={<aside className="assist-panel" role="status" aria-busy="true" aria-label="Assistant"><div className="assist-head"><h2>Assistant</h2></div><p className="assist-status">Loading the assistant…</p></aside>}>
      <AssistPanelBody />
    </Suspense>
  );
}
