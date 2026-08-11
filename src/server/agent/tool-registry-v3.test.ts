import { describe, expect, it, vi } from "vitest";

const toolRegistryMocks = vi.hoisted(() => ({
  collectLocalEvidence: vi.fn()
}));

vi.mock("@/server/chat/evidence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/chat/evidence")>()),
  collectLocalEvidence: toolRegistryMocks.collectLocalEvidence
}));

import type { ArtifactStorage } from "./artifact-tools";
import type { AttachmentStorage } from "./attachment-tools";
import { EvidenceRegistry } from "./evidence-registry";
import { ToolRegistry } from "./tool-registry";
import type { VerifiedUrlReader } from "./verified-url";

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

  it("binds a verified current-turn URL to its private evidence", async () => {
    const verifiedUrlReader = {
      read: vi.fn(async () => ({
        link: {
          type: "verified_link" as const,
          linkId: "L1",
          url: "https://example.com/manual",
          label: "说明书",
          hostname: "example.com",
          status: "verified" as const
        },
        contentType: "text/plain",
        text: "Verified vacuum manual excerpt"
      }))
    } as unknown as VerifiedUrlReader;
    const scoped = registry(
      "请读取链接并给出依据",
      undefined,
      undefined,
      undefined,
      verifiedUrlReader
    );

    const result = await scoped.execute({
      callId: "call-link",
      name: "read_verified_url",
      arguments: JSON.stringify({ linkId: "L1" })
    });

    expect(result.ok).toBe(true);
    expect(result.evidenceIds).toEqual(["E1"]);
    expect(result.verifiedLinks).toEqual([
      expect.objectContaining({ linkId: "L1", evidenceIds: ["E1"] })
    ]);
    expect(result.outputItem.type).toBe("function_call_output");
    if (result.outputItem.type !== "function_call_output") {
      throw new Error("Expected function_call_output.");
    }
    expect(JSON.parse(String(result.outputItem.output))).toMatchObject({
      evidence: [expect.objectContaining({ evidenceId: "E1", linkId: "L1" })]
    });
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
        status: "ready" as const,
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
        status: "ready"
      }
    ]);
    expect(JSON.stringify(result)).not.toMatch(/signed|signature|secret/iu);
  });

  it("publishes artifact constraints that match canonical row and text bounds", () => {
    const scoped = registry("请生成中文诊断报告并导出 CSV");
    const definition = scoped.definitions.find(
      (tool) => tool.type === "function" && tool.name === "create_artifact"
    );
    expect(definition).toBeDefined();
    expect(definition?.description).toContain("选择 CSV 时必须提供");
    expect(definition?.parameters).toMatchObject({
      properties: {
        sections: {
          items: {
            properties: {
              paragraphs: {
                minItems: 1,
                items: { minLength: 1, maxLength: 10_000 }
              }
            }
          }
        },
        tables: {
          items: {
            properties: {
              columns: {
                minItems: 1,
                uniqueItems: true,
                items: { minLength: 1, maxLength: 240 }
              },
              rows: {
                minItems: 1,
                items: { minItems: 1, items: { maxLength: 10_000 } }
              }
            }
          }
        }
      }
    });
  });

  it("preflights invalid artifact arguments before storage execution", async () => {
    const storage: ArtifactStorage = {
      create: vi.fn(async () => {
        throw new Error("storage must not run for invalid arguments");
      })
    };
    const scoped = registry("请生成中文诊断报告并导出 CSV", storage);
    const call = {
      callId: "call-invalid-artifact",
      name: "create_artifact",
      arguments: JSON.stringify({
        schemaVersion: "openvac.artifact.v1",
        kind: "diagnosis_report",
        title: "诊断报告",
        formats: ["csv"],
        summary: "诊断摘要",
        sections: [{ heading: "结论", paragraphs: ["检查完成"] }],
        tables: []
      })
    };

    const preflight = scoped.preflight(call);
    expect(preflight.ok).toBe(false);
    if (preflight.ok) throw new Error("Expected artifact preflight failure.");
    expect(preflight.result).toMatchObject({
      ok: false,
      errorCode: "INVALID_TOOL_ARGUMENTS"
    });

    await expect(scoped.execute(call)).resolves.toMatchObject({
      ok: false,
      errorCode: "INVALID_TOOL_ARGUMENTS"
    });
    expect(storage.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "empty content",
      value: { sections: [], tables: [] }
    },
    {
      name: "trim-empty paragraph",
      value: {
        sections: [{ heading: "结论", paragraphs: ["   "] }],
        tables: []
      }
    },
    {
      name: "case-fold duplicate columns",
      value: {
        formats: ["csv"],
        sections: [],
        tables: [{ columns: ["PARAM", "param"], rows: [["a", "b"]] }]
      }
    },
    {
      name: "parameter table without a table",
      value: {
        kind: "parameter_table",
        sections: [{ heading: "假设", paragraphs: ["仅有说明"] }],
        tables: []
      }
    },
    {
      name: "row width mismatch",
      value: {
        formats: ["csv"],
        sections: [],
        tables: [{ columns: ["参数", "单位"], rows: [["压力"]] }]
      }
    }
  ])(
    "rejects canonical artifact drift before execution: $name",
    ({ value }) => {
      const scoped = registry("请生成中文诊断报告并导出 CSV");
      const argumentsValue = Object.assign(
        {
          schemaVersion: "openvac.artifact.v1",
          kind: "diagnosis_report",
          title: "private-title-must-not-leak",
          formats: ["pdf"],
          summary: "private-summary-must-not-leak",
          sections: [{ heading: "结论", paragraphs: ["检查完成"] }],
          tables: []
        },
        value
      );
      const preflight = scoped.preflight({
        callId: "call-canonical-drift",
        name: "create_artifact",
        arguments: JSON.stringify(argumentsValue)
      });

      expect(preflight.ok).toBe(false);
      if (preflight.ok) throw new Error("Expected artifact preflight failure.");
      const output = JSON.stringify(preflight.result.outputItem);
      expect(preflight.result.errorCode).toBe("INVALID_TOOL_ARGUMENTS");
      expect(output).not.toContain("private-title-must-not-leak");
      expect(output).not.toContain("private-summary-must-not-leak");
    }
  );

  it("accepts a bounded parameter table above the generic tool argument limit", async () => {
    const storage: ArtifactStorage & { create: ReturnType<typeof vi.fn> } = {
      create: vi.fn(async (input) => ({
        artifactId,
        userId: input.userId,
        conversationId: input.conversationId,
        sourceTurnId: input.turnId,
        kind: input.spec.kind,
        title: input.spec.title,
        formats: input.spec.formats,
        status: "ready" as const
      }))
    };
    const scoped = registry("请生成泵组选型参数表并导出 CSV", storage);
    const argumentsJson = JSON.stringify({
      schemaVersion: "openvac.artifact.v1",
      kind: "parameter_table",
      title: "泵组选型参数表",
      formats: ["csv"],
      summary: "参数和假设",
      sections: [],
      tables: [
        {
          columns: ["参数", "说明"],
          rows: Array.from({ length: 200 }, (_, index) => [
            `参数 ${index + 1}`,
            "泵".repeat(250)
          ])
        }
      ]
    });
    expect(Buffer.byteLength(argumentsJson, "utf8")).toBeGreaterThan(32 * 1024);
    const escapedArgumentsJson = argumentsJson.replaceAll("泵", "\\u6cf5");
    expect(Buffer.byteLength(escapedArgumentsJson, "utf8")).toBeGreaterThan(
      256 * 1024
    );
    expect(
      Buffer.byteLength(
        JSON.stringify(JSON.parse(escapedArgumentsJson)),
        "utf8"
      )
    ).toBeLessThan(256 * 1024);

    const result = await scoped.execute({
      callId: "call-large-parameter-table",
      name: "create_artifact",
      arguments: escapedArgumentsJson
    });

    expect(result.ok).toBe(true);
    expect(storage.create).toHaveBeenCalledTimes(1);
  });

  it("returns artifact-specific codes for malformed or oversized arguments", async () => {
    const scoped = registry("请生成泵组选型参数表并导出 CSV");
    await expect(
      scoped.execute({
        callId: "call-malformed-artifact",
        name: "create_artifact",
        arguments: "{"
      })
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "ARTIFACT_ARGUMENTS_JSON_INVALID"
    });
    await expect(
      scoped.execute({
        callId: "call-oversized-artifact",
        name: "create_artifact",
        arguments: "x".repeat(2 * 1024 * 1024 + 1)
      })
    ).resolves.toMatchObject({
      ok: false,
      errorCode: "ARTIFACT_ARGUMENTS_TOO_LARGE"
    });
  });

  it("classifies an aborted artifact execution as a bounded timeout", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("run timeout", "TimeoutError"));
    const storage: ArtifactStorage = {
      create: vi.fn(async (input) => {
        input.signal?.throwIfAborted();
        throw new Error("unreachable");
      })
    };
    const scoped = registry(
      "请生成一份诊断报告并导出 PDF",
      storage,
      controller.signal
    );

    const result = await scoped.execute({
      callId: "call-artifact-timeout",
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

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("TOOL_TIMEOUT");
  });

  it("passes the tool signal into knowledge retrieval", async () => {
    toolRegistryMocks.collectLocalEvidence.mockResolvedValueOnce({
      evidence: [],
      patentReferences: 0,
      local: { mode: "lexical", bestScore: 0 }
    });
    const controller = new AbortController();
    const scoped = registry("请搜索真空泵知识", undefined, controller.signal);

    await scoped.execute({
      callId: "call-search",
      name: "search_knowledge",
      arguments: JSON.stringify({ query: "真空泵选型" })
    });

    const forwardedSignal = toolRegistryMocks.collectLocalEvidence.mock
      .calls[0]?.[1] as AbortSignal;
    expect(forwardedSignal).toEqual(expect.any(AbortSignal));
    expect(forwardedSignal.aborted).toBe(false);

    controller.abort();

    expect(forwardedSignal.aborted).toBe(true);
  });

  it("returns bounded chunk references for deterministic attachment opening", async () => {
    const storage: AttachmentStorage = {
      getAuthorizedAttachment: vi.fn(async (requested) => ({
        ...requested,
        kind: "document" as const,
        filename: "manual.pdf",
        mimeType: "application/pdf",
        sizeBytes: 128,
        status: "ready" as const
      })),
      getParsedChunks: vi.fn(async () => [
        {
          attachmentId,
          chunkId: "manual-page-1",
          text: "维护间隔取决于工况。",
          pageNumber: 1
        }
      ]),
      putParsedChunks: vi.fn(async () => undefined)
    };
    const scoped = registry(
      "根据上传手册回答维护间隔。",
      undefined,
      undefined,
      storage
    );

    const result = await scoped.execute({
      callId: "call-attachment-search",
      name: "search_attachment",
      arguments: JSON.stringify({ attachmentId, query: "维护间隔" })
    });

    expect(result.ok).toBe(true);
    expect(result.attachmentMatches).toEqual([
      {
        attachmentId,
        chunkId: "manual-page-1",
        evidenceId: "E1",
        pageNumber: 1
      }
    ]);
    expect(result.outputItem).toMatchObject({
      type: "function_call_output",
      output: expect.stringContaining("manual-page-1")
    });
  });
});

function registry(
  question: string,
  artifactStorage?: ArtifactStorage,
  signal?: AbortSignal,
  attachmentStorage?: AttachmentStorage,
  verifiedUrlReader?: VerifiedUrlReader
) {
  return new ToolRegistry(new EvidenceRegistry(), {
    userId,
    conversationId,
    userMessageId: "00000000-0000-4000-8000-000000000004",
    assistantMessageId: "00000000-0000-4000-8000-000000000005",
    runId: "00000000-0000-4000-8000-000000000006",
    turnId,
    question,
    inputParts: [
      { type: "text", text: question },
      { type: "link", url: "https://example.com/manual", label: "说明书" },
      { type: "attachment", attachmentId }
    ],
    artifactStorage,
    attachmentStorage,
    verifiedUrlReader,
    signal
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
