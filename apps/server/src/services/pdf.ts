import PDFDocument from 'pdfkit';
import type { StructuredReport } from './research';

const BRAND_COLOR = '#6D28D9';
const BRAND_TEXT = 'Research Report';
const PAGE_MARGIN = 60;

export interface GenerateResearchPdfOptions {
  title: string;
  report: StructuredReport;
  generatedAt?: Date;
}

export function generateResearchPdf(
  options: GenerateResearchPdfOptions,
): Promise<Buffer> {
  const { title, report, generatedAt = new Date() } = options;

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: {
          top: PAGE_MARGIN,
          bottom: PAGE_MARGIN,
          left: PAGE_MARGIN,
          right: PAGE_MARGIN,
        },
        info: { Title: title, Author: BRAND_TEXT },
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      writeHeader(doc, title, generatedAt);
      writeSection(doc, 'Executive Summary', () =>
        writeParagraph(doc, report.executiveSummary),
      );
      writeSection(doc, 'Key Findings', () => writeBullets(doc, report.keyFindings));
      writeSection(doc, 'Detailed Analysis', () =>
        writeParagraph(doc, report.detailedAnalysis),
      );
      writeSection(doc, 'Sources', () => writeSources(doc, report.sources));
      writeSection(doc, 'Methodology', () =>
        writeMethodology(doc, report.methodology),
      );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

type PdfDoc = InstanceType<typeof PDFDocument>;

function writeHeader(doc: PdfDoc, title: string, generatedAt: Date): void {
  doc
    .rect(0, 0, doc.page.width, 36)
    .fill(BRAND_COLOR);
  doc
    .fillColor('white')
    .font('Helvetica-Bold')
    .fontSize(11)
    .text(BRAND_TEXT, PAGE_MARGIN, 12, { align: 'left' });
  doc.fillColor('black').moveDown(2);
  doc.font('Helvetica-Bold').fontSize(20).text(title, { align: 'left' });
  doc
    .moveDown(0.4)
    .font('Helvetica')
    .fontSize(9)
    .fillColor('#666666')
    .text(`Generated ${generatedAt.toISOString()}`);
  doc.moveDown(1).fillColor('black');
}

function writeSection(doc: PdfDoc, heading: string, body: () => void): void {
  ensureSpace(doc, 80);
  doc
    .moveDown(0.5)
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor(BRAND_COLOR)
    .text(heading);
  doc
    .moveDown(0.2)
    .strokeColor(BRAND_COLOR)
    .lineWidth(0.5)
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
    .stroke();
  doc.moveDown(0.4).fillColor('black').font('Helvetica').fontSize(11);
  body();
}

const BASE64_IMAGE_RE = /!\[[^\]]*\]\(data:image\/png;base64,([A-Za-z0-9+/=\s]+?)\)/g;

export function splitParagraphByImages(
  para: string,
): Array<{ kind: 'text'; value: string } | { kind: 'image'; base64: string }> {
  const out: Array<{ kind: 'text'; value: string } | { kind: 'image'; base64: string }> = [];
  let last = 0;
  BASE64_IMAGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BASE64_IMAGE_RE.exec(para)) !== null) {
    if (m.index > last) {
      out.push({ kind: 'text', value: para.slice(last, m.index) });
    }
    out.push({ kind: 'image', base64: m[1].replace(/\s+/g, '') });
    last = m.index + m[0].length;
  }
  if (last < para.length) out.push({ kind: 'text', value: para.slice(last) });
  return out;
}

function writeParagraph(doc: PdfDoc, text: string): void {
  if (!text || text.trim().length === 0) {
    doc.font('Helvetica-Oblique').fillColor('#777777').text('(no content)');
    doc.font('Helvetica').fillColor('black');
    return;
  }
  const usableWidth = doc.page.width - PAGE_MARGIN * 2;
  for (const para of text.split(/\n\s*\n/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    const segments = splitParagraphByImages(trimmed);
    for (const seg of segments) {
      if (seg.kind === 'text') {
        const cleaned = seg.value.trim().replace(/\n+/g, ' ');
        if (!cleaned) continue;
        doc.text(cleaned, { align: 'left' });
      } else {
        try {
          const buf = Buffer.from(seg.base64, 'base64');
          ensureSpace(doc, 220);
          doc.moveDown(0.3);
          doc.image(buf, { fit: [usableWidth, 320], align: 'center' });
          doc.moveDown(0.3);
        } catch (err) {
          doc
            .font('Helvetica-Oblique')
            .fillColor('#777777')
            .text(`(chart could not be rendered: ${(err as Error).message})`);
          doc.font('Helvetica').fillColor('black');
        }
      }
    }
    doc.moveDown(0.5);
  }
}

function writeBullets(doc: PdfDoc, items: string[]): void {
  if (items.length === 0) {
    doc.font('Helvetica-Oblique').fillColor('#777777').text('(no findings)');
    doc.font('Helvetica').fillColor('black');
    return;
  }
  for (const item of items) {
    doc.text(`• ${item}`, { indent: 6 });
    doc.moveDown(0.2);
  }
}

function writeSources(
  doc: PdfDoc,
  sources: StructuredReport['sources'],
): void {
  if (sources.length === 0) {
    doc.font('Helvetica-Oblique').fillColor('#777777').text('(no sources)');
    doc.font('Helvetica').fillColor('black');
    return;
  }
  for (const s of sources) {
    const tag = s.reliability === 'verified' ? '[verified] ' : '';
    doc
      .font('Helvetica-Bold')
      .text(`[${s.index}] ${s.title}`, { continued: false });
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor('#444444')
      .text(`${tag}${s.url}`, {
        link: s.url,
        underline: true,
      });
    doc.fillColor('black').fontSize(11).moveDown(0.3);
  }
}

function writeMethodology(
  doc: PdfDoc,
  methodology: StructuredReport['methodology'],
): void {
  doc.font('Helvetica-Bold').text('Search queries used:');
  doc.font('Helvetica');
  if (methodology.queries.length === 0) {
    doc.text('  (none)');
  } else {
    for (const q of methodology.queries) doc.text(`  • ${q}`);
  }
  doc.moveDown(0.4);
  doc
    .font('Helvetica-Bold')
    .text(`Iterations: `, { continued: true })
    .font('Helvetica')
    .text(String(methodology.iterationCount));
  if (methodology.finalScores) {
    doc.moveDown(0.2).font('Helvetica-Bold').text('Final scores (1-5):');
    doc.font('Helvetica');
    for (const [k, v] of Object.entries(methodology.finalScores)) {
      doc.text(`  ${k.replace(/_/g, ' ')}: ${v}`);
    }
  } else {
    doc.moveDown(0.2).font('Helvetica-Oblique').fillColor('#777777').text(
      'Final scores: not available (critique parse failed)',
    );
    doc.font('Helvetica').fillColor('black');
  }
  const fc = methodology.factCheckSummary;
  doc.moveDown(0.4).font('Helvetica-Bold').text('Fact-check summary:');
  doc.font('Helvetica');
  doc.text(`  Total claims extracted: ${fc.totalClaimsExtracted}`);
  doc.text(`  Verified: ${fc.verifiedClaims}`);
  doc.text(`  Unverified: ${fc.unverifiedClaims}`);
  doc.text(`  Not checked: ${fc.notCheckedClaims}`);
}

function ensureSpace(doc: PdfDoc, minRemaining: number): void {
  const remaining = doc.page.height - doc.y - PAGE_MARGIN;
  if (remaining < minRemaining) {
    doc.addPage();
  }
}
