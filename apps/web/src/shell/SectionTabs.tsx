import { useRef, type KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useStudio } from '../state/store';
import { SCREENS, TAB_LABEL, screenOfPath, screenTo, sectionOf, useSectionMemory } from './Shell';
import { startTour } from './TourPrompt';
import './section-tabs.css';

/**
 * One row of tabs at the top of the main area: the screens of the current section of the left menu.
 * A section with a single screen (Projects, Overview) shows no row. The tabs are links, so each keeps its own address;
 * the tab in use carries aria-current="page". Left/Right/Home/End move between tabs, as well as Tab.
 */
export function SectionTabs({ plain = false }: { plain?: boolean } = {}) {
  const { pathname } = useLocation();
  const project = useStudio((s) => s.project);
  const sel = useStudio((s) => s.ctx.selectedNodeId);
  const row = useRef<HTMLElement>(null);
  const here = screenOfPath(pathname);
  const section = here ? sectionOf(here.id) : undefined;
  if (!here || !section || section.screens.length < 2) return null;
  // Outside a document (the project list and the library) only the Projects section has tabs; its screens need no project.
  if (plain ? section.id !== 'projects' : !project) return null;

  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    const links = Array.from(row.current?.querySelectorAll<HTMLAnchorElement>('a') ?? []);
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (at < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? links.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + links.length) % links.length;
    links[next]?.focus();
  };

  return (
    <nav className="section-tabs" aria-label={`${section.label} screens`} ref={row} onKeyDown={onKey} data-testid="section-tabs" data-section={section.id}>
      {section.screens.map((id) => {
        const s = SCREENS.find((x) => x.id === id)!;
        const current = id === here.id;
        return (
          <Link key={id} to={screenTo(s, project, sel, project?.projectId ?? '')} className={`section-tab${current ? ' current' : ''}`} aria-current={current ? 'page' : undefined} onClick={() => useSectionMemory.getState().remember(section.id, id)} title={`${s.label} — ${s.hint}`} data-testid={`nav-${id}`}>
            <span className="section-tab-label">{TAB_LABEL[id] ?? s.label}</span>
          </Link>
        );
      })}
      {section.id === 'help' && <button type="button" className="btn ghost sm section-tab-action" onClick={startTour} title="A two-minute walk through the menu and the screens" data-testid="tour-restart">Take the studio tour</button>}
    </nav>
  );
}
