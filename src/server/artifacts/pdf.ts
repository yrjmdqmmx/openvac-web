import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { readFile } from "node:fs/promises";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";

import type { ArtifactSpec, ArtifactTable } from "@/types/chat-v3";

const A4_PORTRAIT: [number, number] = [595.28, 841.89];
const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
const FIXED_PDF_DATE = new Date("2000-01-01T00:00:00.000Z");
const require = createRequire(import.meta.url);

export type PdfRenderOptions = {
  fontBytes?: Uint8Array;
};

export async function renderPdf(
  spec: ArtifactSpec,
  options: PdfRenderOptions = {}
): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  document.registerFontkit(fontkit);
  const font = await document.embedFont(
    options.fontBytes ?? (await loadBundledChineseFont()),
    // The packaged Chinese font is already language-subsetted. Re-subsetting
    // its CID-keyed CFF outlines through fontkit drops valid GB2312 glyphs.
    // Embed it whole so Chinese output is reliable and byte-deterministic.
    { subset: false, customName: "OpenVacNotoSansHans" }
  );

  document.setTitle(spec.title);
  document.setAuthor("OpenVac");
  document.setCreator("OpenVac Artifact Renderer");
  document.setProducer("OpenVac Artifact Renderer");
  document.setCreationDate(FIXED_PDF_DATE);
  document.setModificationDate(FIXED_PDF_DATE);

  const pageSize = spec.tables.some((table) => table.columns.length > 6)
    ? A4_LANDSCAPE
    : A4_PORTRAIT;
  const layout = new PdfLayout(document, font, pageSize);

  layout.writeText(spec.title, {
    size: 20,
    lineHeight: 28,
    color: rgb(0.08, 0.12, 0.18)
  });
  layout.addGap(4);
  layout.writeText(spec.summary, {
    size: 11,
    lineHeight: 17,
    color: rgb(0.25, 0.31, 0.39)
  });
  layout.addGap(12);

  for (const section of spec.sections) {
    layout.writeText(section.heading, {
      size: 15,
      lineHeight: 22,
      color: rgb(0.08, 0.22, 0.36)
    });
    layout.addGap(2);
    for (const paragraph of section.paragraphs) {
      layout.writeText(paragraph, { size: 10.5, lineHeight: 17 });
      layout.addGap(5);
    }
    layout.addGap(7);
  }

  for (const [index, table] of spec.tables.entries()) {
    layout.writeText(table.title ?? `表 ${index + 1}`, {
      size: 13,
      lineHeight: 20,
      color: rgb(0.08, 0.22, 0.36)
    });
    layout.addGap(4);
    layout.writeTable(table);
    layout.addGap(12);
  }

  layout.finish();
  return document.save({
    addDefaultPage: false,
    objectsPerTick: Number.POSITIVE_INFINITY,
    useObjectStreams: false,
    updateFieldAppearances: false
  });
}

export async function loadBundledChineseFont(): Promise<Uint8Array> {
  const packageEntry = require.resolve("@embedpdf/fonts-sc");
  const packageRoot = resolve(dirname(packageEntry), "..");
  return readFile(join(packageRoot, "fonts", "NotoSansHans-Regular.otf"));
}

type TextStyle = {
  size: number;
  lineHeight: number;
  color?: ReturnType<typeof rgb>;
};

class PdfLayout {
  private readonly margin = 44;
  private page: PDFPage;
  private y: number;
  private pageNumber = 1;

  constructor(
    private readonly document: PDFDocument,
    private readonly font: PDFFont,
    private readonly pageSize: [number, number]
  ) {
    this.page = this.addPage();
    this.y = pageSize[1] - this.margin;
  }

  addGap(points: number): void {
    this.y -= points;
  }

  writeText(text: string, style: TextStyle): void {
    const width = this.pageSize[0] - this.margin * 2;
    const lines = wrapText(text, this.font, style.size, width);
    for (const line of lines) {
      this.ensureSpace(style.lineHeight);
      this.page.drawText(line || " ", {
        x: this.margin,
        y: this.y - style.size,
        size: style.size,
        font: this.font,
        color: style.color ?? rgb(0.12, 0.15, 0.19)
      });
      this.y -= style.lineHeight;
    }
  }

  writeTable(table: ArtifactTable): void {
    const tableWidth = this.pageSize[0] - this.margin * 2;
    const columnWidth = tableWidth / table.columns.length;
    this.drawTableRow(table.columns, columnWidth, true);
    for (const row of table.rows) {
      this.drawTableRow(row, columnWidth, false);
    }
  }

  finish(): void {
    this.drawFooter(this.page, this.pageNumber);
  }

  private drawTableRow(
    cells: string[],
    columnWidth: number,
    header: boolean
  ): void {
    const size = header ? 8.5 : 8;
    const lineHeight = 11;
    const padding = 4;
    const wrapped = cells.map((cell) =>
      wrapText(cell, this.font, size, Math.max(columnWidth - padding * 2, 8))
    );
    const rowHeight = Math.max(
      20,
      Math.max(...wrapped.map((lines) => lines.length)) * lineHeight +
        padding * 2
    );
    this.ensureSpace(rowHeight + 2);
    const top = this.y;

    if (header) {
      this.page.drawRectangle({
        x: this.margin,
        y: top - rowHeight,
        width: columnWidth * cells.length,
        height: rowHeight,
        color: rgb(0.91, 0.94, 0.97)
      });
    }

    for (const [columnIndex, lines] of wrapped.entries()) {
      const x = this.margin + columnWidth * columnIndex;
      this.page.drawRectangle({
        x,
        y: top - rowHeight,
        width: columnWidth,
        height: rowHeight,
        borderColor: rgb(0.68, 0.72, 0.77),
        borderWidth: 0.5
      });
      lines.forEach((line, lineIndex) => {
        this.page.drawText(line || " ", {
          x: x + padding,
          y: top - padding - size - lineIndex * lineHeight,
          size,
          font: this.font,
          color: rgb(0.12, 0.15, 0.19)
        });
      });
    }
    this.y -= rowHeight;
  }

  private ensureSpace(points: number): void {
    if (this.y - points >= this.margin + 18) {
      return;
    }
    this.drawFooter(this.page, this.pageNumber);
    this.pageNumber += 1;
    this.page = this.addPage();
    this.y = this.pageSize[1] - this.margin;
  }

  private addPage(): PDFPage {
    return this.document.addPage(this.pageSize);
  }

  private drawFooter(page: PDFPage, pageNumber: number): void {
    const label = `OpenVac - ${pageNumber}`;
    page.drawText(label, {
      x: this.pageSize[0] - this.margin - this.font.widthOfTextAtSize(label, 8),
      y: 22,
      size: 8,
      font: this.font,
      color: rgb(0.45, 0.49, 0.54)
    });
  }
}

function wrapText(
  value: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): string[] {
  const output: string[] = [];
  for (const sourceLine of value.replaceAll("\t", "  ").split("\n")) {
    if (sourceLine.length === 0) {
      output.push("");
      continue;
    }
    let current = "";
    for (const character of sourceLine) {
      const candidate = current + character;
      if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        output.push(current);
        current = character;
      } else {
        current = candidate;
      }
    }
    output.push(current);
  }
  return output;
}
