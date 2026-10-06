import PDFDocument from 'pdfkit';
import type { ResumeTemplate as SharedResumeTemplate, StructuredResume } from '@job-tracker/shared-types';

// The renderer only reads the numeric range fields — never updatedAt — so it
// accepts either the API's serialized shape (updatedAt: string) or Prisma's
// raw model (updatedAt: Date) without forcing callers to convert one to the
// other just to satisfy this function's signature.
export type ResumeTemplate = Omit<SharedResumeTemplate, 'updatedAt'>;

/**
 * Renders a StructuredResume against a ResumeTemplate's min/max ranges, fitted
 * to one LETTER page (see findFit for the order fields give way in). PDFKit's
 * own line-wrapping (which depends on font size) is the thing being fit — the
 * only reliable way to know "does this fit" is to actually lay it out.
 */
export function renderStructuredResumePdf(
  content: StructuredResume,
  template: ResumeTemplate,
  candidateName?: string | null,
): Promise<Buffer> {
  const fit = findFit(content, template, candidateName);
  return renderAtFit(content, template, fit, candidateName, /* toBuffer */ true) as Promise<Buffer>;
}

const PAGE_HEIGHT = 792; // LETTER, points
const PAGE_WIDTH = 612;
const BULLET_FONT_HARD_FLOOR = 9;

function lerp(min: number, max: number, scale: number): number {
  return min + (max - min) * scale;
}

const POINTS_PER_INCH = 72;

/**
 * How far each field has been pushed from its template maximum toward its
 * minimum. `scale` (1 = max, 0 = min) drives the body fields — bullet font,
 * section header, spacing. Margins and the name font stay at their maximums
 * until the body fields are already at their minimums: only then are margins
 * cut by `marginCut` inches (each stopping at its own minimum) and the name
 * font by `nameCut` points.
 */
export interface FitParams {
  scale: number;
  marginCut: number;
  nameCut: number;
}

const MARGIN_STEP_INCHES = 0.01;
const NAME_FONT_STEP_POINTS = 0.5;

function cutMargin(min: number, max: number, cut: number): number {
  return Math.max(min, max - cut);
}

