import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { PDFDocument } from "pdf-lib";

import { renderArtifactFiles } from "../src/server/artifacts";
import type { ArtifactSpec } from "../src/types/chat-v3";

const gitSha = requiredGitSha(process.env.ANSWER_V3_ARTIFACT_GIT_SHA);
const outputPath = path.resolve(
  process.cwd(),
  process.env.ANSWER_V3_ARTIFACT_OUTPUT?.trim() ||
    `.artifacts/evals/agent-v3-artifacts-${gitSha.slice(0, 12)}.json`
);
const spec: ArtifactSpec = {
  schemaVersion: "openvac.artifact.v1",
  kind: "diagnosis_report",
  title: "真空系统发布验收报告",
  formats: ["md", "docx", "pdf", "csv"],
  summary: "验证中文、表格、确定性校验和与 CSV 公式防护。",
  sections: [
    {
      heading: "验收结论",
      paragraphs: ["发布产物必须可重复生成且不得泄露内部对象地址。"]
    }
  ],
  tables: [
    {
      title: "验收参数",
      columns: ["参数", "值", "结论"],
      rows: [
        ["入口压力", "10 Pa", "通过"],
        ["公式防护", "=1+1", "不得执行"]
      ]
    }
  ],
  sourceTurnId: "00000000-0000-4000-8000-000000000001"
};

const first = await renderArtifactFiles(spec);
const second = await renderArtifactFiles(spec);
const expectedFormats = ["md", "docx", "pdf", "csv"] as const;
if (
  first.length !== expectedFormats.length ||
  first.some((file, index) => file.format !== expectedFormats[index]) ||
  second.length !== first.length
) {
  throw new Error("Artifact renderer did not return every required format.");
}

const checksums: Record<string, string> = {};
for (const [index, file] of first.entries()) {
  const repeated = second[index];
  if (
    !repeated ||
    !Buffer.from(file.bytes).equals(Buffer.from(repeated.bytes))
  ) {
    throw new Error(
      `Artifact renderer is not deterministic for ${file.format}.`
    );
  }
  if (file.bytes.byteLength <= 32) {
    throw new Error(`Artifact ${file.format} is unexpectedly empty.`);
  }
  checksums[file.format] = sha256(file.bytes);
}

const markdown = decode(requiredFile(first, "md").bytes);
if (
  !markdown.includes("真空系统发布验收报告") ||
  !markdown.includes("| 参数 |")
) {
  throw new Error("Markdown artifact lost Chinese text or table structure.");
}
const docx = requiredFile(first, "docx").bytes;
if (!Buffer.from(docx.subarray(0, 4)).equals(Buffer.from([80, 75, 3, 4]))) {
  throw new Error("DOCX artifact is not a valid ZIP container.");
}
if (!decode(docx).includes("真空系统发布验收报告")) {
  throw new Error("DOCX artifact lost Chinese text.");
}
const pdf = requiredFile(first, "pdf").bytes;
if (!decode(pdf.subarray(0, 8)).includes("%PDF-")) {
  throw new Error("PDF artifact header is invalid.");
}
if ((await PDFDocument.load(pdf)).getPageCount() < 1) {
  throw new Error("PDF artifact contains no pages.");
}
const csv = requiredFile(first, "csv").bytes;
if (
  !Buffer.from(csv.subarray(0, 3)).equals(Buffer.from([0xef, 0xbb, 0xbf])) ||
  !decode(csv).includes('"\'=1+1"')
) {
  throw new Error("CSV artifact lost UTF-8 BOM or formula hardening.");
}

const report = {
  schemaVersion: "openvac.agent-v3-artifact-check.v1",
  gitSha,
  generatedAt: new Date().toISOString(),
  formats: [...expectedFormats],
  checksums,
  deterministic: true,
  chineseText: true,
  tableStructure: true,
  csvFormulaHardened: true,
  pdfPageCount: (await PDFDocument.load(pdf)).getPageCount(),
  passed: true
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ passed: true, reportPath: outputPath }));

function requiredGitSha(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/u.test(normalized)) {
    throw new Error(
      "ANSWER_V3_ARTIFACT_GIT_SHA must be a 40-character Git SHA."
    );
  }
  return normalized;
}

function requiredFile(
  files: Awaited<ReturnType<typeof renderArtifactFiles>>,
  format: (typeof expectedFormats)[number]
) {
  const file = files.find((candidate) => candidate.format === format);
  if (!file) throw new Error(`Artifact renderer omitted ${format}.`);
  return file;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
