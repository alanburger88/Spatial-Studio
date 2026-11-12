import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiFailure, type AssetDto } from '../../api/client';
import { Dialog, Loading, ErrorState, Tech } from '../../ui/common';
import { Icon } from '../../ui/icons';
import './AssetLibrary.css';

/** A library image chosen for use in a document (data URI is embedded in the model so exports stay asset-free). */
export interface PickedAsset { assetId: string; name: string; dataUri: string; width: number | null; height: number | null }

const MAX_W = 1200;
const OK_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const errMsg = (e: unknown) => (e instanceof ApiFailure || e instanceof Error ? e.message : String(e));

function readAsDataUri(file: Blob): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('Could not read the file.')); r.readAsDataURL(file); });
}
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('This file could not be read as an image.')); i.src = src; });
}
function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const d = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
  return false;
}
const dataUriBytes = (u: string) => Math.floor((u.length - u.indexOf(',') - 1) * 0.75);

/** Prepare a file for upload: reject unsupported types, downscale when too large or too wide. */
async function prepare(file: File, maxBytes: number): Promise<{ name: string; dataUri: string; resized: boolean }> {
  const t = file.type.toLowerCase();
  if (t === 'image/svg+xml' || /\.svg$/i.test(file.name)) throw new Error('SVG images are not accepted (they can contain scripts). Export the logo as PNG or JPEG instead.');
  if (t === 'image/gif' || /\.gif$/i.test(file.name)) throw new Error('GIF images are not accepted. Use a PNG or JPEG instead.');
  if (!OK_TYPES.includes(t)) throw new Error('Only PNG, JPEG or WebP images can be added.');
  const original = await readAsDataUri(file);
  const img = await loadImage(original);
  if (file.size <= maxBytes && img.naturalWidth <= MAX_W) return { name: file.name, dataUri: original, resized: false };

  let scale = Math.min(1, MAX_W / img.naturalWidth);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser cannot resize images. Choose a smaller file.');
  let quality = 0.85;
  for (let attempt = 0; attempt < 12; attempt++) {
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const alpha = t !== 'image/jpeg' && hasTransparency(ctx, canvas.width, canvas.height);
    let out: string;
    if (alpha) out = canvas.toDataURL('image/png');
    else {
      // JPEG has no alpha: paint a white background first.
      ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.globalCompositeOperation = 'source-over';
      out = canvas.toDataURL('image/jpeg', quality);
    }
    if (dataUriBytes(out) <= maxBytes) return { name: file.name.replace(/\.\w+$/, '') + (alpha ? '.png' : '.jpg'), dataUri: out, resized: true };
    scale *= 0.8; quality = Math.max(0.5, quality - 0.08);
  }
  throw new Error(`Could not shrink this image below ${kb(maxBytes)}. Choose a simpler or smaller image.`);
}

