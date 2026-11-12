import { useMemo, useState } from 'react';
import { applyCommand, type BrandKit, type Project, type TextStyle } from '@iss/model';
import { useStudio } from '../../state/store';
import { Dialog } from '../../ui/common';
import { AssetLibraryDialog, type PickedAsset } from './AssetLibrary';
import './StylesBrand.css';

/** WCAG relative luminance contrast ratio between two 6-digit hex colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const FONTS: Array<NonNullable<BrandKit['fontFamily']>> = ['Arial', 'Georgia', 'Verdana', 'Trebuchet MS'];
const FONT_STACK: Record<string, string> = { Arial: 'Arial, "Liberation Sans", sans-serif', Georgia: 'Georgia, "Liberation Serif", serif', Verdana: 'Verdana, "DejaVu Sans", sans-serif', 'Trebuchet MS': '"Trebuchet MS", "DejaVu Sans", sans-serif' };
const WEIGHTS: Array<TextStyle['fontWeight']> = [400, 600, 700, 800];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'style';

function ColourField({ label, value, onChange, testId }: { label: string; value: string; onChange: (v: string) => void; testId: string }) {
  return (
    <div className="field sb-colour">
      <label htmlFor={`${testId}-hex`}>{label}</label>
      <div className="row" style={{ gap: 6 }}>
        <input type="color" value={HEX.test(value) ? value : '#000000'} onChange={(e) => onChange(e.target.value.toUpperCase())} aria-label={`${label} colour picker`} className="sb-swatch" />
        <input id={`${testId}-hex`} className="input mono" value={value} onChange={(e) => onChange(e.target.value)} maxLength={7} aria-invalid={!HEX.test(value)} data-testid={testId} />
      </div>
    </div>
  );
}

function Contrast({ fg, bg, what, testId }: { fg: string; bg: string; what: string; testId: string }) {
  if (!HEX.test(fg) || !HEX.test(bg)) return null;
  const r = contrastRatio(fg, bg);
  const ok = r >= 4.5;
  return (
    <div className={`sb-contrast ${ok ? 'ok' : 'low'}`} data-testid={testId} data-ratio={r.toFixed(2)} role={ok ? undefined : 'status'}>
      <span className="chip">{r.toFixed(1)}:1</span> {what}: {ok ? 'meets the 4.5:1 minimum.' : 'below the 4.5:1 minimum. Hard to read for some people; pick a darker colour.'}
    </div>
  );
}

/* ---------------------------------------------------------------- text styles */

function usageCount(project: Project, id: string) { return project.nodes.filter((n) => n.styleId === id).length; }

function StyleSample({ st }: { st: TextStyle }) {
  const css: React.CSSProperties = {
    fontSize: `${(st.fontSizePt ?? 10) * (4 / 3)}px`, fontWeight: st.fontWeight ?? 400, fontStyle: st.italic ? 'italic' : 'normal', color: st.color ?? '#0F172A',
    lineHeight: st.lineHeight ?? 1.35, textTransform: st.uppercase ? 'uppercase' : 'none',
    marginTop: st.kind === 'paragraph' ? `${(st.spaceBeforePt ?? 0) * (4 / 3)}px` : 0, marginBottom: st.kind === 'paragraph' ? `${(st.spaceAfterPt ?? 0) * (4 / 3)}px` : 0,
  };
  return (
    <div className="sb-sample" data-testid="style-sample" aria-label="Live sample">
      <div className="sb-sample-paper"><p style={css}>Your balance is $1,248.00 and your payment is due on 14 March. Thank you for banking with us.</p><p style={css}>A second paragraph shows the spacing between paragraphs.</p></div>
    </div>
  );
}

