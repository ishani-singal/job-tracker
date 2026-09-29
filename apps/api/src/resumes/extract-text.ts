import { readFile } from 'fs/promises';
import { join } from 'path';

const UPLOAD_DIR = join(process.cwd(), '..', '..', 'data', 'uploads');

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

  return buffer.toString('utf-8');
}
