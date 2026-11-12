import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useStudio } from './state/store';
import { Loading } from './ui/common';
import { PlainShell, StudioShell } from './shell/Shell';
import { ProjectGallery } from './screens/ProjectGallery';
import { DesignStudio } from './screens/DesignStudio';
import { ExplodedDocument } from './screens/ExplodedDocument';
import { DocumentCube } from './screens/DocumentCube';
import { ScenarioLandscape } from './screens/ScenarioLandscape';
import { PageStack } from './screens/PageStack';
import { RulesData } from './screens/RulesData';
import { JourneySimulator } from './screens/JourneySimulator';
import { ValidateCompare } from './screens/ValidateCompare';
import { PreviewExport } from './screens/PreviewExport';
import { GuidedDemo } from './screens/GuidedDemo';
import { AiAssistant } from './screens/AiAssistant';
import { Translations } from './screens/Translations';
import { Activity } from './screens/Activity';
import { Login } from './screens/Login';

const S = (el: JSX.Element) => <StudioShell>{el}</StudioShell>;

/**
 * Loads who is signed in. Auth is off by default (built-in local admin) and nothing changes; with AUTH=on an
 * anonymous visitor is sent to /login and comes back to the page they asked for.
 */
function AuthGate({ children }: { children: ReactNode }) {
  const status = useStudio((s) => s.sessionStatus);
  const session = useStudio((s) => s.session);
  const { pathname, search } = useLocation();
  useEffect(() => { void useStudio.getState().loadSession(); }, []);
  useEffect(() => {
    // Sessions expire after 12 h: re-check when the tab regains focus.
    const onFocus = () => { if (useStudio.getState().session?.authEnabled) void useStudio.getState().loadSession(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  if (!session && (status === 'idle' || status === 'loading')) return <div className="login-page"><Loading label="Starting Spatial Studio…" /></div>;
  if (session?.authEnabled && !session.user && pathname !== '/login') return <Navigate to={`/login?next=${encodeURIComponent(pathname + search)}`} replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthGate>
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/activity" element={<PlainShell><Activity global /></PlainShell>} />
        <Route path="/projects" element={<PlainShell><ProjectGallery /></PlainShell>} />
        <Route path="/studio" element={<Navigate to="/projects" replace />} />
        <Route path="/studio/:project" element={<Navigate to="design" replace />} />
        <Route path="/studio/:project/design" element={S(<DesignStudio />)} />
        <Route path="/studio/:project/exploded" element={S(<ExplodedDocument />)} />
        <Route path="/studio/:project/exploded/:nodeId" element={S(<ExplodedDocument />)} />
        <Route path="/studio/:project/cube" element={S(<DocumentCube />)} />
        <Route path="/studio/:project/landscape" element={S(<ScenarioLandscape />)} />
        <Route path="/studio/:project/page-stack" element={S(<PageStack />)} />
        <Route path="/studio/:project/rules-data" element={S(<RulesData />)} />
        <Route path="/studio/:project/journey" element={S(<JourneySimulator />)} />
        <Route path="/studio/:project/validate" element={S(<ValidateCompare />)} />
        <Route path="/studio/:project/outputs" element={S(<PreviewExport />)} />
        <Route path="/studio/:project/demo" element={S(<GuidedDemo />)} />
        <Route path="/studio/:project/assistant" element={S(<AiAssistant />)} />
        <Route path="/studio/:project/content" element={S(<Translations />)} />
        <Route path="/studio/:project/activity" element={S(<Activity />)} />
        <Route path="*" element={<PlainShell><div className="empty"><strong>Page not found</strong><a href="/projects">Back to Project Gallery</a></div></PlainShell>} />
      </Routes>
      </AuthGate>
    </BrowserRouter>
  );
}