function StylesPane({ project, onClose }: { project: Project; onClose: () => void }) {
  const dispatch = useStudio((s) => s.dispatch);
  const [list, setList] = useState<TextStyle[]>(() => (project.styles ?? []).map((s) => ({ ...s })));
  const [sel, setSel] = useState<string | null>(list[0]?.id ?? null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const cur = list.find((s) => s.id === sel) ?? null;
  const dirty = JSON.stringify(list) !== JSON.stringify(project.styles ?? []);
  const patch = (p: Partial<TextStyle>) => setList((l) => l.map((s) => (s.id === sel ? { ...s, ...p } : s)));
  const num = (v: string): number | undefined => (v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

  const add = (kind: TextStyle['kind']) => {
    let base = slug(kind === 'paragraph' ? 'paragraph-style' : 'character-style'), id = base;
    for (let i = 2; list.some((s) => s.id === id); i++) id = `${base}-${i}`;
    const st: TextStyle = { id, name: kind === 'paragraph' ? 'New paragraph style' : 'New character style', kind, fontSizePt: 10, fontWeight: 400, color: '#0F172A', lineHeight: 1.35, ...(kind === 'paragraph' ? { spaceBeforePt: 0, spaceAfterPt: 4 } : {}) };
    setList([...list, st]); setSel(id); setMsg(null);
  };
  const remove = (id: string) => {
    const next = list.filter((s) => s.id !== id);
    // Ask the same command the model enforces, so the message is the real one.
    const r = applyCommand({ ...project, styles: project.styles ?? [] }, { type: 'SET_STYLES', styles: next });
    const savedHas = (project.styles ?? []).some((s) => s.id === id);
    if (savedHas && !r.ok) { setMsg({ kind: 'error', text: r.message }); return; }
    setList(next); setSel(next[0]?.id ?? null); setMsg(null);
  };
  const apply = () => {
    const names = list.map((s) => s.name.trim().toLowerCase());
    if (names.some((n, i) => names.indexOf(n) !== i)) { setMsg({ kind: 'error', text: 'Two styles share a name. Give each style a unique name.' }); return; }
    const r = dispatch({ type: 'SET_STYLES', styles: list.map((s) => ({ ...s, name: s.name.trim() })) });
    setMsg(r.ok ? { kind: 'ok', text: 'Styles saved to the project.' } : { kind: 'error', text: r.message });
  };
  const colourOk = !cur || cur.color === undefined || HEX.test(cur.color);

  return (
    <div className="sb-grid" data-testid="styles-pane">
      <div className="sb-list">
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm" onClick={() => add('paragraph')} data-testid="style-new">+ Paragraph style</button>
          <button className="btn sm" onClick={() => add('character')} data-testid="style-new-character">+ Character style</button>
        </div>
        {!list.length && <p className="muted" style={{ fontSize: 12.5 }}>No text styles yet. Create one, then apply it to a component from the Inspector.</p>}
        <ul className="sb-items" aria-label="Text styles">
          {list.map((s) => {
            const n = usageCount(project, s.id);
            return (
              <li key={s.id}>
                <button className={`sb-item${s.id === sel ? ' on' : ''}`} aria-current={s.id === sel} onClick={() => { setSel(s.id); setMsg(null); }} data-testid={`style-item-${s.id}`}>
                  <span className="sb-item-name">{s.name}</span>
                  <span className="muted sb-item-sub">{s.kind} · {n ? `used by ${n}` : 'unused'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="sb-edit">
        {!cur ? <div className="empty"><strong>No style selected</strong><span>Create or pick a style to edit it.</span></div> : (
          <>
            <div className="row sb-row">
              <div className="field grow"><label htmlFor="sb-name">Name</label><input id="sb-name" className="input" value={cur.name} maxLength={60} onChange={(e) => patch({ name: e.target.value })} data-testid="style-name" /></div>
              <div className="field"><label htmlFor="sb-kind">Kind</label><select id="sb-kind" className="select" value={cur.kind} onChange={(e) => patch({ kind: e.target.value as TextStyle['kind'] })}><option value="paragraph">Paragraph</option><option value="character">Character</option></select></div>
            </div>
            <div className="sb-fields">
              <div className="field"><label htmlFor="sb-size">Size (pt)</label><input id="sb-size" className="input" type="number" min={6} max={48} step={0.5} value={cur.fontSizePt ?? ''} onChange={(e) => patch({ fontSizePt: num(e.target.value) })} data-testid="style-size" /></div>
              <div className="field"><label htmlFor="sb-weight">Weight</label><select id="sb-weight" className="select" value={cur.fontWeight ?? 400} onChange={(e) => patch({ fontWeight: Number(e.target.value) as TextStyle['fontWeight'] })} data-testid="style-weight">{WEIGHTS.map((w) => <option key={w} value={w}>{w === 400 ? 'Regular 400' : w === 600 ? 'Semibold 600' : w === 700 ? 'Bold 700' : 'Extra bold 800'}</option>)}</select></div>
              <div className="field"><label htmlFor="sb-lh">Line height</label><input id="sb-lh" className="input" type="number" min={1} max={3} step={0.05} value={cur.lineHeight ?? ''} onChange={(e) => patch({ lineHeight: num(e.target.value) })} data-testid="style-lineheight" /></div>
              <ColourField label="Colour" value={cur.color ?? ''} onChange={(v) => patch({ color: v })} testId="style-color" />
              {cur.kind === 'paragraph' && <div className="field"><label htmlFor="sb-sb">Space before (pt)</label><input id="sb-sb" className="input" type="number" min={0} max={72} value={cur.spaceBeforePt ?? ''} onChange={(e) => patch({ spaceBeforePt: num(e.target.value) })} data-testid="style-before" /></div>}
              {cur.kind === 'paragraph' && <div className="field"><label htmlFor="sb-sa">Space after (pt)</label><input id="sb-sa" className="input" type="number" min={0} max={72} value={cur.spaceAfterPt ?? ''} onChange={(e) => patch({ spaceAfterPt: num(e.target.value) })} data-testid="style-after" /></div>}
            </div>
            <div className="row sb-row" style={{ gap: 16 }}>
              <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!cur.italic} onChange={(e) => patch({ italic: e.target.checked })} data-testid="style-italic" /> Italic</label>
              <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={!!cur.uppercase} onChange={(e) => patch({ uppercase: e.target.checked })} data-testid="style-uppercase" /> Uppercase</label>
              <span className="muted mono" style={{ marginLeft: 'auto', fontSize: 11.5 }} title="Stable identifier used in the model">{cur.id}</span>
            </div>
            {cur.color !== undefined && cur.color !== '' && HEX.test(cur.color) && <Contrast fg={cur.color} bg="#FFFFFF" what="Text colour on the white page" testId="style-contrast" />}
            {!colourOk && <div className="callout warning" role="status">Colour must be a 6-digit hex value such as #1D5941.</div>}
            <StyleSample st={cur} />
            <div className="row"><button className="btn ghost danger-text sm" onClick={() => remove(cur.id)} data-testid="style-delete">Delete style</button></div>
          </>
        )}
      </div>
      <div className="sb-foot">
        {msg && <div className={`callout ${msg.kind === 'error' ? 'error' : 'accent'}`} role={msg.kind === 'error' ? 'alert' : 'status'} data-testid="styles-message">{msg.text}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={apply} disabled={!dirty} data-testid="styles-apply">Save styles</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- brand kit */

function BrandPane({ project, onClose }: { project: Project; onClose: () => void }) {
  const dispatch = useStudio((s) => s.dispatch);
  const [kit, setKit] = useState<BrandKit>(() => project.brand ? { ...project.brand } : { primary: project.issuer?.accent ?? '#277656', accent: '#4EAF60', text: '#0F172A', fontFamily: 'Arial' });
  const [library, setLibrary] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const set = (p: Partial<BrandKit>) => setKit((k) => ({ ...k, ...p }));
  const text = kit.text && HEX.test(kit.text) ? kit.text : '#0F172A';
  const dirty = JSON.stringify(kit) !== JSON.stringify(project.brand ?? null);
  const apply = () => {
    const r = dispatch({ type: 'SET_BRAND', brand: { ...kit, ...(kit.logoDataUri ? { logoAlt: kit.logoAlt?.trim() } : {}) } });
    setMsg(r.ok ? { kind: 'ok', text: 'Brand kit applied to the page, PDF and interactive HTML.' } : { kind: 'error', text: r.message });
  };
  const remove = () => {
    const r = dispatch({ type: 'SET_BRAND', brand: null });
    if (r.ok) { setKit({ primary: project.issuer?.accent ?? '#277656', accent: '#4EAF60', text: '#0F172A', fontFamily: 'Arial' }); setMsg({ kind: 'ok', text: 'Brand kit removed. Outputs use the issuer defaults.' }); }
    else setMsg({ kind: 'error', text: r.message });
  };
  const pick = (a: PickedAsset) => { set({ logoDataUri: a.dataUri, logoAlt: kit.logoAlt || '' }); setLibrary(false); };
  return (
    <div className="sb-brand" data-testid="brand-pane">
      <div className="sb-brand-grid">
        <div>
          <ColourField label="Primary colour" value={kit.primary} onChange={(v) => set({ primary: v })} testId="brand-primary" />
          <Contrast fg="#FFFFFF" bg={kit.primary} what="White text on the primary colour (buttons, highlights)" testId="brand-primary-contrast" />
          <ColourField label="Accent colour" value={kit.accent} onChange={(v) => set({ accent: v })} testId="brand-accent" />
          <Contrast fg={kit.accent} bg="#FFFFFF" what="Accent on the white page (rules, links)" testId="brand-accent-contrast" />
          <ColourField label="Text colour" value={kit.text ?? ''} onChange={(v) => set({ text: v })} testId="brand-text" />
          <Contrast fg={text} bg="#FFFFFF" what="Text on the white page" testId="brand-text-contrast" />
          <div className="field">
            <label htmlFor="brand-font">Document font</label>
            <select id="brand-font" className="select" value={kit.fontFamily ?? 'Arial'} onChange={(e) => set({ fontFamily: e.target.value as BrandKit['fontFamily'] })} data-testid="brand-font">{FONTS.map((f) => <option key={f}>{f}</option>)}</select>
            <span className="hint">Web-safe fonts only, so PDFs keep selectable, extractable text.</span>
          </div>
          <div className="field">
            <label>Logo</label>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm" onClick={() => setLibrary(true)} data-testid="brand-logo-pick">{kit.logoDataUri ? 'Change logo' : 'Choose from image library'}</button>
              {kit.logoDataUri && <button className="btn ghost sm" onClick={() => set({ logoDataUri: undefined, logoAlt: undefined })} data-testid="brand-logo-clear">Remove logo</button>}
            </div>
            {kit.logoDataUri && (
              <div className="sb-logo-row">
                <img src={kit.logoDataUri} alt={kit.logoAlt || 'Brand logo preview'} className="sb-logo" />
                <div className="field grow"><label htmlFor="brand-alt">Logo alternative text (required)</label><input id="brand-alt" className="input" value={kit.logoAlt ?? ''} onChange={(e) => set({ logoAlt: e.target.value })} aria-invalid={!kit.logoAlt?.trim()} data-testid="brand-logo-alt" placeholder="e.g. Aster Card logo" /></div>
              </div>
            )}
            <span className="hint">Replaces the issuer mark wherever the issuer logo appears.</span>
          </div>
        </div>
        <div className="sb-brand-preview" aria-label="Brand preview" data-testid="brand-preview">
          <div className="sb-sample-paper" style={{ fontFamily: FONT_STACK[kit.fontFamily ?? 'Arial'], color: text }}>
            <div className="sb-bp-head" style={{ borderBottom: `2px solid ${HEX.test(kit.accent) ? kit.accent : '#4EAF60'}` }}>
              {kit.logoDataUri ? <img src={kit.logoDataUri} alt="" className="sb-logo" /> : <strong style={{ color: HEX.test(kit.primary) ? kit.primary : undefined }}>{project.issuer?.name}</strong>}
            </div>
            <h4 style={{ color: text, margin: '10px 0 4px' }}>Monthly statement</h4>
            <p style={{ margin: '0 0 8px', fontSize: 12.5 }}>Your payment is due soon. Review your options below.</p>
            <span className="sb-bp-btn" style={{ background: HEX.test(kit.primary) ? kit.primary : undefined }}>Review payment options</span>
          </div>
        </div>
      </div>
      <div className="sb-foot">
        {msg && <div className={`callout ${msg.kind === 'error' ? 'error' : 'accent'}`} role={msg.kind === 'error' ? 'alert' : 'status'} data-testid="brand-message">{msg.text}</div>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          {project.brand && <button className="btn ghost danger-text" onClick={remove} data-testid="brand-remove">Remove brand kit</button>}
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn primary" onClick={apply} disabled={!dirty} data-testid="brand-apply">Apply brand kit</button>
        </div>
      </div>
      {library && <AssetLibraryDialog onClose={() => setLibrary(false)} onPick={pick} />}
    </div>
  );
}

/** "Styles & brand" dialog: named text styles and the brand kit, both written through the command bus. */
export function StylesBrandDialog({ onClose, initialTab = 'styles' }: { onClose: () => void; initialTab?: 'styles' | 'brand' }) {
  const project = useStudio((s) => s.project);
  const [tab, setTab] = useState<'styles' | 'brand'>(initialTab);
  const key = useMemo(() => project?.projectId ?? '', [project?.projectId]);
  if (!project) return null;
  return (
    <Dialog title="Styles & brand" onClose={onClose} labelledBy="styles-brand-title">
      <div className="sb-root" data-testid="styles-brand-dialog" key={key}>
        <div className="tabs" role="tablist" aria-label="Styles and brand sections">
          <button role="tab" aria-selected={tab === 'styles'} onClick={() => setTab('styles')} data-testid="sb-tab-styles">Text styles</button>
          <button role="tab" aria-selected={tab === 'brand'} onClick={() => setTab('brand')} data-testid="sb-tab-brand">Brand kit</button>
        </div>
        {tab === 'styles' ? <StylesPane project={project} onClose={onClose} /> : <BrandPane project={project} onClose={onClose} />}
      </div>
    </Dialog>
  );
}
