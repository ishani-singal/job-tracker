import PDFDocument from 'pdfkit';
import type { ResumeTemplate as SharedResumeTemplate, StructuredResume } from '@job-tracker/shared-types';

// The renderer only reads the numeric range fields — never updatedAt — so it
// accepts either the API's serialized shape (updatedAt: string) or Prisma's
// raw model (updatedAt: Date) without forcing callers to convert one to the
// other just to satisfy this function's signature.
type ResumeTemplate = Omit<SharedResumeTemplate, 'updatedAt'>;

/**
 * Renders a StructuredResume against a ResumeTemplate's min/max ranges,
 * picking the largest scale (1.0 = every field at its max, 0.0 = every field
 * at its min) that still fits the content on one LETTER page. Binary-searches
 * scale rather than measuring layout analytically, since PDFKit's own
 * line-wrapping (which depends on font size) is the thing being fit — the
 * only reliable way to know "does this fit" is to actually lay it out.
 */
export function renderStructuredResumePdf(
  content: StructuredResume,
  template: ResumeTemplate,
  candidateName?: string | null,
): Promise<Buffer> {
  const scale = findFittingScale(content, template, candidateName);
  return renderAtScale(content, template, scale, candidateName, /* toBuffer */ true) as Promise<Buffer>;
}

const PAGE_HEIGHT = 792; // LETTER, points
const PAGE_WIDTH = 612;
const BULLET_FONT_HARD_FLOOR = 9;

function lerp(min: number, max: number, scale: number): number {
  return min + (max - min) * scale;
}

function resolvedFields(template: ResumeTemplate, scale: number) {
  const bulletFont = Math.max(BULLET_FONT_HARD_FLOOR, lerp(template.bulletFontMin, template.bulletFontMax, scale));
  const nameFont = bulletFont + lerp(template.nameFontOffsetMin, template.nameFontOffsetMax, scale);
  const sectionHeaderFont = nameFont + lerp(
    template.sectionHeaderFontOffsetMin,
    template.sectionHeaderFontOffsetMax,
    scale,
  );
  return {
    marginTop: lerp(template.marginTopMin, template.marginTopMax, scale),
    marginBottom: lerp(template.marginBottomMin, template.marginBottomMax, scale),
    marginLeft: lerp(template.marginLeftMin, template.marginLeftMax, scale),
    marginRight: lerp(template.marginRightMin, template.marginRightMax, scale),
    bulletFont,
    nameFont,
    sectionHeaderFont,
    tabStop: template.horizontalTabStop,
    spacingBeforeSection: lerp(template.spacingBeforeSectionMin, template.spacingBeforeSectionMax, scale),
    spacingAfterSection: lerp(template.spacingAfterSectionMin, template.spacingAfterSectionMax, scale),
    spacingBetweenBullets: lerp(template.spacingBetweenBulletsMin, template.spacingBetweenBulletsMax, scale),
  };
}

/**
 * Binary search over scale in [0, 1]: higher scale means larger/looser
 * (may overflow), lower scale means smaller/tighter (always fits, since
 * scale=0 uses every field's MIN). 12 iterations gets well under 1/1000
 * granularity between min and max, plenty for point-sized font/spacing steps.
 */
function findFittingScale(
  content: StructuredResume,
  template: ResumeTemplate,
  candidateName?: string | null,
): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    if (fitsOnOnePage(content, template, mid, candidateName)) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return low;
}

function fitsOnOnePage(
  content: StructuredResume,
  template: ResumeTemplate,
  scale: number,
  candidateName?: string | null,
): boolean {
  const usedHeight = measureHeight(content, template, scale, candidateName);
  const fields = resolvedFields(template, scale);
  const available = PAGE_HEIGHT - fields.marginTop - fields.marginBottom;
  return usedHeight <= available;
}

/** Lays the resume out on an off-screen doc and reads back doc.y to measure total height, without ever calling doc.end()/emitting bytes. */
function measureHeight(
  content: StructuredResume,
  template: ResumeTemplate,
  scale: number,
  candidateName?: string | null,
): number {
  const fields = resolvedFields(template, scale);
  const doc = new PDFDocument({
    margins: {
      top: fields.marginTop,
      bottom: fields.marginBottom,
      left: fields.marginLeft,
      right: fields.marginRight,
    },
    size: 'LETTER',
    bufferPages: true,
  });
  // Nothing reads the output stream in measurement mode — just let chunks drop.
  doc.on('data', () => {});
  layoutResume(doc, content, fields, candidateName);
  const endY = doc.y;
  doc.end();
  return endY - fields.marginTop;
}

async function renderAtScale(
  content: StructuredResume,
  template: ResumeTemplate,
  scale: number,
  candidateName: string | null | undefined,
  toBuffer: boolean,
): Promise<Buffer | void> {
  const fields = resolvedFields(template, scale);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margins: {
        top: fields.marginTop,
        bottom: fields.marginBottom,
        left: fields.marginLeft,
        right: fields.marginRight,
      },
      size: 'LETTER',
    });
    const chunks: Buffer[] = [];
    if (toBuffer) {
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    }
    layoutResume(doc, content, fields, candidateName);
    doc.end();
  });
}

