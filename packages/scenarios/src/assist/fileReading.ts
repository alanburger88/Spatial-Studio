/**
 * "Rebuild from a file" (wave 3, section 1): what the studio read from an existing PDF or Word file. The server reads the
 * file (`apps/api/src/importFile.ts`) and produces this plain description; everything after that (likely personal
 * details, comparing samples, what would be sent to a model, the built-in proposal) is a pure function of it.
 *
 * A reading holds the file's text and layout only: never the file name, never image pixels. Positions are in points
 * from the top-left corner of the page.
 */
export type FileKind = 'pdf' | 'docx';
export const FILE_KIND_LABEL: Record<FileKind, string> = { pdf: 'PDF', docx: 'Word' };

export interface ReadBox { x: number; y: number; w: number; h: number }

export type ReadBlockKind = 'heading' | 'paragraph' | 'list' | 'table';

export interface ReadBlock {
  /** Unique within its reading: `b1`, `b2`, … in reading order. */
  id: string;
  kind: ReadBlockKind;
  /** 1-based. A Word file counts its explicit page breaks. */
  page: number;
  /** Headings: 1 (largest) to 3. */
  level?: 1 | 2 | 3;
  /** Heading and paragraph: its lines. List: its items. Table: empty (see `rows`). */
  lines: string[];
  /** Table: its rows of cells, in order. */
  rows?: string[][];
  /** Table: the first row names the columns. */
  headerRow?: boolean;
  /** PDF only: where the block is on its page. */
  box?: ReadBox;
  /** PDF only: the font size of the block's text, in points. */
  sizePt?: number;
  bold?: boolean;
  italic?: boolean;
  /** Text clearly smaller than the body text (small print). */
  small?: boolean;
}

export interface ReadImage { page: number; box?: ReadBox; widthPt: number; heightPt: number }

/** Things in the file that the studio never runs or follows. They are counted and reported, not read. */
export type IgnoredKind = 'macro' | 'script' | 'embedded' | 'link' | 'trackedChange' | 'comment' | 'field' | 'form' | 'headerFooter' | 'activeX' | 'textBox' | 'other';
export interface IgnoredPart { kind: IgnoredKind; count: number; text: string }

export type ReadPaperSize = 'US-Letter' | 'A4' | 'US-Legal';
export interface ReadPaper { widthPt: number; heightPt: number; size: ReadPaperSize | null; landscape: boolean }

export interface FileReading {
  kind: FileKind;
  pages: number;
  paper: ReadPaper;
  blocks: ReadBlock[];
  images: ReadImage[];
  ignored: IgnoredPart[];
  /** Plain sentences about how the file was read (for example a table that could not be told apart reliably). */
  notes: string[];
  /** Font names used by the file (PDF) or its styles (Word), for the report of what is not brought across. */
  fonts: string[];
  /** PDF: the size most of the text is set in. */
  bodySizePt?: number;
}

/** The text of a block as one string (lines joined by line breaks; a table's rows as cells separated by " | "). */
export function blockText(b: ReadBlock): string {
  if (b.kind === 'table') return (b.rows ?? []).map((r) => r.join(' | ')).join('\n');
  return b.lines.join('\n');
}

/** Which standard paper a page size is, within 3 pt either way (either orientation). */
export function paperOf(widthPt: number, heightPt: number): ReadPaper {
  const landscape = widthPt > heightPt + 1;
  const w = Math.min(widthPt, heightPt), h = Math.max(widthPt, heightPt);
  const near = (a: number, b: number) => Math.abs(a - b) <= 3;
  const size: ReadPaperSize | null = near(w, 612) && near(h, 792) ? 'US-Letter' : near(w, 595.28) && near(h, 841.89) ? 'A4' : near(w, 612) && near(h, 1008) ? 'US-Legal' : null;
  return { widthPt: Math.round(widthPt * 100) / 100, heightPt: Math.round(heightPt * 100) / 100, size, landscape };
}

export const PAPER_LABEL: Record<ReadPaperSize, string> = { 'US-Letter': 'US Letter', A4: 'A4', 'US-Legal': 'US Legal' };
