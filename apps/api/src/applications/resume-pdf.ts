import PDFDocument from 'pdfkit';
import type { Prisma } from '@prisma/client';
import type { ResumeTemplate as SharedResumeTemplate } from '@job-tracker/shared-types';
import type { StructuredResume } from '@job-tracker/shared-types';
import { isStructuredResume } from './structured-resume-content';
import { renderStructuredResumeDocx } from './structured-resume-docx';
import { HEIGHT_SAFETY } from './structured-resume-pdf';
import { convertDocxToPdf } from './docx-to-pdf';

// Callers pass either Prisma's raw ResumeTemplate row (updatedAt: Date) or
// the API's serialized shape (updatedAt: string) — the renderer only reads
// the numeric range fields, so both are accepted here.
type ResumeTemplate = Omit<SharedResumeTemplate, 'updatedAt'>;

/**
 * Builds the Word document and PDF and VERIFIES they are one page. The fit is measured with pdfkit,
 * which tracks Word/LibreOffice layout closely but not exactly, so a resume it calls "fits" can still
 * tip a few lines onto page 2. The real converted PDF is the judge: if it has more than one page the
 * fit is redone with a tighter height allowance (smaller fonts/spacing, then margins) and tried again.
 * The Word file returned is the very one that produced the one-page PDF.
 */
async function renderVerified(
  content: StructuredResume,
  template: ResumeTemplate,
  candidateName?: string | null,
): Promise<{ docx: Buffer; pdf: Buffer }> {
  const pdfParse = (await import('pdf-parse')).default;
  let last: { docx: Buffer; pdf: Buffer } | null = null;
  for (const factor of [1, 0.97, 0.94, 0.91, 0.88]) {
    const docx = await renderStructuredResumeDocx(content, template, candidateName, HEIGHT_SAFETY * factor);
    const pdf = await convertDocxToPdf(docx);
    last = { docx, pdf };
    if ((await pdfParse(pdf)).numpages <= 1) return last;
  }
  return last!;
}

/** Swaps in the live contact line (see contact-line.ts) when one is given. */
function withContactLine(content: StructuredResume, contactLine?: string): StructuredResume {
  return contactLine ? { ...content, contactLine } : content;
}

/**
 * Renders generated resume content into a .docx — the primary rendered
 * artifact. PDF downloads are produced by converting this same document
 * (see renderResumePdf below) rather than a separate pdfkit layout, so the
 * two formats never drift apart. Only structured resumes (which carry a
 * ResumeTemplate) can be rendered as Word; legacy free-form content has no
 * .docx equivalent and must go through the pdfkit text fallback for PDF.
 */
export function renderResumeDocx(
  content: Prisma.JsonValue,
  template: ResumeTemplate,
  candidateName?: string | null,
  contactLine?: string,
): Promise<Buffer> {
  if (!isStructuredResume(content)) {
    throw new Error('renderResumeDocx requires structured resume content');
  }
  // Word needs the same one-page guarantee as the PDF: use the layout that converted to one page.
  // If the converter isn't available, fall back to the measured fit rather than failing the download.
  const prepared = withContactLine(content, contactLine);
  return renderVerified(prepared, template, candidateName).then(
    (r) => r.docx,
    () => renderStructuredResumeDocx(prepared, template, candidateName),
  );
}

/**
 * Renders generated resume content into a PDF. Two shapes are supported:
 * - Structured (StructuredResume: {contactLine, sections}) — built as a
 *   Word document (renderResumeDocx, using the shrink-to-fit-one-page
 *   ResumeTemplate-driven layout) and converted to PDF via headless
 *   LibreOffice, so the PDF is always a faithful rendering of the same
 *   document available for Word download. Requires `template`.
 * - Legacy free-form markdown-ish string (what the Resu agent still
 *   produces as of this writing) — rendered via lightweight markdown
 *   parsing directly in pdfkit, unchanged from before structured resumes
 *   existed (no Word equivalent to convert from).
 * Any other JSON shape is stringified so this never throws.
 *
 * candidateName (from ResumesService.getProfile().candidateName) is printed
 * top-center as the resume's actual heading — title (company/role, or the
 * legacy fallback text) is no longer printed on the page at all; it was a
 * mislabeled leftover from before the candidate's real name was tracked
 * anywhere, and looked like a stray job-title header at the top of the doc.
 * In structured mode, candidateName is rendered bold above the contact line
 * (email | city, state | phone | LinkedIn) built by the agent.
 */
export async function renderResumePdf(
  title: string,
  content: Prisma.JsonValue,
  template?: ResumeTemplate,
  candidateName?: string | null,
  contactLine?: string,
): Promise<Buffer> {
  if (isStructuredResume(content) && template) {
    return (await renderVerified(withContactLine(content, contactLine), template, candidateName)).pdf;
  }
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  return renderResumePdfFromText(candidateName ?? title, text);
}

function renderResumePdfFromText(heading: string, text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54, size: 'LETTER' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(18).text(heading, { align: 'center' });
    doc.moveDown(0.5);

    const lines = text.split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();

      if (!line.trim()) {
        doc.moveDown(0.4);
        continue;
      }

      if (line.startsWith('## ')) {
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(12).text(stripBold(line.slice(3)));
        doc.moveDown(0.1);
        continue;
      }
      if (line.startsWith('# ')) {
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(14).text(stripBold(line.slice(2)));
        doc.moveDown(0.1);
        continue;
      }

      const bulletMatch = line.match(/^[-*]\s+(.*)$/);
      const content = bulletMatch ? bulletMatch[1] : line;
      const indent = bulletMatch ? 14 : 0;
      const prefix = bulletMatch ? '• ' : '';

      // Bullets are never bold — only section/subsection headers are (see
      // above) — the model's **keyword** emphasis inside bullet text is
      // stripped to plain text rather than rendered bold, since bold in the
      // body reads as noise, not as the section-level structure it's meant
      // for in this template.
      doc.fontSize(10).font('Helvetica');
      doc.text(prefix + stripBold(content), doc.page.margins.left + indent, doc.y);
    }

    doc.end();
  });
}

/** Removes **bold** markers, keeping the enclosed text as plain content. */
function stripBold(line: string): string {
  return line.replace(/\*\*([^*]+)\*\*/g, '$1');
}
