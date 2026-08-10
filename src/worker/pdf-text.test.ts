import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { renderArtifactFiles } from "@/server/artifacts";
import type { ArtifactSpec } from "@/types/chat-v3";

import { extractLocalPdfText } from "./pdf-text";

describe("local PDF text extraction", () => {
  it("extracts the deployed Chinese artifact text layer with page locators", async () => {
    const files = await renderArtifactFiles(artifactSpec());
    const pdf = files.find((file) => file.format === "pdf");

    const parsed = await extractLocalPdfText(pdf!.bytes);

    expect(parsed).not.toBeNull();
    expect(parsed?.jobId).toBe("local-pdf-text");
    expect(parsed?.pages[0]).toMatchObject({ pageNumber: 1 });
    expect(parsed?.pages.map((page) => page.markdown).join(" ")).toContain(
      "维护间隔"
    );
  });

  it("returns null for a PDF without a meaningful text layer", async () => {
    const document = await PDFDocument.create();
    document.addPage();

    expect(await extractLocalPdfText(await document.save())).toBeNull();
  });

  it("returns null before parsing documents beyond the page budget", async () => {
    const document = await PDFDocument.create();
    document.addPage();
    document.addPage();

    expect(
      await extractLocalPdfText(await document.save(), { maxPages: 1 })
    ).toBeNull();
  });
});

function artifactSpec(): ArtifactSpec {
  return {
    schemaVersion: "openvac.artifact.v1",
    kind: "inspection_checklist",
    title: "私有真空泵维护摘录",
    formats: ["pdf"],
    summary: "仅用于本地 PDF 文本层测试。",
    sections: [
      {
        heading: "维护工况",
        paragraphs: ["维护间隔取决于气体负载、污染程度、温度与运行占空比。"]
      }
    ],
    tables: [],
    sourceTurnId: "00000000-0000-4000-8000-000000000000"
  };
}
