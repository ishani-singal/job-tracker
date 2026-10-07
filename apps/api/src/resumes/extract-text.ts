import { readFile } from 'fs/promises';
import { join } from 'path';
import AdmZip from 'adm-zip';

const UPLOAD_DIR = join(process.cwd(), '..', '..', 'data', 'uploads');

/**
 * Extracts plain text from a .pptx file's slide + speaker-notes XML. PPTX is
 * a zip of OOXML parts (ppt/slides/slideN.xml, ppt/notesSlides/notesSlideN.xml),
 * each holding its text runs inside <a:t>...</a:t> elements — a regex pull is
 * sufficient here (no nested/structured XML needed, just the raw text), same
 * spirit as mammoth's extractRawText for .docx.
 */
function extractPptxText(buffer: Buffer): string {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const slideNumber = (entryName: string) => {
    const match = entryName.match(/(\d+)\.xml$/);
    return match ? parseInt(match[1], 10) : 0;
  };

  const extractRuns = (xml: string) =>
    Array.from(xml.matchAll(/<a:t>(.*?)<\/a:t>/gs))
      .map((m) => m[1])
      .join(' ')
      .trim();

  const slides = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => slideNumber(a.entryName) - slideNumber(b.entryName));

  const notesByIndex = new Map<number, string>();
  for (const e of entries) {
    if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.entryName)) {
      notesByIndex.set(slideNumber(e.entryName), extractRuns(e.getData().toString('utf-8')));
    }
  }

  return slides
    .map((slide, i) => {
      const slideNum = slideNumber(slide.entryName);
      const text = extractRuns(slide.getData().toString('utf-8'));
      const notes = notesByIndex.get(slideNum);
      const parts = [`--- Slide ${i + 1} ---`, text];
      if (notes) parts.push(`Speaker notes: ${notes}`);
      return parts.join('\n');
    })
    .join('\n\n');
}

/**
 * Extracts plain text from a .xlsx file's cell contents. XLSX is also a zip
 * of OOXML parts: shared text values live once in xl/sharedStrings.xml (an
 * index-based pool, since the same string often repeats across cells) and
 * each sheet's cells in xl/worksheets/sheetN.xml reference that pool by
 * index for text (`t="s"`) or hold their own literal value otherwise
 * (numbers, inline strings, formula results). Renders one block per sheet,
 * row-by-row, so a sheet used as a free-form notes/story table (not just a
 * grid of numbers) still reads as coherent text rather than a flat word
 * salad.
 */
function extractXlsxText(buffer: Buffer): string {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const sharedStringsEntry = entries.find((e) => e.entryName === 'xl/sharedStrings.xml');
  const sharedStrings: string[] = sharedStringsEntry
    ? Array.from(sharedStringsEntry.getData().toString('utf-8').matchAll(/<si>(.*?)<\/si>/gs)).map((m) =>
        Array.from(m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs))
          .map((t) => t[1])
          .join(''),
      )
    : [];

  const sheetEntries = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const num = (name: string) => parseInt(name.match(/(\d+)\.xml$/)?.[1] ?? '0', 10);
      return num(a.entryName) - num(b.entryName);
    });

  const decodeXmlEntities = (s: string) =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");

  const renderSheet = (xml: string): string => {
    const rows = Array.from(xml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)).map((rowMatch) => {
      // Matched separately from the cell's type attribute (below) rather
      // than in one combined pattern — a single regex trying to capture an
      // optional attribute ANYWHERE before the tag's end reliably mismatches
      // once the attribute order varies, since the engine can satisfy the
      // "optional" part by matching zero characters and move on.
      const cells = Array.from(rowMatch[1].matchAll(/<c\b([^>]*)>(.*?)<\/c>/gs));
      const values = cells.map(([, cellAttrs, cellInner]) => {
        const cellType = cellAttrs.match(/\st="([^"]*)"/)?.[1];
        const valueMatch = cellInner.match(/<v>(.*?)<\/v>/s);
        const inlineStringMatch = cellInner.match(/<is>.*?<t[^>]*>(.*?)<\/t>.*?<\/is>/s);
        if (inlineStringMatch) return decodeXmlEntities(inlineStringMatch[1]);
        if (!valueMatch) return '';
        if (cellType === 's') {
          const index = parseInt(valueMatch[1], 10);
          return decodeXmlEntities(sharedStrings[index] ?? '');
        }
        return decodeXmlEntities(valueMatch[1]);
      });
      return values.filter((v) => v.trim()).join(' | ');
    });
    return rows.filter((r) => r.trim()).join('\n');
  };

  return sheetEntries
    .map((sheet, i) => {
      const text = renderSheet(sheet.getData().toString('utf-8'));
      return `--- Sheet ${i + 1} ---\n${text}`;
    })
    .filter((block) => block.split('\n').length > 1)
    .join('\n\n');
}

/**
 * Extracts plain text from an uploaded Stories/Resume file so the agent can
 * actually read its content, not just see filename metadata. Supports the
 * formats a resume/stories doc realistically arrives in; falls back to raw
 * UTF-8 decode for anything else (works fine for .txt/.md, garbles binary
 * formats we don't specifically handle — acceptable since those aren't
 * expected upload types here).
 */
export async function extractTextFromFile(storedPath: string, mimeType: string): Promise<string> {
  const buffer = await readFile(join(UPLOAD_DIR, storedPath));
  return extractTextFromBuffer(buffer, mimeType);
}

/** Same extraction for a file that's only in memory (e.g. a one-off upload that
 * shouldn't be stored as a Resume/Stories file). */
export async function extractTextFromBuffer(buffer: Buffer, mimeType: string): Promise<string> {

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimeType === 'application/pdf') {
    const pdfParse = (await import('pdf-parse')).default;
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (
    mimeType ===
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return extractPptxText(buffer);
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ) {
    return extractXlsxText(buffer);
  }

  return buffer.toString('utf-8');
}
