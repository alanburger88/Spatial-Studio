import { useEffect, useRef, useState } from 'react';
import { useStudio } from '../state/store';
import { initialsOf, otherName, useOthers } from './presence';
import './presence.css';

/**
 * Wave 4, item 4: who else has this document open, in the top bar. Initials of up to three others, then "+N"; on narrow
 * windows a single count. The button names everyone and the screen each is on (its accessible name and tooltip), and opens
 * a short list. Nothing is shown when this window is alone on the document.
 */

const SHOWN = 3;

function WindowGlyph() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18" /></svg>;
}
function PeopleGlyph() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2" /><path d="M3 19c.6-3.2 3-5 6-5s5.4 1.8 6 5M16 5.2a3 3 0 0 1 0 5.6M18 14.2c1.6.7 2.7 2.3 3 4.8" /></svg>;
}

export function PresenceBar({ screenLabel }: { screenLabel: (screenId: string | null) => string }) {
  const others = useOthers();
  const authEnabled = useStudio((s) => !!s.session?.authEnabled);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector<HTMLElement>('button')?.focus(); } };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => { if (!others.length) setOpen(false); }, [others.length]);
  if (!others.length) return null;
  const people = others.map((o) => ({ o, name: otherName(o, authEnabled), where: o.screen ? screenLabel(o.screen) : 'this document' }));
  const line = (p: (typeof people)[number]) => `${p.name}, on ${p.where}${p.o.dirty ? ', with unsaved changes' : ''}`;
  const label = `Also on this document: ${people.map(line).join('; ')}`;
  const count = others.length;
  return (
    <div className="presence" ref={ref} data-testid="presence" data-count={count}>
      <button type="button" className="presence-btn" aria-label={label} title={people.map(line).join('\n')} aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="presence-open">
        <span className="presence-faces" aria-hidden="true">
          {people.slice(0, SHOWN).map((p) => (
            <span key={p.o.key} className={`presence-face${p.o.sameUser ? ' same' : ''}`} data-testid="presence-person" data-name={p.name} data-screen={p.o.screen ?? ''}>
              {p.o.sameUser && !authEnabled ? <WindowGlyph /> : initialsOf(p.o.name)}
            </span>
          ))}
          {count > SHOWN && <span className="presence-more" data-testid="presence-more">+{count - SHOWN}</span>}
        </span>
        <span className="presence-count" aria-hidden="true"><PeopleGlyph />{count}</span>
      </button>
      {open && (
        <div className="presence-pop" role="group" aria-label="Also on this document" data-testid="presence-list">
          <div className="presence-pop-head">Also on this document</div>
          <ul>
            {people.map((p) => (
              <li key={p.o.key} data-testid="presence-row">
                <span className={`presence-face${p.o.sameUser ? ' same' : ''}`} aria-hidden="true">{p.o.sameUser && !authEnabled ? <WindowGlyph /> : initialsOf(p.o.name)}</span>
                <span className="presence-who"><strong>{p.name}</strong><span className="muted">On {p.where}{p.o.dirty ? ' · unsaved changes' : ''}</span></span>
              </li>
            ))}
          </ul>
          <p className="presence-note muted">Updated every 15 seconds. Two people can edit at once: whoever saves second is asked what to do.</p>
        </div>
      )}
    </div>
  );
}
