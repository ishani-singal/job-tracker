import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Converts a .docx buffer to PDF via headless LibreOffice, so the PDF
 * download is always a faithful rendering of the same Word document the
 * user can download directly — one source of truth, not two renderers
 * drifting apart. Requires `soffice` (apt) or `libreoffice` (snap) on the
 * server's PATH.
 *
 * The work dir lives under $HOME, not /tmp: the snap build of LibreOffice is
 * confined and can't see the host's /tmp ("source file could not be loaded").
 */
export async function convertDocxToPdf(docxBuffer: Buffer): Promise<Buffer> {
  const workDir = await mkdtemp(join(homedir(), 'resume-docx-'));
  try {
    const docxPath = join(workDir, 'resume.docx');
    await writeFile(docxPath, docxBuffer);

    const args = ['--headless', '--convert-to', 'pdf', '--outdir', workDir, docxPath];
    try {
      await execFileAsync('soffice', args, { timeout: 60_000 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await execFileAsync('libreoffice', args, { timeout: 60_000 });
    }

    const pdfPath = join(workDir, 'resume.pdf');
    return await readFile(pdfPath);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
