import type { DocNode, Project } from '@iss/model';

/**
 * Suggests a description (alternative text) for a picture from what the model knows about it: the component's name,
 * the issuer, any accessibility label and where the picture sits. The picture itself is never looked at, and every
 * suggestion says so in `basis`. A person accepts or rewrites it.
 */

const MAX = 120;
const LOGO = /\b(logo|logotype|wordmark|brand ?mark|emblem|crest)\b/i;
const MARK = /(^|[-_:/ ])(logo|mark|brand)([-_. ]|$)/i;
/** Words that say "this is a picture" and nothing about what it shows. */
const FILLER = /\b(image|images|picture|pictures|photo|photos|photograph|graphic|graphics|img|pic|icon|illustration|figure|placeholder|untitled|new|copy|component|node|\d+)\b/gi;

const tidy = (s: string): string => s.replace(/\s+/g, ' ').replace(/^[\s·,;:–—-]+|[\s·,;:–—-]+$/g, '').trim();
const sentenceCase = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function clip(s: string): string {
  if (s.length <= MAX) return s;
  const cut = s.slice(0, MAX - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > 40 ? cut.slice(0, at) : cut).replace(/[\s,;:–—-]+$/, '')}…`;
}

/** Never "Image of …": a screen reader already announces that it is a picture. */
const noImageOf = (s: string): string => s.replace(/^\s*(an?\s+|the\s+)?(image|picture|photo|photograph|graphic|illustration|icon)\s+(of|showing|shows)\s+/i, '');

type Place = 'header' | 'footer' | 'body';

function placeOf(project: Project, node: DocNode): Place {
  let cur: DocNode | undefined = node;
  for (let depth = 0; cur && depth < 12; depth++) {
    const area = cur.layout?.html?.area;
    if (area === 'header') return 'header';
    if (area === 'footer') return 'footer';
    if (area === 'main' || area === 'aside') return 'body';
    const p = cur.layout?.paged;
    if (p?.mode === 'fixed' && typeof p.yPt === 'number') return p.yPt < 170 ? 'header' : p.yPt > 720 ? 'footer' : 'body';
    const id: string = cur.id;
    cur = project.nodes.find((n) => n.children?.includes(id));
  }
  return 'body';
}

/** A readable name from an asset reference such as "asset:aster-mark" or ".../rewards-banner.png"; nothing for data URIs or hashes. */
function nameFromSource(src: string | undefined): string {
  if (!src || /^data:/i.test(src)) return '';
  const last = src.split(/[/:]/).filter(Boolean).pop() ?? '';
  const base = last.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[?#].*$/, '');
  if (!/[a-z]{3,}/i.test(base) || /^[a-f0-9-]{12,}$/i.test(base)) return '';
  return tidy(base.replace(/[-_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2'));
}

const placeWords: Record<Place, string> = { header: 'in the header', footer: 'in the footer', body: 'in the body of the document' };
const NOT_SEEN = 'the picture itself was not examined';

export function suggestAltText(project: Project, nodeId: string): { text: string; basis: string } | null {
  const node = project.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== 'image') return null;
  // A decorative picture is skipped by screen readers: it needs no description.
  if (node.decorative) return null;

  const issuer = tidy(project.issuer?.name ?? '');
  const name = tidy(node.name ?? '');
  const label = tidy(node.a11y?.label ?? '');
  const src = node.image?.src;
  const place = placeOf(project, node);
  const finish = (text: string, basis: string): { text: string; basis: string } | null => {
    const t = clip(sentenceCase(tidy(noImageOf(text))));
    return t ? { text: t, basis: `${basis}; ${NOT_SEEN}` } : null;
  };

  // The project's brand logo carries its own description.
  if (src && project.brand?.logoDataUri && src === project.brand.logoDataUri && project.brand.logoAlt?.trim()) {
    return finish(project.brand.logoAlt, 'From the description saved with the brand logo');
  }

  const saysLogo = LOGO.test(name) || LOGO.test(label) || node.a11y?.role === 'logo' || MARK.test(src && !/^data:/i.test(src) ? src : '');
  if (saysLogo) {
    if (issuer) return finish(`${issuer} logo`, `From the component name and its place ${placeWords[place]}`);
    const own = tidy(noImageOf(name).replace(FILLER, ' '));
    return own ? finish(own, 'From the component name') : null;
  }

  // An accessibility label written by a person is the best description available.
  if (label && tidy(label.replace(FILLER, ' ')).length >= 3) return finish(label, 'From the accessibility label of the component');

  const meaningful = tidy(noImageOf(name).replace(FILLER, ' '));
  if (/[a-z]{3,}/i.test(meaningful)) {
    return finish(meaningful, `From the component name and its place ${placeWords[place]}`);
  }

  const fromFile = nameFromSource(src);
  const fileWords = tidy(fromFile.replace(FILLER, ' '));
  if (/[a-z]{3,}/i.test(fileWords)) return finish(fileWords, 'From the name of the picture file');

  // A picture with no telling name at the top of the first page is, by convention, the issuer's logo. Say that it is a guess.
  if (place === 'header' && issuer) return finish(`${issuer} logo`, 'A guess from its place in the header, where the issuer’s logo usually sits');

  return null;
}
