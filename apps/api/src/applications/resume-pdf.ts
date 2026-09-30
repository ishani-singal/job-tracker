import PDFDocument from 'pdfkit';
import type { Prisma } from '@prisma/client';
import type { ResumeTemplate as SharedResumeTemplate } from '@job-tracker/shared-types';
import { isStructuredResume } from './structured-resume-content';
import { renderStructuredResumePdf } from './structured-resume-pdf';

// Callers pass either Prisma's raw ResumeTemplate row (updatedAt: Date) or
// the API's serialized shape (updatedAt: string) — the renderer only reads
// the numeric range fields, so both are accepted here.
type ResumeTemplate = Omit<SharedResumeTemplate, 'updatedAt'>;

/**
 * Renders generated resume content into a PDF. Two shapes are supported:
 * - Structured (StructuredResume: {contactLine, sections}) — rendered via
 *   the shrink-to-fit-one-page ResumeTemplate-driven renderer. Requires
 *   `template` (fetch via ResumesService.getResumeTemplate() first).
 * - Legacy free-form markdown-ish string (what the Resu agent still
 *   produces as of this writing) — rendered via lightweight markdown
 *   parsing, unchanged from before structured resumes existed.
 * Any other JSON shape is stringified so this never throws.
 *
 * candidateName (from ResumesService.getProfile().candidateName) is printed
 * top-center as the resume's actual heading — title (company/role, or the
 * legacy fallback text) is no longer printed on the page at all; it was a
 * mislabeled leftover from before the candidate's real name was tracked
 * anywhere, and looked like a stray job-title header at the top of the doc.
 */
export function renderResumePdf(
  title: string,
  content: Prisma.JsonValue,
  template?: ResumeTemplate,
  candidateName?: string | null,
): Promise<Buffer> {
  if (isStructuredResume(content) && template) {
    return renderStructuredResumePdf(content, template);
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