export function resolvedFields(template: ResumeTemplate, fit: FitParams) {
  const { scale } = fit;
  const bulletFont = Math.max(BULLET_FONT_HARD_FLOOR, lerp(template.bulletFontMin, template.bulletFontMax, scale));
  const nameFont =
    bulletFont + Math.max(template.nameFontOffsetMin, template.nameFontOffsetMax - fit.nameCut);
  const sectionHeaderFont = bulletFont + lerp(
    template.sectionHeaderFontOffsetMin,
    template.sectionHeaderFontOffsetMax,
    scale,
  );
  // Margins are stored in inches (how the Settings UI presents them) —
  // convert to points here, once, since everything downstream (pdfkit,
  // the docx renderer's pointsToTwips) works in points.
  return {
    marginTop: cutMargin(template.marginTopMin, template.marginTopMax, fit.marginCut) * POINTS_PER_INCH,
    marginBottom: cutMargin(template.marginBottomMin, template.marginBottomMax, fit.marginCut) * POINTS_PER_INCH,
    marginLeft: cutMargin(template.marginLeftMin, template.marginLeftMax, fit.marginCut) * POINTS_PER_INCH,
    marginRight: cutMargin(template.marginRightMin, template.marginRightMax, fit.marginCut) * POINTS_PER_INCH,
    bulletFont,
    nameFont,
    sectionHeaderFont,
    tabStop: template.horizontalTabStop,
    spacingBeforeSection: lerp(template.spacingBeforeSectionMin, template.spacingBeforeSectionMax, scale),
    spacingAfterSection: lerp(template.spacingAfterSectionMin, template.spacingAfterSectionMax, scale),
    spacingBetweenBullets: lerp(template.spacingBetweenBulletsMin, template.spacingBetweenBulletsMax, scale),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Finds how much each field has to give to fit one page, in this order:
 *  1. Margins and the name font stay at their maximums while everything else
 *     (bullet font, section header, spacing) is binary-searched on `scale`.
 *  2. Only if the page still overflows with all of that at its minimum, margins
 *     are cut — as a last step — in 0.01" increments, each down to its own
 *     minimum.
 *  3. If it still overflows with margins at their minimums, the name font is
 *     reduced in 0.5pt increments down to its minimum.
 * If nothing fits even then, the all-minimums layout is returned.
 *
 * Exported so the Word renderer (structured-resume-docx.ts) can reuse the
 * same pdfkit-measured fit rather than re-implementing layout measurement in
 * the `docx` library, which has no equivalent of reading back a measured
 * height before committing to a page.
 */
export function findFit(
  content: StructuredResume,
  template: ResumeTemplate,
  candidateName?: string | null,
): FitParams {
  const fits = (fit: FitParams) => fitsOnOnePage(content, template, fit, candidateName);

  if (fits({ scale: 0, marginCut: 0, nameCut: 0 })) {
    let low = 0;
    let high = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (low + high) / 2;
      if (fits({ scale: mid, marginCut: 0, nameCut: 0 })) low = mid;
      else high = mid;
    }
    return { scale: low, marginCut: 0, nameCut: 0 };
  }

  const marginSpan = Math.max(
    template.marginTopMax - template.marginTopMin,
    template.marginBottomMax - template.marginBottomMin,
    template.marginLeftMax - template.marginLeftMin,
    template.marginRightMax - template.marginRightMin,
  );
  for (let cut = MARGIN_STEP_INCHES; cut < marginSpan + MARGIN_STEP_INCHES / 2; cut = round2(cut + MARGIN_STEP_INCHES)) {
    const marginCut = Math.min(cut, marginSpan);
    if (fits({ scale: 0, marginCut, nameCut: 0 })) return { scale: 0, marginCut, nameCut: 0 };
  }

  const nameSpan = template.nameFontOffsetMax - template.nameFontOffsetMin;
  for (let cut = NAME_FONT_STEP_POINTS; cut < nameSpan + NAME_FONT_STEP_POINTS / 2; cut += NAME_FONT_STEP_POINTS) {
    const nameCut = Math.min(cut, nameSpan);
    if (fits({ scale: 0, marginCut: marginSpan, nameCut })) return { scale: 0, marginCut: marginSpan, nameCut };
  }
  return { scale: 0, marginCut: marginSpan, nameCut: Math.max(0, nameSpan) };
}

/**
 * Whether the resume fits one page after the fit search has given every field
 * all the room the template allows, and by how many points it overflows if not
 * (the resume agent's pipeline uses this to tell the model to cut content).
 */
export function measureOverflow(
  content: StructuredResume,
  template: ResumeTemplate,
  candidateName?: string | null,
): { fits: boolean; overflowPoints: number; bulletFont: number } {
  const fit = findFit(content, template, candidateName);
  const fields = resolvedFields(template, fit);
  const used = measureHeight(content, template, fit, candidateName);
  const available = PAGE_HEIGHT - fields.marginTop - fields.marginBottom;
  return { fits: used <= available, overflowPoints: Math.max(0, used - available), bulletFont: fields.bulletFont };
}

function fitsOnOnePage(
  content: StructuredResume,
  template: ResumeTemplate,
  fit: FitParams,
  candidateName?: string | null,
): boolean {
  const usedHeight = measureHeight(content, template, fit, candidateName);
  const fields = resolvedFields(template, fit);
  const available = PAGE_HEIGHT - fields.marginTop - fields.marginBottom;
  return usedHeight <= available;
}

/** Lays the resume out on an off-screen doc and reads back doc.y to measure total height, without ever calling doc.end()/emitting bytes. */
function measureHeight(
  content: StructuredResume,
  template: ResumeTemplate,
  fit: FitParams,
  candidateName?: string | null,
): number {
  const fields = resolvedFields(template, fit);
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
  // When content overflows, pdfkit silently starts a new page and doc.y resets
  // to the top of it, which reads as "short" — so overflow has to be detected
  // by page count (bufferPages is on), not by height alone.
  const pages = doc.bufferedPageRange().count;
  doc.end();
  // Total height used across pages, so an overflow reports how far over it is.
  const contentHeight = PAGE_HEIGHT - fields.marginTop - fields.marginBottom;
  return pages > 1 ? (pages - 1) * contentHeight + (endY - fields.marginTop) : endY - fields.marginTop;
}

async function renderAtFit(
  content: StructuredResume,
  template: ResumeTemplate,
  fit: FitParams,
  candidateName: string | null | undefined,
  toBuffer: boolean,
): Promise<Buffer | void> {
  const fields = resolvedFields(template, fit);
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

  const contactFontSize = fields.bulletFont;
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
      layoutEntry(doc, entry, fields, isPlainEntry(entry, section.heading));
    }
  }
}

