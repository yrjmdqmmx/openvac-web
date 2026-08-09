import { describe, expect, it, vi } from "vitest";

import type { ArtifactStorage } from "./artifact-tools";
import { EvidenceRegistry } from "./evidence-registry";
import { ToolRegistry } from "./tool-registry";

const userId = "user-a";
const conversationId = "conversation-a";
const turnId = "ea538766-c8a3-4350-8894-8fb72233af12";
const attachmentId = "10000000-0000-4000-8000-000000000001";
const artifactId = "31d56d64-399a-4813-bad1-0c93e1eb8396";

describe("ToolRegistry V3 exposure", () => {
  it("exposes the URL and attachment tools only when the current turn supplies refs", () => {
    const bare = new ToolRegistry(new EvidenceRegistry());
    expect(v3ToolNames(bare)).toEqual([]);

    const scoped = registry("请分析链接和附件");
    expect(v3ToolNames(scoped)).toEqual([
      "read_verified_url",
      "search_attachment",
      "open_attachment_excerpt",
      "analyze_image"
    ]);
    for (const definition of scoped.definitions) {
      expect(definition.strict).toBe(true);
      expect(definition.parameters).toMatchObject({
        type: "object",
        additionalProperties: false
      });
    }
  });

  it.each([
    "请分析资料后直接回答",
    "不要创建文档",
    "如何生成诊断报告？",
    "系统没有生成报告"
  ])(
    "does not expose create_artifact without explicit intent: %s",
    (question) => {
      expect(v3ToolNames(registry(question))).not.toContain("create_artifact");
    }
  );

  it("exposes and executes create_artifact only for an explicit request", async () => {
    const storage: ArtifactStorage & { create: ReturnType<typeof vi.fn> } = {
      create: vi.fn(async (input) => ({
        artifactId,
        userId: input.userId,
        conversationId: input.conversationId,
        sourceTurnId: input.turnId,
        kind: input.spec.kind,
        title: input.spec.title,
        formats: input.spec.formats,
        status: "generating" as const,
        signedUrl: "https://private.example/signed?Signature=secret"
      }))
    };
    const scoped = registry("请生成一份诊断报告并导出 PDF", storage);
    expect(v3ToolNames(scoped)).toContain("create_artifact");

    const result = await scoped.execute({
      callId: "call-artifact",
      name: "create_artifact",
      arguments: JSON.stringify({
        schemaVersion: "openvac.artifact.v1",
        kind: "diagnosis_report",
        title: "真空系统诊断",
        formats: ["pdf"],
        summary: "诊断摘要",
        sections: [{ heading: "现象", paragraphs: ["抽速不足"] }],
        tables: []
      })
    });

    expect(result.ok).toBe(true);
    expect(result.artifacts).toEqual([
      {
        type: "artifact",
        artifactId,
        kind: "diagnosis_report",
        title: "真空系统诊断",
        formats: ["pdf"],
        status: "generating"
      }
    ]);
    expect(JSON.stringify(result)).not.toMatch(/signed|signature|secret/iu);
  });
});

function registry(question: string, artifactStorage?: ArtifactStorage) {
  return new ToolRegistry(new EvidenceRegistry(), {
    userId,
    conversationId,
    turnId,
    question,
    inputParts: [
      { type: "text", text: question },
      { type: "link", url: "https://example.com/manual", label: "说明书" },
      { type: "attachment", attachmentId }
    ],
    artifactStorage
  });
}

function v3ToolNames(registry: ToolRegistry): string[] {
  const names = new Set([
    "read_verified_url",
    "search_attachment",
    "open_attachment_excerpt",
    "analyze_image",
    "create_artifact"
  ]);
  return registry.definitions
    .map((definition) => definition.name)
    .filter((name) => names.has(name));
}
