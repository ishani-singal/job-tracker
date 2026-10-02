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
import {
  findFittingScale,
  resolvedFields,
  type ResolvedFields,
  type ResumeTemplate,
} from './structured-resume-pdf';

// Word measures font sizes in half-points.
const pt = (points: number) => Math.round(points * 2);

/**
 * Renders a StructuredResume as a .docx, using the exact same fitting scale
 * pdfkit would compute for the PDF (findFittingScale/resolvedFields) so the
 * two renderers stay visually consistent — pdfkit is kept around purely as a
 * layout-measurement tool (it can read back a measured height before
 * committing to a page; `docx` has no equivalent), never to emit bytes here.
 */
export async function renderStructuredResumeDocx(
  content: StructuredResume,
  template: ResumeTemplate,
  candidateName?: string | null,
): Promise<Buffer> {
  const scale = findFittingScale(content, template, candidateName);
  const fields = resolvedFields(template, scale);
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
        spacing: { before: pointsToTwips(fields.spacingBeforeSection) },
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 4, space: 2, color: '000000' },
        },
        children: [
          new TextRun({ text: section.heading.toUpperCase(), bold: true, size: pt(fields.sectionHeaderFont) }),
        ],
      }),
    );

    for (const entry of section.entries) {
      children.push(...layoutEntry(entry, fields, contentWidthTwips, tabStopTwips));
    }
  }

  return new Document({
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

/** Mirrors layoutContactLine: " | "-joined, centered, LinkedIn segments become hyperlinks. */
function layoutContactLine(contactLine: string, fontPt: number): Paragraph {
  const parts = contactLine.split('|').map((p) => p.trim());
  const runs: (TextRun | ExternalHyperlink)[] = [];

  parts.forEach((part, i) => {
    const isLinkedIn = /linkedin\.com/i.test(part);
    if (isLinkedIn) {
      const url = part.startsWith('http') ? part : `https://${part}`;
      runs.push(
        new ExternalHyperlink({
          link: url,
          children: [new TextRun({ text: part, size: pt(fontPt), color: '000000' })],
        }),
      );
    } else {
      runs.push(new TextRun({ text: part, size: pt(fontPt) }));
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
): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  const headerText = [entry.name.toUpperCase(), entry.subtitle].filter(Boolean).join(' | ');
  const trailing = entry.dateRange ?? '';
  paragraphs.push(
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: contentWidthTwips }],
      children: [
        new TextRun({ text: headerText, bold: true, size: pt(fields.bulletFont) }),
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
