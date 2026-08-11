import { join } from "node:path";
import { readFile } from "node:fs/promises";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";

import type { ArtifactSpec, ArtifactTable } from "@/types/chat-v3";

const A4_PORTRAIT: [number, number] = [595.28, 841.89];
const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
const FIXED_PDF_DATE = new Date("2000-01-01T00:00:00.000Z");

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
  return readFile(bundledChineseFontPath());
}

export function bundledChineseFontPath(root = process.cwd()): string {
  return join(
    root,
    "node_modules",
    "@embedpdf",
    "fonts-sc",
    "fonts",
    "NotoSansHans-Regular.otf"
  );
}

type TextStyle = {
  size: number;
  lineHeight: number;
  color?: ReturnType<typeof rgb>;
};

type TableRowLayout = {
  wrapped: string[][];
  size: number;
  lineHeight: number;
  padding: number;
  header: boolean;
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
    const header = this.layoutTableRow(table.columns, columnWidth, true);
    const repeatedHeader = this.drawTableHeader(header, columnWidth);
    for (const row of table.rows) {
      this.drawSegmentedTableRow(
        this.layoutTableRow(row, columnWidth, false),
        columnWidth,
        repeatedHeader
      );
    }
  }

  finish(): void {
    this.drawFooter(this.page, this.pageNumber);
  }

  private layoutTableRow(
    cells: string[],
    columnWidth: number,
    header: boolean
  ): TableRowLayout {
    const size = header ? 8.5 : 8;
    const lineHeight = 11;
    const padding = 4;
    const wrapped = cells.map((cell) =>
      wrapText(cell, this.font, size, Math.max(columnWidth - padding * 2, 8))
    );
    return { wrapped, size, lineHeight, padding, header };
  }

  private drawTableHeader(
    layout: TableRowLayout,
    columnWidth: number
  ): TableRowLayout | undefined {
    const lineCount = tableRowLineCount(layout);
    const rowHeight = tableRowHeight(layout, lineCount);
    const fullPageHeight =
      this.pageSize[1] - this.margin - this.tableBottom - 20;
    if (rowHeight <= fullPageHeight) {
      // Reserve one body line so a short header is not orphaned at the bottom.
      this.ensureSpace(rowHeight + 20);
      this.drawTableRowSegment(layout, columnWidth, 0, lineCount);
      return layout;
    }

    // Extremely long column labels are legal too. Render the header once in
    // bounded page-sized pieces; repeating it would consume every continuation
    // page before a body row could be written.
    this.drawSegmentedTableRow(layout, columnWidth);
    return undefined;
  }

  private drawSegmentedTableRow(
    layout: TableRowLayout,
    columnWidth: number,
    repeatedHeader?: TableRowLayout
  ): void {
    const totalLines = tableRowLineCount(layout);
    let lineOffset = 0;

    while (lineOffset < totalLines) {
      if (this.availableTableHeight < 20) {
        this.startTableContinuation(repeatedHeader, columnWidth);
      }
      const availableLines = Math.max(
        1,
        Math.floor(
          (this.availableTableHeight - layout.padding * 2) / layout.lineHeight
        )
      );
      const segmentLines = Math.min(totalLines - lineOffset, availableLines);
      this.drawTableRowSegment(layout, columnWidth, lineOffset, segmentLines);
      lineOffset += segmentLines;

      if (lineOffset < totalLines) {
        this.startTableContinuation(repeatedHeader, columnWidth);
      }
    }
  }

  private drawTableRowSegment(
    layout: TableRowLayout,
    columnWidth: number,
    lineOffset: number,
    lineCount: number
  ): void {
    const rowHeight = tableRowHeight(layout, lineCount);
    const top = this.y;

    if (layout.header) {
      this.page.drawRectangle({
        x: this.margin,
        y: top - rowHeight,
        width: columnWidth * layout.wrapped.length,
        height: rowHeight,
        color: rgb(0.91, 0.94, 0.97)
      });
    }

    for (const [columnIndex, lines] of layout.wrapped.entries()) {
      const x = this.margin + columnWidth * columnIndex;
      this.page.drawRectangle({
        x,
        y: top - rowHeight,
        width: columnWidth,
        height: rowHeight,
        borderColor: rgb(0.68, 0.72, 0.77),
        borderWidth: 0.5
      });
      lines
        .slice(lineOffset, lineOffset + lineCount)
        .forEach((line, lineIndex) => {
          this.page.drawText(line || " ", {
            x: x + layout.padding,
            y:
              top -
              layout.padding -
              layout.size -
              lineIndex * layout.lineHeight,
            size: layout.size,
            font: this.font,
            color: rgb(0.12, 0.15, 0.19)
          });
        });
    }
    this.y -= rowHeight;
  }

  private startTableContinuation(
    repeatedHeader: TableRowLayout | undefined,
    columnWidth: number
  ): void {
    this.startNewPage();
    if (repeatedHeader) {
      this.drawTableRowSegment(
        repeatedHeader,
        columnWidth,
        0,
        tableRowLineCount(repeatedHeader)
      );
    }
  }

  private get tableBottom(): number {
    return this.margin + 18;
  }

  private get availableTableHeight(): number {
    return this.y - this.tableBottom;
  }

  private ensureSpace(points: number): void {
    if (this.y - points >= this.margin + 18) {
      return;
    }
    this.startNewPage();
  }

  private startNewPage(): void {
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

function tableRowLineCount(layout: TableRowLayout): number {
  return Math.max(...layout.wrapped.map((lines) => lines.length));
}

function tableRowHeight(layout: TableRowLayout, lineCount: number): number {
  return Math.max(20, lineCount * layout.lineHeight + layout.padding * 2);
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
