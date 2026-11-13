/**
 * The size of a composed page in CSS px, read from the composed page CSS itself (`.page{width:…;height:…}`), so a
 * screen that shows composed pages always draws them at the paper size they were composed at, also when it shows two
 * versions with different paper side by side. Falls back to US Letter portrait (816 × 1056 px).
 */
const PX_PER_PT = 96 / 72;
const LETTER = { w: 816, h: 1056 };

export function pageBoxFromCss(css: string | undefined | null): { w: number; h: number } {
  const m = /\.page\{width:([\d.]+)(pt|px);height:([\d.]+)(pt|px)/.exec(css ?? '');
  if (!m) return LETTER;
  const px = (v: string, unit: string) => Math.round(unit === 'pt' ? Number(v) * PX_PER_PT : Number(v));
  const w = px(m[1], m[2]), h = px(m[3], m[4]);
  return w > 0 && h > 0 ? { w, h } : LETTER;
}