/** Image asset library dialog (upload PNG/JPEG/WebP, browse, delete, pick). */
export function AssetLibraryDialog({ onClose, onPick }: { onClose: () => void; onPick: (asset: PickedAsset) => void }) {
  const [assets, setAssets] = useState<AssetDto[] | null>(null);
  const [maxBytes, setMaxBytes] = useState(280 * 1024);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [confirmDel, setConfirmDel] = useState<AssetDto | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setLoadErr(null);
    api.assets().then((r) => { setAssets(r.assets); setMaxBytes(r.maxBytes); }, (e) => setLoadErr(errMsg(e)));
  }, []);
  useEffect(load, [load]);

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    if (!list.length) return;
    setMsg(null);
    for (const f of list) {
      setBusy(`Adding ${f.name}…`);
      try {
        const p = await prepare(f, maxBytes);
        const r = await api.uploadAsset(p.name, p.dataUri);
        setMsg({ kind: 'info', text: r.asset.createdAt && assets?.some((a) => a.assetId === r.asset.assetId) ? `“${r.asset.name}” is already in the library.` : p.resized ? `Added “${r.asset.name}” (resized to fit ${kb(maxBytes)}).` : `Added “${r.asset.name}”.` });
      } catch (e) { setMsg({ kind: 'error', text: `${f.name}: ${errMsg(e)}` }); }
    }
    setBusy(null); load();
    if (fileRef.current) fileRef.current.value = '';
  };

  const pick = async (a: AssetDto) => {
    setBusy(`Loading ${a.name}…`); setMsg(null);
    try { const r = await api.asset(a.assetId); setBusy(null); onPick({ assetId: a.assetId, name: a.name, dataUri: r.dataUri, width: a.width, height: a.height }); }
    catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); setBusy(null); }
  };
  const del = async () => {
    if (!confirmDel) return;
    const a = confirmDel; setConfirmDel(null); setBusy(`Deleting ${a.name}…`);
    try { await api.deleteAsset(a.assetId); setMsg({ kind: 'info', text: `Deleted “${a.name}”. Documents already using it keep their embedded copy.` }); }
    catch (e) { setMsg({ kind: 'error', text: errMsg(e) }); }
    setBusy(null); load();
  };

  return (
    <Dialog title="Image library" onClose={confirmDel ? () => setConfirmDel(null) : onClose} labelledBy="asset-lib-title"
      footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="al" data-testid="asset-library">
        <div className={`al-drop${drag ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files); }}>
          <span>Drop PNG, JPEG or WebP images here, or</span>
          <button className="btn" onClick={() => fileRef.current?.click()} disabled={!!busy} data-testid="asset-upload"><Icon.download style={{ transform: 'rotate(180deg)' }} /> Upload image</button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" multiple hidden onChange={(e) => e.target.files && void upload(e.target.files)} data-testid="asset-file-input" aria-label="Choose image files" />
          <small className="muted">Large images are shrunk automatically to {kb(maxBytes)} or less. SVG and GIF are not accepted.</small>
        </div>
        {busy && <div className="al-msg" role="status"><span className="spinner" /> {busy}</div>}
        {msg && <div className={`callout ${msg.kind === 'error' ? 'error' : 'accent'}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>}

        {loadErr ? <ErrorState title="Could not load the image library" message={loadErr} onRetry={load} />
          : !assets ? <Loading label="Loading images…" />
          : assets.length === 0 ? <div className="empty" data-testid="asset-empty"><strong>No images yet</strong><span>Upload a logo or picture to reuse it across documents.</span></div>
          : (
            <ul className="al-grid" aria-label="Images">
              {assets.map((a) => (
                <li key={a.assetId} className="al-item" data-testid="asset-item">
                  <button className="al-pick" onClick={() => pick(a)} disabled={!!busy} data-testid="asset-pick" aria-label={`Use ${a.name}`}>
                    <span className="al-thumb"><img src={api.assetRawUrl(a.assetId)} alt="" loading="lazy" /></span>
                    <span className="al-name" title={a.name}>{a.name}</span>
                    <span className="al-meta">{a.width && a.height ? `${a.width} × ${a.height} px · ` : ''}{kb(a.size)}</span>
                    <Tech><span className="al-meta mono" title={a.sha256}>{a.assetId} · {a.sha256.slice(0, 10)}</span></Tech>
                  </button>
                  <button className="btn sm ghost icon al-del" onClick={() => setConfirmDel(a)} disabled={!!busy} aria-label={`Delete ${a.name}`} data-testid="asset-delete"><Icon.trash /></button>
                </li>
              ))}
            </ul>
          )}

        {confirmDel && (
          <div className="callout warning al-confirm" role="alertdialog" aria-label="Confirm delete">
            <span>Delete “{confirmDel.name}” from the library? Documents already using this image keep their embedded copy.</span>
            <span className="al-confirm-btns"><button className="btn sm" onClick={() => setConfirmDel(null)}>Keep</button><button className="btn sm danger" onClick={del} data-testid="asset-delete-confirm" autoFocus>Delete image</button></span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
