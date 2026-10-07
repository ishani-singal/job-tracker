import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  TabStopType,
  TextRun,
  BorderStyle,
} from 'docx';
import type { StructuredResume } from '@job-tracker/shared-types';
import { parseContactLine } from './contact-line';
import {
  findFit,
  isPlainEntry,
  resolvedFields,
  type ResolvedFields,
  type ResumeTemplate,
} from './structured-resume-pdf';

// Word measures font sizes in half-points.
const pt = (points: number) => Math.round(points * 2);

/**
 * Renders a StructuredResume as a .docx, using the exact same fit
 * pdfkit would compute for the PDF (findFit/resolvedFields) so the
 * two renderers stay visually consistent — pdfkit is kept around purely as a
 * layout-measurement tool (it can read back a measured height before
 * committing to a page; `docx` has no equivalent), never to emit bytes here.
 */
export async function renderStructuredResumeDocx(
  content: StructuredResume,
  template: ResumeTemplate,
  candidateName?: string | null,
): Promise<Buffer> {
  const fit = findFit(content, template, candidateName);
  const fields = resolvedFields(template, fit);
  const doc = buildDocument(content, fields, candidateName);
  return Packer.toBuffer(doc);
}

const PAGE_WIDTH_TWIPS = 12240; // LETTER, twips (1/20 pt)
const PAGE_HEIGHT_TWIPS = 15840;

function pointsToTwips(points: number): number {
  return Math.round(points * 20);
}

function buildDocument(content: StructuredResume, fields: ResolvedFields, candidateName?: string | null): Document {
  const contentWidthTwips =
    PAGE_WIDTH_TWIPS - pointsToTwips(fields.marginLeft) - pointsToTwips(fields.marginRight);
  const tabStopTwips = pointsToTwips(fields.tabStop);
  const contactFontPt = fields.bulletFont;

  const children: Paragraph[] = [];

  if (candidateName) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: candidateName, bold: true, size: pt(fields.nameFont) })],
      }),
    );
  }

  children.push(layoutContactLine(content.contactLine, contactFontPt));

  for (const section of content.sections) {
    children.push(
      new Paragraph({
        spacing: {
          before: pointsToTwips(fields.spacingBeforeSection),
          after: pointsToTwips(fields.spacingAfterSection),
        },
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 4, space: 2, color: '000000' },
        },
        children: [
          new TextRun({ text: section.heading.toUpperCase(), bold: true, size: pt(fields.sectionHeaderFont) }),
        ],
      }),
    );

    section.entries.forEach((entry, i) => {
      children.push(
        ...layoutEntry(entry, fields, contentWidthTwips, tabStopTwips, isPlainEntry(entry, section.heading), i === 0),
      );
    });
  }

  return new Document({
    // Without a named font the .docx falls back to the viewer's default (a serif at 12pt in
    // LibreOffice), so the PDF was laid out differently from the fit measurement, which uses
    // Helvetica. Arial is metric-compatible with Helvetica (LibreOffice maps it to Liberation
    // Sans), so the two agree on line breaks and heights.
    styles: { default: { document: { run: { font: 'Arial' } } } },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH_TWIPS, height: PAGE_HEIGHT_TWIPS },
            margin: {
              top: pointsToTwips(fields.marginTop),
              bottom: pointsToTwips(fields.marginBottom),
              left: pointsToTwips(fields.marginLeft),
              right: pointsToTwips(fields.marginRight),
            },
          },
        },
        children,
      },
    ],
  });
}

/** Mirrors layoutContactLine: " | "-joined, centered; LinkedIn/GitHub URLs and the portfolio text become hyperlinks. */
function layoutContactLine(contactLine: string, fontPt: number): Paragraph {
  const parts = parseContactLine(contactLine);
  const runs: (TextRun | ExternalHyperlink)[] = [];

  parts.forEach((part, i) => {
    if (part.url) {
      runs.push(
        new ExternalHyperlink({
          link: part.url,
          children: [new TextRun({ text: part.text, size: pt(fontPt), color: '0563C1', underline: {} })],
        }),
      );
    } else {
      runs.push(new TextRun({ text: part.text, size: pt(fontPt) }));
    }
    if (i < parts.length - 1) {
      runs.push(new TextRun({ text: '   |   ', size: pt(fontPt) }));
    }
  });

  return new Paragraph({ alignment: AlignmentType.CENTER, children: runs });
}

/**
 * Mirrors layoutEntry: header reads "COMPANY (ALL CAPS) | Subtitle", bold,
 * sized to match the bullet font (not the larger nameFont — entry headers
 * are the same size as body text, just bold), with date/location
 * right-aligned at a tab stop, then bullets. The horizontal rule lives only
 * under each section heading now, not under every entry.
 */
function layoutEntry(
  entry: StructuredResume['sections'][number]['entries'][number],
  fields: ResolvedFields,
  contentWidthTwips: number,
  tabStopTwips: number,
  plain = false,
  first = false,
): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  // Gap above this entry's header (the first entry sits right under its
  // section header, whose own "after" spacing already covers it).
  const before = first ? 0 : pointsToTwips(fields.spacingBeforeEntryHeader);

  // Skills-style entry: labelled plain lines — no header, bullet or indent.
  if (plain) {
    return entry.bullets.map(
      (line, i) =>
        new Paragraph({
          spacing: { before: i === 0 ? before : 0, after: pointsToTwips(fields.spacingBetweenBullets) },
          children: layoutBoldedRuns(line, fields.bulletFont),
        }),
    );
  }

  const trailing = entry.dateRange ?? '';
  // Only the name is the hyperlink; the " | description/title" after it stays
  // plain bold text, so a project's short description isn't underlined as a link.
  const nameRun = entry.url
    ? new TextRun({
        text: entry.name.toUpperCase(),
        bold: true,
        size: pt(fields.bulletFont),
        color: '0563C1',
        underline: {},
      })
    : new TextRun({ text: entry.name.toUpperCase(), bold: true, size: pt(fields.bulletFont) });
  const restRun = entry.subtitle
    ? new TextRun({ text: ` | ${entry.subtitle}`, bold: true, size: pt(fields.bulletFont) })
    : null;
  paragraphs.push(
    new Paragraph({
      spacing: { before, after: pointsToTwips(fields.spacingAfterEntryHeader) },
      tabStops: [{ type: TabStopType.RIGHT, position: contentWidthTwips }],
      children: [
        entry.url ? new ExternalHyperlink({ link: entry.url, children: [nameRun] }) : nameRun,
        ...(restRun ? [restRun] : []),
        ...(trailing ? [new TextRun({ text: `\t${trailing}`, size: pt(fields.bulletFont) })] : []),
      ],
    }),
  );

  for (const bullet of entry.bullets) {
    paragraphs.push(
      new Paragraph({
        indent: { left: tabStopTwips, hanging: tabStopTwips },
        spacing: { after: pointsToTwips(fields.spacingBetweenBullets) },
        bullet: { level: 0 },
        children: layoutBoldedRuns(bullet, fields.bulletFont),
      }),
    );
  }

  return paragraphs;
}

/** Mirrors layoutBoldedText: splits on **bold** markdown spans, alternating regular/bold runs. */
function layoutBoldedRuns(text: string, fontPt: number): TextRun[] {
  const segments = text.split(/\*\*([^*]+)\*\*/);
  return segments
    .map((segment, i) => {
      if (!segment) return null;
      const isBold = i % 2 === 1;
      return new TextRun({ text: segment, bold: isBold, size: pt(fontPt) });
    })
    .filter((r): r is TextRun => r !== null);
}
