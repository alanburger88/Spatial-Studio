# Shared library API

Status: **built and tested (wave 2, phase 4 of the template work). The Library screen (S25, `/library`) and the library entry points in documents use it.**
Design: `docs/design/WAVE2B_PAGES_LIBRARY_WORDING.md` section 3, `docs/design/TEMPLATES_AND_CCM.md` decision 3.
Code: `apps/api/src/routes/library.ts` (routes), `apps/api/src/library.ts` (the store, where used, the impact of an update), `packages/model/src/library.ts` (kinds, validators, placing content, the read-only rule's helpers), the link commands in `packages/model/src/commands.ts`. Tests: `apps/api/test/library.test.ts`, `packages/model/test/library.test.ts`, `e2e/library.spec.ts`.

## What the library is

- **Items** live on the server, not in a project: `library_items` (id, kind, title, description, where it was first taken from, who and when) and `library_versions` (item, number, content as JSON, its fingerprint, state `draft` or `approved`, note, who saved it, who approved it and when).
- **Versions.** An item has numbered versions. There is at most one draft, and it always has the next number. Approving the draft makes it the next approved version, and from then on it is **frozen**: the table refuses any change to an approved row (`library_versions_are_frozen`) and refuses to delete one (`library_versions_are_kept`). A change is a new version. A draft can be edited or discarded; discarding the only version of an item that was never approved removes the item.
- **Kinds and their content** (`LibraryContentByKind` in `@iss/model`):

| Kind | `kind` | Content |
|---|---|---|
| Brand | `brand` | a `BrandKit` (colours, font, logo as a PNG/JPEG/WebP data URI with its description) |
| Building block | `block` | `{ nodes, contentParts, strings? }`: a component subtree (root first, every node reached from it once), the messages it uses, and the approved translations of its texts keyed `@<nodeId>/<field>` and `@title/<partId>` |
| Wording | `wording` | `{ part: { id, title, type: "text" \| "disclosure", approvedLocales }, titleTranslations? }` (English required) |
| Glossary | `glossary` | `{ entries: { <locale>: [{ source, target, note? }] } }` (target languages only, up to 200 terms each) |
| Wording rules | `wording-rules` | `{ rules: WordingRule[] }` (up to 200; the shape is below) |
| Lookup table | `lookup-table` | one `LookupTable` |

- **Content is untrusted.** `checkLibraryContent(kind, raw)` checks it for its kind and returns it cleaned (only what the kind holds); the server stores nothing else. Content is limited to 1,500,000 characters of JSON; a block to 200 components and 100 messages.

## Documents link to items

- A document holds `libraryLinks: LibraryLink[]`: `{ linkId, itemId, kind, title, version, fingerprint, target }`, where `target` is the brand, a block by its root node id (with the prefix of its ids), a content part, the glossary, the house wording rules (`project.houseWordingRules`) or a lookup table by id. `fingerprint` is the digest of the version's content as the library holds it.
- The document holds a **copy** of the content as ordinary project content, so the resolver, the renderers, releases and the runnable package never read the library.
- Three commands change links, each one undoable step: `LINK_LIBRARY_ITEM` (inserting the content, or replacing what `placement` names), `UPDATE_LIBRARY_LINK` (another approved version, in place; the block's position and its top component's layout stay the document's) and `UNLINK_LIBRARY_ITEM` (the content stays and becomes the document's own). The studio fetches the approved content from this API and sends it in the command; the command checks it again.
- **Linked content is read-only.** `applyCommand` refuses any other command that would change it (`LIBRARY_READ_ONLY`), naming the item and saying to unlink it or to change it in the library.
- A block inserted by a link gets ids `<linkId>-<library id>`, so rules and comments that point into it survive an update. A block linked in place of the component it was made from keeps its ids.
- A link whose item this studio does not have (it came with a project file) is shown as "Not in this library"; its content is kept.
- The server checks the shape of every link in a saved, sent or imported project (`libraryLinkProblems`); a broken one is refused with `422`.

## Who may do what

| Action | Author | Reviewer | Approver | Admin |
|---|---|---|---|---|
| Read items, versions, where used, the impact of an update | yes | yes | yes | yes |
| Create an item; start or edit a draft | yes | no | no | yes |
| Approve a draft | no | no | yes | yes |
| Discard a draft | yes | no | yes | yes |
| Reset (tests only) | no | no | no | yes, and only with `LIBRARY_RESET=allow` |

Refusals are in plain words: "Reviewers cannot add to the library or draft a new version; ask an author.", "Only approvers and admins can approve a library version.", "Reviewers can see the library but not change it." With sign-in off the local admin applies. Linking a document to an item is a change to the document, so it follows the document's own rights, review and approval.

## Routes

Errors have the studio's usual shape `{ "error": { "code", "message", "correlationId", ... } }`.

### `GET /api/v1/library?kind=&q=&state=`
Items (filters: `kind`; `q` in the title or description; `state` = `approved` or `draft`), sorted by title. Each is a `LibraryItemInfo` (`id, kind, title, description, createdAt, createdBy, source, latest, draft, versions[]`, newest first; a version is `{ version, state, note, createdAt, createdBy, updatedAt, approvedAt, approvedBy, fingerprint }`) plus `usage: { documents, links, behind }`. Also `can: { create, approve }` for the caller.

### `GET /api/v1/library/:itemId`
`{ item, usage: LibraryUsage[], can }`. A `LibraryUsage` is `{ projectId, title, linkId, version, behind }` (from each document's last saved version).

### `GET /api/v1/library/:itemId/versions/:version`
`{ item: { id, kind, title }, version, content }`. `:version` is a number or `latest` (the latest approved one; `404` when none is approved yet).

### `GET /api/v1/library/:itemId/usage`
`{ latest, usage }`: every document that links to the item, at which version, and whether it is behind.

### `POST /api/v1/library` (authors, admins)
Body `{ kind, title, description?, note?, content }`, or `{ kind, title, projectId, ref? }` to take the content from a saved document (`ref` is the component, message or lookup table; not needed for brand and glossary). `source: { projectId, ref }` records where it was taken from, so that document can link to it in place once approved. `201 { item }` with version 1 as a draft. `409 LIBRARY_NAME_TAKEN` for the same kind and name; `422 INVALID_CONTENT` with `problems`.

### `PUT /api/v1/library/:itemId/draft` (authors, admins)
Body `{ content }` or `{ projectId, ref }`, with `note?`, `title?`, `description?`. Edits the draft, or starts the next version when there is none. `{ item, version, created }`.

### `POST /api/v1/library/:itemId/approve` (approvers, admins)
Body `{ note? }`. The draft becomes the next approved version. `{ item, version, usage }`; `409 NO_DRAFT` when there is none. No document changes.

### `DELETE /api/v1/library/:itemId/draft` (authors, approvers, admins)
`{ item | null, discarded }`; `409 NO_DRAFT`.

### `POST /api/v1/library/:itemId/impact`
A dry run. Body `{ projectId, version?, linkId?, project? }` (`version` defaults to the latest approved; `project` is the document as it is being edited). Answers `{ linkId, title, kind, from, to, comparison, changes, content, version }`: `comparison` is the Before & after engine's `VersionComparison` of the document and the updated document over its synthetic customers (`compareVersions`), `changes` the change in plain words (`summarizeChanges`), `content` the approved content to send in `UPDATE_LIBRARY_LINK`. Nothing is stored. `404 NOT_LINKED`, `409 NOT_APPROVED`, `409 CANNOT_UPDATE` (with the command's refusal).

### `GET /api/v1/releases/:releaseId/library`
What a release took from the library, from its frozen content: `{ library: [{ itemId, title, kind, version, inLibrary }] }`.

### `POST /api/v1/library/reset` (admins; tests and demos only)
Body `{ "confirm": true }`. Refused with `403 RESET_DISABLED` unless the server runs with `LIBRARY_RESET=allow`.

## Audit

Every write is audited with ids and titles only: `library.create`, `library.draft` (`newVersion`), `library.approve` (`documentsBehind`), `library.discard` (`itemRemoved`), `library.reset`; each with `itemId`, `title`, `kind`, `version`. Activity words them in plain sentences under "Shared library".

## Releases and files

- A release freezes the links with the content (they are part of the approved project). The release package's `manifest.json` gains `library: [{ itemId, title, kind, version }]` when the template uses the library (an addition to format 1), and `README.html` a "What came from the library" table. See `docs/design/RELEASE_PACKAGE.md`.
- Saved templates and project files carry the links. Importing a file whose links name items this studio does not have keeps the content.

## The `WordingRule` shape (for the wording rules checker)

```ts
interface WordingRule {
  id: string;                 // lower-case letters, digits, dashes; max 40; unique in the list
  kind: 'banned' | 'required' | 'preferred' | 'reading-level' | 'sentence-length' | 'tone';
  severity: 'must' | 'should';   // must = a blocker; should = a warning
  phrase?: string;            // banned, required, preferred (required for these three; max 200, no < > { })
  replacement?: string;       // banned (optional), preferred (required): what to write instead
  appliesTo?: 'anywhere' | 'messages' | 'disclosures' | 'labels' | 'email' | 'sms';
  limit?: number;             // reading-level: grade 1–18; sentence-length: words 5–100 (required for these two)
  language?: string;          // a supported language; reading-level and tone: English only
  note?: string;              // max 300
}
```

`checkWordingRule(raw)` returns `{ rule, problems }` (the rule cleaned to the fields its kind takes); `validateWordingRules(list)` returns the problems of a list (empty = valid). A field a kind does not take is refused. The checker itself is not built yet.
