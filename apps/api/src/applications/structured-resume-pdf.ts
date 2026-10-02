import PDFDocument from 'pdfkit';
import type { ResumeTemplate as SharedResumeTemplate, StructuredResume } from '@job-tracker/shared-types';

// The renderer only reads the numeric range fields — never updatedAt — so it
// accepts either the API's serialized shape (updatedAt: string) or Prisma's
// raw model (updatedAt: Date) without forcing callers to convert one to the
// other just to satisfy this function's signature.
export type ResumeTemplate = Omit<SharedResumeTemplate, 'updatedAt'>;

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

const POINTS_PER_INCH = 72;

export function resolvedFields(template: ResumeTemplate, scale: number) {
  const bulletFont = Math.max(BULLET_FONT_HARD_FLOOR, lerp(template.bulletFontMin, template.bulletFontMax, scale));
  const nameFont = bulletFont + lerp(template.nameFontOffsetMin, template.nameFontOffsetMax, scale);
  const sectionHeaderFont = nameFont + lerp(
    template.sectionHeaderFontOffsetMin,
    template.sectionHeaderFontOffsetMax,
    scale,
  );
  // Margins are stored in inches (how the Settings UI presents them) —
  // convert to points here, once, since everything downstream (pdfkit,
  // the docx renderer's pointsToTwips) works in points.
  return {
    marginTop: lerp(template.marginTopMin, template.marginTopMax, scale) * POINTS_PER_INCH,
    marginBottom: lerp(template.marginBottomMin, template.marginBottomMax, scale) * POINTS_PER_INCH,
    marginLeft: lerp(template.marginLeftMin, template.marginLeftMax, scale) * POINTS_PER_INCH,
    marginRight: lerp(template.marginRightMin, template.marginRightMax, scale) * POINTS_PER_INCH,
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
 *
 * Exported so the Word renderer (structured-resume-docx.ts) can reuse the
 * same pdfkit-measured fitting scale rather than re-implementing layout
 * measurement in the `docx` library, which has no equivalent of reading back
 * a measured height before committing to a page.
 */
export function findFittingScale(
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

export type ResolvedFields = ReturnType<typeof resolvedFields>;

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
    doc.text(part, x, y, { continued: false, lineBreak: false });
    // Not passed via text()'s own `link` option: pdfkit computes that
    // annotation's width internally from `options.textWidth`, which isn't
    // populated on this lineBreak:false/non-continued call path and comes
    // out `undefined` — producing a NaN rect and crashing annotate() with
    // "unsupported number: NaN". Calling .link() directly with the width we
    // already computed (`widths[i]`) sidesteps that pdfkit bug entirely.
    if (url) {
      doc.link(x, y, widths[i], doc.currentLineHeight(), url);
    }
    x += widths[i];
    if (i < parts.length - 1) {
      doc.text(SEP, x, y, { continued: false, lineBreak: false });
      x += sepWidth;
    }
  });
  doc.y = y + fontSize * 1.2;
  doc.x = doc.page.margins.left;
}

// pdfkit's `width` + `lineBreak: false` does not truncate — it still wraps
// character-by-character, so a long header with a narrow width renders as a
// vertical column of single characters. Truncating the string ourselves
// before handing it to doc.text() is the only reliable way to fit it.
function truncateToWidth(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (doc.widthOfString(text) <= maxWidth) return text;
  const ellipsis = '…';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid).trimEnd() + ellipsis;
    if (doc.widthOfString(candidate) <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo === 0 ? ellipsis : text.slice(0, lo).trimEnd() + ellipsis;
}

function layoutEntry(
  doc: PDFKit.PDFDocument,
  entry: StructuredResume['sections'][number]['entries'][number],
  fields: ResolvedFields,
): void {
  // Header line: "COMPANY (ALL CAPS) | Subtitle" on the left, bold, sized to
  // match the bullet font (not the larger nameFont — entry headers read at
  // the same size as the body text, just bold, per the current template),
  // with the date range right-aligned against the same tab stop the bullets
  // indent from.
  const nameY = doc.y;
  const headerText = [entry.name.toUpperCase(), entry.subtitle].filter(Boolean).join(' | ');
  const trailing = entry.dateRange ?? '';

  const contentLeft = doc.page.margins.left;
  const contentRight = doc.page.width - doc.page.margins.right;

  // Reserve space for the right-aligned date/location column based on its
  // actual rendered width (not fields.tabStop, which is an unrelated
  // bullet-indent value) so a long header truncates instead of running
  // underneath it.
  const trailingWidth = trailing ? doc.font('Helvetica').fontSize(fields.bulletFont).widthOfString(trailing) : 0;
  const headerReservedGap = trailing ? 10 : 0;
  const headerWidth = contentRight - contentLeft - trailingWidth - headerReservedGap;

  doc.font('Helvetica-Bold').fontSize(fields.bulletFont);
  const fittedHeaderText = truncateToWidth(doc, headerText, headerWidth);
  doc.text(fittedHeaderText, contentLeft, nameY, { continued: false, lineBreak: false });

  if (trailing) {
    doc
      .font('Helvetica')
      .fontSize(fields.bulletFont)
      .text(trailing, contentRight - trailingWidth, nameY, { continued: false, lineBreak: false });
    doc.y = Math.max(doc.y, nameY + fields.bulletFont * 1.2);
  }
  doc.x = contentLeft;
  doc.moveDown(0.15);

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
  // A bullet ending exactly at a **bold** span (or starting with one) splits
  // into a trailing/leading EMPTY string (e.g. "...**last bold**".split(...)
  // -> [plain, bold, ""]) — skipped below via `if (!segment) return`, but
  // naively computing isLast as `i === segments.length - 1` then marks the
  // real final segment (the bold one, one index before that empty string)
  // as NOT last, so it renders with continued:true and is never properly
  // closed. The next bullet's draw call then lands mid-stream, overlapping
  // the unclosed text. Find the last actually-non-empty index instead.
  const lastNonEmptyIndex = segments.reduce(
    (last, segment, i) => (segment ? i : last),
    0,
  );
  segments.forEach((segment, i) => {
    if (!segment) return;
    const isBold = i % 2 === 1;
    const isLast = i === lastNonEmptyIndex;
    doc
      .font(isBold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(fontSize)
      .text(segment, { continued: !isLast, width });
  });
}
