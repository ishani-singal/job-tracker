import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Converts a .docx buffer to PDF via headless LibreOffice, so the PDF
 * download is always a faithful rendering of the same Word document the
 * user can download directly — one source of truth, not two renderers
 * drifting apart. Requires `soffice` on the server's PATH (installed
 * separately; see CLAUDE.md Deployment section).
 */
export async function convertDocxToPdf(docxBuffer: Buffer): Promise<Buffer> {
  const workDir = await mkdtemp(join(tmpdir(), 'resume-docx-'));
  try {
    const docxPath = join(workDir, 'resume.docx');
    await writeFile(docxPath, docxBuffer);

    await execFileAsync(
      'soffice',
      ['--headless', '--convert-to', 'pdf', '--outdir', workDir, docxPath],
      { timeout: 60_000 },
    );

    const pdfPath = join(workDir, 'resume.pdf');
    return await readFile(pdfPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
