import type {
  ArtifactFormat,
  ArtifactSpec,
  ArtifactTable
} from "@/types/chat-v3";
import { ARTIFACT_CONTENT_TYPES, type RenderedArtifactFile } from "./types";
import { parseArtifactSpec } from "./validation";
import { renderDocx } from "./docx";
import { renderPdf, type PdfRenderOptions } from "./pdf";

const encoder = new TextEncoder();
const FORMAT_ORDER: ArtifactFormat[] = ["md", "docx", "pdf", "csv"];

export type ArtifactRenderOptions = PdfRenderOptions;

export async function renderArtifactFiles(
  input: unknown,
  options: ArtifactRenderOptions = {}
): Promise<RenderedArtifactFile[]> {
  const spec = parseArtifactSpec(input);
  const stem = safeFilenameStem(spec.title);
  const files: RenderedArtifactFile[] = [];

  for (const format of FORMAT_ORDER) {
    if (!spec.formats.includes(format)) {
      continue;
    }
    const bytes = await renderFormat(spec, format, options);
    files.push({
      format,
      filename: `${stem}.${format}`,
      contentType: ARTIFACT_CONTENT_TYPES[format],
      bytes
    });
  }
  return files;
}

export function renderMarkdown(spec: ArtifactSpec): string {
  const lines = [`# ${escapeMarkdownInline(spec.title)}`, "", spec.summary, ""];
  for (const section of spec.sections) {
    lines.push(`## ${escapeMarkdownInline(section.heading)}`, "");
    for (const paragraph of section.paragraphs) {
      lines.push(paragraph, "");
    }
  }
  spec.tables.forEach((table, index) => {
    lines.push(
      `## ${escapeMarkdownInline(table.title ?? `表 ${index + 1}`)}`,
      ""
    );
    lines.push(markdownTable(table), "");
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCsv(spec: ArtifactSpec): string {
  const chunks = spec.tables.map((table, index) => {
    const rows: string[][] = [];
    if (spec.tables.length > 1) {
      rows.push([table.title ?? `表 ${index + 1}`]);
    }
    rows.push(table.columns, ...table.rows);
    return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  });
  return `\ufeff${chunks.join("\r\n\r\n")}\r\n`;
}

async function renderFormat(
  spec: ArtifactSpec,
  format: ArtifactFormat,
  options: ArtifactRenderOptions
): Promise<Uint8Array> {
  switch (format) {
    case "md":
      return encoder.encode(renderMarkdown(spec));
    case "csv":
      return encoder.encode(renderCsv(spec));
    case "docx":
      return renderDocx(spec, options);
    case "pdf":
      return renderPdf(spec, options);
  }
}

function markdownTable(table: ArtifactTable): string {
  const row = (cells: string[]) => `| ${cells.map(markdownCell).join(" | ")} |`;
  return [
    row(table.columns),
    row(table.columns.map(() => "---")),
    ...table.rows.map(row)
  ].join("\n");
}

function markdownCell(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r\n", "<br>")
    .replaceAll("\n", "<br>")
    .replaceAll("\r", "<br>");
}

function escapeMarkdownInline(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("#", "\\#");
}

function csvCell(value: string): string {
  const safeValue = /^[\t\r\n ]*[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

function safeFilenameStem(title: string): string {
  const value = title
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 100);
  return value || "openvac-artifact";
}
