import PDFDocument from 'pdfkit';

/**
 * Renders generated resume text into a simple single-column PDF. The text is
 * free-form model output, not structured fields, so this does lightweight
 * markdown-style parsing rather than a true multi-section resume template:
 * "# "/"## " lines become headers, "- "/"* " lines become indented bullets,
 * "**bold**" spans render bold, everything else is a normal paragraph line.
 */
export function renderResumePdf(title: string, text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 54, size: 'LETTER' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font('Helvetica-Bold').fontSize(16).text(title);
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
        doc.font('Helvetica-Bold').fontSize(12).text(line.slice(3));
        doc.moveDown(0.1);
        continue;
      }
      if (line.startsWith('# ')) {
        doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(14).text(line.slice(2));
        doc.moveDown(0.1);
        continue;
      }

      const bulletMatch = line.match(/^[-*]\s+(.*)$/);
      const content = bulletMatch ? bulletMatch[1] : line;
      const indent = bulletMatch ? 14 : 0;
      const prefix = bulletMatch ? '• ' : '';

      renderInlineBold(doc, prefix + content, indent);
    }

    doc.end();
  });
}

/** Renders a line with **bold** spans, splitting into bold/regular runs via continued text. */
function renderInlineBold(doc: PDFKit.PDFDocument, line: string, indent: number): void {
  const parts = line.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  doc.fontSize(10);

  const startX = doc.page.margins.left + indent;
  doc.text('', startX, doc.y);

  parts.forEach((part, i) => {
    const isBold = part.startsWith('**') && part.endsWith('**');
    const content = isBold ? part.slice(2, -2) : part;
    doc.font(isBold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(content, { continued: i < parts.length - 1 });
  });
}