/**
 * A Skills-style entry: no name of its own (or one that just repeats the
 * section heading), no subtitle/dates/link. Its lines ("Technical Skills: …",
 * "Core Skills: …") are plain labelled text, so they render flush left with no
 * header line, bullet glyph or indent — not as bullets under an empty header.
 * Exported for the Word renderer.
 */
export function isPlainEntry(
  entry: StructuredResume['sections'][number]['entries'][number],
  sectionHeading: string,
): boolean {
  const name = entry.name.trim().toLowerCase();
  const blankOrHeading = name === '' || name === sectionHeading.trim().toLowerCase();
  return blankOrHeading && !entry.subtitle && !entry.dateRange && !entry.url;
}

const LINK_COLOR = '#0563C1'; // Word's standard hyperlink blue, matched here for consistency

/**
 * Renders the " | "-joined contact line centered, turning any segment that
 * looks like a LinkedIn URL into a clickable, underlined blue hyperlink so
 * it's visually recognizable as a link rather than indistinguishable from
 * plain text.
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
    if (url) doc.fillColor(LINK_COLOR);
    // Not passed via text()'s own `link`/`underline` options: both compute
    // their annotation/line geometry internally from `options.textWidth`,
    // which isn't populated on this lineBreak:false/non-continued call
    // path and comes out `undefined` — producing a NaN rect/line and
    // crashing with "unsupported number: NaN". Drawing the link annotation
    // and underline manually with the width we already computed
    // (`widths[i]`) sidesteps that pdfkit bug entirely.
    doc.text(part, x, y, { continued: false, lineBreak: false });
    if (url) {
      const underlineY = y + doc.currentLineHeight();
      doc.moveTo(x, underlineY).lineTo(x + widths[i], underlineY).lineWidth(0.5).stroke(LINK_COLOR);
      doc.link(x, y, widths[i], doc.currentLineHeight(), url);
      doc.fillColor('black');
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
  plain = false,
): void {
  if (plain) {
    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.right - left;
    for (const line of entry.bullets) {
      doc.font('Helvetica').fontSize(fields.bulletFont);
      doc.x = left;
      layoutBoldedText(doc, line, fields.bulletFont, width);
      doc.moveDown(fields.spacingBetweenBullets / fields.bulletFont);
    }
    doc.x = left;
    doc.moveDown(fields.spacingAfterSection / fields.bulletFont / 2);
    return;
  }

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
  if (entry.url) doc.fillColor(LINK_COLOR);
  doc.text(fittedHeaderText, contentLeft, nameY, { continued: false, lineBreak: false });
  if (entry.url) {
    // Same manual link/underline pattern as layoutContactLine — text()'s
    // own `link`/`underline` options compute their geometry from
    // options.textWidth, which isn't populated on this lineBreak:false/
    // non-continued call path and produces a NaN rect/line that crashes.
    const linkWidth = doc.widthOfString(fittedHeaderText);
    const underlineY = nameY + doc.currentLineHeight();
    doc
      .moveTo(contentLeft, underlineY)
      .lineTo(contentLeft + linkWidth, underlineY)
      .lineWidth(0.5)
      .stroke(LINK_COLOR);
    doc.link(contentLeft, nameY, linkWidth, doc.currentLineHeight(), entry.url);
    doc.fillColor('black');
  }

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