type ResolvedFields = ReturnType<typeof resolvedFields>;

function layoutResume(
  doc: PDFKit.PDFDocument,
  content: StructuredResume,
  fields: ResolvedFields,
  candidateName?: string | null,
): void {
  if (candidateName) {
    doc.font('Helvetica-Bold').fontSize(fields.nameFont).text(candidateName, { align: 'center' });
  }

  const contactFontSize = Math.max(BULLET_FONT_HARD_FLOOR - 1, fields.bulletFont - 1);
  doc.font('Helvetica').fontSize(contactFontSize);
  layoutContactLine(doc, content.contactLine, contactFontSize);
  doc.moveDown(0.3);

  for (const section of content.sections) {
    doc.moveDown(fields.spacingBeforeSection / fields.bulletFont);
    doc
      .font('Helvetica-Bold')
      .fontSize(fields.sectionHeaderFont)
      .text(section.heading.toUpperCase());
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(fields.spacingAfterSection / fields.bulletFont);

    for (const entry of section.entries) {
      layoutEntry(doc, entry, fields);
    }
  }
}

/**
 * Renders the " | "-joined contact line centered, turning any segment that
 * looks like a LinkedIn URL into a clickable hyperlink (still plain black
 * text — just an underlying link annotation, no blue/underline styling).
 */
function layoutContactLine(doc: PDFKit.PDFDocument, contactLine: string, fontSize: number): void {
  const parts = contactLine.split('|').map((p) => p.trim());
  const SEP = '   |   ';
  const widths = parts.map((p) => doc.widthOfString(p));
  const sepWidth = doc.widthOfString(SEP);
  const totalWidth = widths.reduce((a, b) => a + b, 0) + sepWidth * (parts.length - 1);

  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let x = doc.page.margins.left + (contentWidth - totalWidth) / 2;
  const y = doc.y;

  parts.forEach((part, i) => {
    const isLinkedIn = /linkedin\.com/i.test(part);
    const url = isLinkedIn ? (part.startsWith('http') ? part : `https://${part}`) : undefined;
    doc.text(part, x, y, { continued: false, lineBreak: false, link: url });
    x += widths[i];
    if (i < parts.length - 1) {
      doc.text(SEP, x, y, { continued: false, lineBreak: false });
      x += sepWidth;
    }
  });
  doc.y = y + fontSize * 1.2;
  doc.x = doc.page.margins.left;
}

function layoutEntry(
  doc: PDFKit.PDFDocument,
  entry: StructuredResume['sections'][number]['entries'][number],
  fields: ResolvedFields,
): void {
  const nameY = doc.y;
  doc.font('Helvetica-Bold').fontSize(fields.nameFont).text(entry.name, { continued: false });

  // Right-aligned against a horizontal tab stop measured in from the right
  // margin (mirrors fields.tabStop, which indents bullets in from the left),
  // rather than a fixed-width box, so the date column stays flush with the
  // page's right margin regardless of content width.
  const trailing = [entry.dateRange, entry.location].filter(Boolean).join(' | ');
  if (trailing) {
    const dateTabStop = doc.page.margins.left + fields.tabStop;
    const trailingWidth = doc.page.width - doc.page.margins.right - dateTabStop;
    doc
      .font('Helvetica')
      .fontSize(fields.bulletFont)
      .text(trailing, dateTabStop, nameY, {
        width: trailingWidth,
        align: 'right',
      });
    doc.y = Math.max(doc.y, nameY + fields.nameFont * 1.2);
  }

  if (entry.subtitle) {
    doc.font('Helvetica-Oblique').fontSize(fields.bulletFont).text(entry.subtitle);
  }

  doc.moveDown(0.1);
  const startX = doc.page.margins.left + fields.tabStop;
  const bulletWidth = doc.page.width - doc.page.margins.right - startX;
  for (const bullet of entry.bullets) {
    doc.font('Helvetica').fontSize(fields.bulletFont);
    const bulletTop = doc.y;
    doc.text('•', doc.page.margins.left, bulletTop, { width: fields.tabStop });
    doc.x = startX;
    doc.y = bulletTop;
    layoutBoldedText(doc, bullet, fields.bulletFont, bulletWidth);
    doc.moveDown(fields.spacingBetweenBullets / fields.bulletFont);
  }
  doc.moveDown(fields.spacingAfterSection / fields.bulletFont / 2);
}

/**
 * Renders a bullet string containing **bold** markdown spans as actual bold
 * runs (the process template instructs the model to bold newly-incorporated
 * keywords) — splits on the markers and alternates Helvetica/Helvetica-Bold
 * via PDFKit's `continued` text so the wrapped paragraph still flows as one
 * block at `width`.
 */
function layoutBoldedText(doc: PDFKit.PDFDocument, text: string, fontSize: number, width: number): void {
  const segments = text.split(/\*\*([^*]+)\*\*/);
  segments.forEach((segment, i) => {
    if (!segment) return;
    const isBold = i % 2 === 1;
    const isLast = i === segments.length - 1;
    doc
      .font(isBold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(fontSize)
      .text(segment, { continued: !isLast, width });
  });
}
