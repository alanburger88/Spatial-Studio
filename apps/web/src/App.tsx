import { Suspense, lazy, useEffect, type ComponentType, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useStudio } from './state/store';
import { Loading } from './ui/common';
import { PlainShell, StudioShell } from './shell/Shell';
import { ProjectGallery } from './screens/ProjectGallery';
import { Login } from './screens/Login';
import { GuidedDemo } from './screens/GuidedDemo'; // small, and the shell already needs its banner

/**
 * Every studio screen is its own download, fetched when first opened, so the first page loads quickly.
 * Once the app is idle the remaining screens are fetched in the background, so moving between them stays instant.
 */
const loaders = {
  DesignStudio: () => import('./screens/DesignStudio'),
  ExplodedDocument: () => import('./screens/ExplodedDocument'),
  DocumentCube: () => import('./screens/DocumentCube'),
  ScenarioLandscape: () => import('./screens/ScenarioLandscape'),
  PageStack: () => import('./screens/PageStack'),
  RulesData: () => import('./screens/RulesData'),
  JourneySimulator: () => import('./screens/JourneySimulator'),
  ValidateCompare: () => import('./screens/ValidateCompare'),
  PreviewExport: () => import('./screens/PreviewExport'),
  AiAssistant: () => import('./screens/AiAssistant'),
  Translations: () => import('./screens/Translations'),
  EmailSms: () => import('./screens/EmailSms'),
  DataExplorer: () => import('./screens/DataExplorer'),
  Activity: () => import('./screens/Activity'),
};
const screen = <K extends keyof typeof loaders>(name: K) => lazy(() => (loaders[name]() as Promise<Record<string, ComponentType<any>>>).then((m) => ({ default: m[name] })));
const DesignStudio = screen('DesignStudio');
const ExplodedDocument = screen('ExplodedDocument');
const DocumentCube = screen('DocumentCube');
const ScenarioLandscape = screen('ScenarioLandscape');
const PageStack = screen('PageStack');
const RulesData = screen('RulesData');
const JourneySimulator = screen('JourneySimulator');
const ValidateCompare = screen('ValidateCompare');
const PreviewExport = screen('PreviewExport');
const AiAssistant = screen('AiAssistant');
const Translations = screen('Translations');
const EmailSms = screen('EmailSms');
const DataExplorer = screen('DataExplorer');
const Activity = screen('Activity') as ComponentType<{ global?: boolean }>;

function usePrefetchScreens() {
  useEffect(() => {
    const run = () => { for (const load of Object.values(loaders)) void load().catch(() => undefined); };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const t = ric ? ric(run, { timeout: 4000 }) : window.setTimeout(run, 2500);
    return () => { if (ric) (window as unknown as { cancelIdleCallback?: (n: number) => void }).cancelIdleCallback?.(t); else window.clearTimeout(t); };
  }, []);
}


const wait = (el: JSX.Element) => <Suspense fallback={<Loading label="Loading view…" />}>{el}</Suspense>;
const S = (el: JSX.Element) => <StudioShell>{wait(el)}</StudioShell>;

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
  usePrefetchScreens();
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthGate>
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/login" element={<Login />} />
        <Route path="/activity" element={<PlainShell>{wait(<Activity global />)}</PlainShell>} />
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
        <Route path="/studio/:project/channels" element={S(<EmailSms />)} />
        <Route path="/studio/:project/data" element={S(<DataExplorer />)} />
        <Route path="/studio/:project/activity" element={S(<Activity />)} />
        <Route path="*" element={<PlainShell><div className="empty"><strong>Page not found</strong><a href="/projects">Back to Project Gallery</a></div></PlainShell>} />
      </Routes>
      </AuthGate>
    </BrowserRouter>
  );
}
