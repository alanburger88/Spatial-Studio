import {
  LIBRARY_KIND_LABEL, applyCommand, digestOf, libraryContentFingerprint, linkFor,
  type LibraryActor, type LibraryContent, type LibraryWordingContent, type LibraryItemInfo, type LibraryKind, type LibrarySource, type LibraryUsage, type LibraryVersionInfo, type Project, type SyntheticRecord,
} from '@iss/model';
import { compareVersions, summarizeChanges, type DuplicateDocumentInput, type DuplicateLibraryInput, type DuplicateScan, type VersionComparison } from '@iss/scenarios';
import type { Store } from './db';
import { HOUSE } from '@iss/model/samples/index';

/**
 * The shared library on the server: items and their numbered versions.
 *
 * `library_versions` holds each version's content. A version is a draft until an approver approves it; from then on it is
 * frozen: the table refuses any change to an approved row (`library_versions_are_frozen`) and refuses to delete one
 * (`library_versions_are_kept`), except during the test reset, which opens a gate row for one transaction (off unless the
 * server runs with LIBRARY_RESET=allow). A draft can be edited or discarded; approving it makes it the next approved version.
 * There is at most one draft per item, and it always has the next number after the approved ones.
 */
export class LibraryStore {
  constructor(private store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS library_items(item_id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, source TEXT, created_by_id TEXT, created_by_name TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS library_versions(item_id TEXT NOT NULL, number INTEGER NOT NULL, json TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, note TEXT NOT NULL, created_by_id TEXT, created_by_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, approved_by_id TEXT, approved_by_name TEXT, approved_at TEXT, PRIMARY KEY(item_id, number));
      CREATE TABLE IF NOT EXISTS library_reset_gate(open INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS library_versions_are_frozen BEFORE UPDATE ON library_versions WHEN OLD.state = 'approved' BEGIN SELECT RAISE(ABORT, 'An approved library version is frozen: a change is a new version.'); END;
      CREATE TRIGGER IF NOT EXISTS library_versions_are_kept BEFORE DELETE ON library_versions WHEN OLD.state = 'approved' AND (SELECT COUNT(*) FROM library_reset_gate) = 0 BEGIN SELECT RAISE(ABORT, 'An approved library version is never deleted.'); END;
    `);
  }

  private actor = (id: unknown, name: unknown): LibraryActor | null => (name ? { id: String(id ?? ''), name: String(name) } : null);
  private versionRow = (v: any): LibraryVersionInfo => ({
    version: v.number, state: v.state, note: v.note, createdAt: v.created_at, createdBy: this.actor(v.created_by_id, v.created_by_name), updatedAt: v.updated_at,
    approvedAt: v.approved_at ?? null, approvedBy: this.actor(v.approved_by_id, v.approved_by_name), fingerprint: v.fingerprint,
  });

  /** Every item with its versions (newest first), without content. */
  list(): LibraryItemInfo[] {
    const versions = this.store.db.prepare('SELECT item_id, number, fingerprint, state, note, created_by_id, created_by_name, created_at, updated_at, approved_by_id, approved_by_name, approved_at FROM library_versions ORDER BY number DESC').all() as any[];
    return (this.store.db.prepare('SELECT * FROM library_items ORDER BY title COLLATE NOCASE, item_id').all() as any[]).map((r) => {
      const vs = versions.filter((v) => v.item_id === r.item_id).map(this.versionRow);
      return {
        id: r.item_id, kind: r.kind, title: r.title, description: r.description, createdAt: r.created_at, createdBy: this.actor(r.created_by_id, r.created_by_name),
        source: r.source ? JSON.parse(r.source) as LibrarySource : null,
        latest: vs.find((v) => v.state === 'approved')?.version ?? null, draft: vs.find((v) => v.state === 'draft')?.version ?? null, versions: vs,
      };
    });
  }
  item(itemId: string): LibraryItemInfo | undefined { return this.list().find((i) => i.id === itemId); }

  /** One version's content (the latest approved one when no number is given). */
  content(itemId: string, number?: number): { version: LibraryVersionInfo; content: LibraryContent } | undefined {
    const r = (number === undefined
      ? this.store.db.prepare("SELECT * FROM library_versions WHERE item_id=? AND state='approved' ORDER BY number DESC LIMIT 1").get(itemId)
      : this.store.db.prepare('SELECT * FROM library_versions WHERE item_id=? AND number=?').get(itemId, number)) as any;
    return r ? { version: this.versionRow(r), content: JSON.parse(r.json) as LibraryContent } : undefined;
  }

  /** A new item with its first version as a draft. */
  create(i: { id: string; kind: LibraryKind; title: string; description: string; source: LibrarySource | null; by: LibraryActor | null }, content: LibraryContent, note: string): LibraryItemInfo {
    const now = new Date().toISOString();
    this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO library_items(item_id,kind,title,description,source,created_by_id,created_by_name,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(i.id, i.kind, i.title, i.description, i.source ? JSON.stringify(i.source) : null, i.by?.id ?? null, i.by?.name ?? null, now);
      this.insertDraft(i.id, 1, content, note, i.by, now);
    });
    return this.item(i.id)!;
  }

  private insertDraft(itemId: string, number: number, content: LibraryContent, note: string, by: LibraryActor | null, now: string) {
    this.store.db.prepare("INSERT INTO library_versions(item_id,number,json,fingerprint,state,note,created_by_id,created_by_name,created_at,updated_at) VALUES (?,?,?,?,'draft',?,?,?,?,?)")
      .run(itemId, number, JSON.stringify(content), libraryContentFingerprint(content), note, by?.id ?? null, by?.name ?? null, now, now);
  }

  /** Saves the item's draft: edits the one there is, or starts the next version. Approved versions are never touched. */
  saveDraft(itemId: string, content: LibraryContent, note: string, by: LibraryActor | null, meta: { title?: string; description?: string } = {}): { item: LibraryItemInfo; version: number; created: boolean } {
    const now = new Date().toISOString();
    return this.store.transaction(() => {
      const draft = this.store.db.prepare("SELECT number FROM library_versions WHERE item_id=? AND state='draft'").get(itemId) as any;
      let number: number;
      if (draft) {
        number = draft.number;
        this.store.db.prepare("UPDATE library_versions SET json=?, fingerprint=?, note=?, updated_at=? WHERE item_id=? AND number=? AND state='draft'").run(JSON.stringify(content), libraryContentFingerprint(content), note, now, itemId, number);
      } else {
        number = Number((this.store.db.prepare('SELECT COALESCE(MAX(number),0) AS n FROM library_versions WHERE item_id=?').get(itemId) as any).n) + 1;
        this.insertDraft(itemId, number, content, note, by, now);
      }
      if (meta.title !== undefined || meta.description !== undefined) {
        const cur = this.item(itemId)!;
        this.store.db.prepare('UPDATE library_items SET title=?, description=? WHERE item_id=?').run(meta.title ?? cur.title, meta.description ?? cur.description, itemId);
      }
      return { item: this.item(itemId)!, version: number, created: !draft };
    });
  }

  /** Approves the draft: it becomes the next approved version and is frozen from now on. */
  approve(itemId: string, by: LibraryActor | null, note?: string): number | null {
    const draft = this.store.db.prepare("SELECT number, note FROM library_versions WHERE item_id=? AND state='draft'").get(itemId) as any;
    if (!draft) return null;
    this.store.db.prepare("UPDATE library_versions SET state='approved', approved_by_id=?, approved_by_name=?, approved_at=?, note=? WHERE item_id=? AND number=? AND state='draft'")
      .run(by?.id ?? null, by?.name ?? null, new Date().toISOString(), note ?? draft.note, itemId, draft.number);
    return draft.number;
  }

  /** Discards the draft. An item left with no version at all is removed. */
  discardDraft(itemId: string): number | null {
    return this.store.transaction(() => {
      const draft = this.store.db.prepare("SELECT number FROM library_versions WHERE item_id=? AND state='draft'").get(itemId) as any;
      if (!draft) return null;
      this.store.db.prepare("DELETE FROM library_versions WHERE item_id=? AND number=? AND state='draft'").run(itemId, draft.number);
      const left = Number((this.store.db.prepare('SELECT COUNT(*) AS n FROM library_versions WHERE item_id=?').get(itemId) as any).n);
      if (!left) this.store.db.prepare('DELETE FROM library_items WHERE item_id=?').run(itemId);
      return draft.number;
    });
  }

  /** Test and demo reset only (its route is off unless LIBRARY_RESET=allow): removes every item and version. */
  clear(): number {
    return this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO library_reset_gate(open) VALUES (1)').run();
      const n = Number(this.store.db.prepare('DELETE FROM library_items').run().changes);
      this.store.db.prepare('DELETE FROM library_versions').run();
      this.store.db.prepare('DELETE FROM library_reset_gate').run();
      return n;
    });
  }
}

/* ------------------------------------------------------------------ the house library seeded with the example documents */

/** Who the seeded library versions are recorded as created and approved by. */
const HOUSE_ACTOR: LibraryActor = { id: 'studio-samples', name: 'Studio samples' };

/**
 * Seeds the house library the example documents link to (`@iss/model/samples/houseLibrary.ts`): each item with its
 * approved versions, only when the library has no item of that id, so an item a person has changed (or removed in a test
 * reset) is never touched again by a restart. Returns the ids seeded now.
 */
export function seedHouseLibrary(store: Store): string[] {
  const library = new LibraryStore(store);
  const seeded: string[] = [];
  for (const item of HOUSE.list) {
    if (library.item(item.id)) continue;
    store.transaction(() => {
      const now = new Date().toISOString();
      store.db.prepare('INSERT INTO library_items(item_id,kind,title,description,source,created_by_id,created_by_name,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(item.id, item.kind, item.title, item.description, null, HOUSE_ACTOR.id, HOUSE_ACTOR.name, now);
      item.versions.forEach((v, i) => {
        store.db.prepare("INSERT INTO library_versions(item_id,number,json,fingerprint,state,note,created_by_id,created_by_name,created_at,updated_at,approved_by_id,approved_by_name,approved_at) VALUES (?,?,?,?,'approved',?,?,?,?,?,?,?,?)")
          .run(item.id, i + 1, JSON.stringify(v.content), libraryContentFingerprint(v.content), v.note, HOUSE_ACTOR.id, HOUSE_ACTOR.name, now, now, HOUSE_ACTOR.id, HOUSE_ACTOR.name, now);
      });
    });
    seeded.push(item.id);
  }
  return seeded;
}

/* ------------------------------------------------------------------ where used */

/** Every document that links to each item, at which version, and whether it is behind the latest approved version. */
export function libraryUsage(store: Store, items: LibraryItemInfo[]): Map<string, LibraryUsage[]> {
  const latest = new Map(items.map((i) => [i.id, i.latest]));
  const out = new Map<string, LibraryUsage[]>();
  for (const s of store.listProjects()) {
    const p = store.getProject(s.projectId);
    for (const l of p?.libraryLinks ?? []) {
      const list = out.get(l.itemId) ?? [];
      const top = latest.get(l.itemId);
      list.push({ projectId: p!.projectId, title: p!.title, linkId: l.linkId, version: l.version, behind: typeof top === 'number' && top > l.version });
      out.set(l.itemId, list);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the impact of an update */

export interface LibraryUpdateImpact {
  linkId: string;
  title: string;
  kind: LibraryKind;
  from: number;
  to: number;
  /** The document as it would be after the update (not stored). */
  project: Project;
  /** What each synthetic customer would see differently (the Before & after engine). */
  comparison: VersionComparison;
  /** The change in plain words, as the document's review shows it. */
  changes: Array<{ title: string; items: string[] }>;
}

/**
 * Pure: the document after updating one link to another approved version, and the impact on its synthetic customers.
 * `compareVersions` is the same engine Before & after uses. Throws a plain Error when the update cannot be applied.
 */
export function libraryUpdateImpact(project: Project, linkId: string, to: { version: number; content: LibraryContent; title?: string }, records: SyntheticRecord[]): LibraryUpdateImpact {
  const link = linkFor(project, linkId);
  if (!link) throw new Error('That library link is not in this document.');
  const r = applyCommand(project, { type: 'UPDATE_LIBRARY_LINK', linkId, version: to.version, content: to.content, title: to.title });
  if (!r.ok) throw new Error(r.message);
  const mine = records.filter((x) => x.documentType === project.documentType);
  return {
    linkId, title: link.title, kind: link.kind, from: link.version, to: to.version, project: r.project,
    comparison: compareVersions(project, r.project, mine),
    changes: summarizeChanges(project, r.project, mine).sections.map((s) => ({ title: s.title, items: s.items })),
  };
}

/** “Building block “Contact panel”” for audit labels and messages. */
export const itemWords = (kind: LibraryKind, title: string): string => `${LIBRARY_KIND_LABEL[kind].toLowerCase()} “${title}”`;

/* ------------------------------------------------------------------ duplicate wording (wave 3, section 2) */

/** The saved documents and the library's wording items a duplicate scan reads, and a key that changes whenever any of them does. */
export function duplicateSources(store: Store, library: LibraryStore): { key: string; summaries: ReturnType<Store['listProjects']>; documents(): DuplicateDocumentInput[]; items(): DuplicateLibraryInput[] } {
  const summaries = store.listProjects();
  const wording = library.list().filter((i) => i.kind === 'wording');
  const key = digestOf({
    d: summaries.map((s) => [s.projectId, s.modelVersion, s.contentDigest, s.title]),
    l: wording.map((i) => [i.id, i.title, i.versions.map((v) => [v.version, v.state, v.fingerprint])]),
  });
  return {
    key, summaries,
    documents: () => summaries.flatMap((s) => { const p = store.getProject(s.projectId); return p ? [{ projectId: p.projectId, title: p.title, project: p }] : []; }),
    items: () => wording.flatMap((i) => {
      const n = i.latest ?? i.draft;
      const got = n === null ? undefined : library.content(i.id, n);
      return got ? [{ itemId: i.id, title: i.title, version: got.version.version, state: got.version.state, content: got.content as LibraryWordingContent }] : [];
    }),
  };
}

/** The last few scans, by what they read and how they were asked; a second call with nothing changed is served from here. */
export class DuplicateScanCache {
  private entries = new Map<string, { scan: DuplicateScan; tookMs: number }>();
  constructor(private max = 8) {}
  get(key: string) { const e = this.entries.get(key); if (e) { this.entries.delete(key); this.entries.set(key, e); } return e; }
  set(key: string, v: { scan: DuplicateScan; tookMs: number }) {
    this.entries.set(key, v);
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
}

export interface LibraryLinkImpact {
  partId: string;
  /** Nothing any synthetic customer reads changes, and the message, its translations and its heading are the library's exactly. */
  identical: boolean;
  /** Why it is not identical, in plain words (null when it is). */
  difference: string | null;
  before: { title: string; type: 'text' | 'disclosure'; approvedLocales: Record<string, string> };
  after: { title: string; type: 'text' | 'disclosure'; approvedLocales: Record<string, string> };
  project: Project;
  comparison: VersionComparison;
  changes: Array<{ title: string; items: string[] }>;
}

const nonEmpty = (m: Partial<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(m).filter(([, t]) => typeof t === 'string' && t.trim())) as Record<string, string>;

/** Why a document's message is not exactly the library's wording (null: the same text, translations, heading and kind). */
export function wordingDifference(project: Project, partId: string, content: LibraryWordingContent): string | null {
  const part = project.contentParts.find((c) => c.id === partId);
  if (!part) return 'The document no longer has this message.';
  const mine = nonEmpty(part.approvedLocales), theirs = nonEmpty(content.part.approvedLocales);
  if (digestOf(mine) !== digestOf(theirs)) return Object.keys(mine).sort().join() !== Object.keys(theirs).sort().join() ? 'Its translations are not the same as the library’s.' : 'Its wording is not exactly the library’s.';
  if (part.title !== content.part.title || digestOf(nonEmpty(project.strings?.[`@title/${partId}`]?.approved ?? {})) !== digestOf(nonEmpty(content.titleTranslations ?? {}))) return 'Its heading is not the library’s.';
  if (part.type !== content.part.type) return content.part.type === 'disclosure' ? 'The library keeps it as a disclosure; the document has it as a message.' : 'The library keeps it as a message; the document has it as a disclosure.';
  return null;
}

/**
 * Pure: the document after linking one of its messages to a library wording item (`LINK_LIBRARY_ITEM` with `{ partId }`),
 * the wording before and after, and which synthetic customers would read something different (the Before & after engine).
 * Throws a plain Error when the link cannot be made.
 */
export function libraryLinkImpact(project: Project, item: { id: string; title: string }, version: number, content: LibraryWordingContent, partId: string, records: SyntheticRecord[]): LibraryLinkImpact {
  const part = project.contentParts.find((c) => c.id === partId);
  if (!part) throw new Error('The document no longer has this message.');
  const r = applyCommand(project, { type: 'LINK_LIBRARY_ITEM', item: { id: item.id, kind: 'wording', title: item.title }, version, content, placement: { partId } });
  if (!r.ok) throw new Error(r.message);
  const mine = records.filter((x) => x.documentType === project.documentType);
  const comparison = compareVersions(project, r.project, mine);
  const after = r.project.contentParts.find((c) => c.id === partId)!;
  const words = (p: typeof part) => ({ title: p.title, type: p.type, approvedLocales: nonEmpty(p.approvedLocales) });
  const difference = wordingDifference(project, partId, content) ?? (comparison.customers.some((c) => c.outcome !== 'same')
    ? (part.type === 'disclosure' ? 'Linking gives the disclosure a new version number, which its readers see.' : 'Some customers would read something different.') : null);
  return {
    partId, before: words(part), after: words(after), project: r.project, comparison, identical: difference === null, difference,
    changes: summarizeChanges(project, r.project, mine).sections.map((s) => ({ title: s.title, items: s.items })),
  };
}
