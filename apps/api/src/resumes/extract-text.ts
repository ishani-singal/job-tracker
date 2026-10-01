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
 * Extracts plain text from an uploaded Stories/Resume file so the agent can
 * actually read its content, not just see filename metadata. Supports the
 * formats a resume/stories doc realistically arrives in; falls back to raw
 * UTF-8 decode for anything else (works fine for .txt/.md, garbles binary
 * formats we don't specifically handle — acceptable since those aren't
 * expected upload types here).
 */
export async function extractTextFromFile(storedPath: string, mimeType: string): Promise<string> {
  const buffer = await readFile(join(UPLOAD_DIR, storedPath));

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

  return buffer.toString('utf-8');
}
