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
import {
  ARTIFACT_PROVIDER_INSTRUCTION,
  ARTIFACT_PROVIDER_LIMITS,
  createArtifactProviderSchema,
  PARAMETER_TABLE_PROVIDER_CONTRACT_VERSION,
  parameterTableProviderPayloadToArtifactArguments,
  parameterTableProviderSchema,
  ToolRegistry,
  visibleStringCharacters
} from "./tool-registry";
import type { VerifiedUrlReader } from "./verified-url";

const userId = "user-a";
const conversationId = "conversation-a";
const turnId = "ea538766-c8a3-4350-8894-8fb72233af12";
const attachmentId = "10000000-0000-4000-8000-000000000001";
const artifactId = "31d56d64-399a-4813-bad1-0c93e1eb8396";

describe("ToolRegistry V3 exposure", () => {
  it("uses a dedicated provider contract for explicit parameter tables", () => {
    const scoped = registry("生成泵组选型参数表，并导出 CSV。");
    const definition = scoped.definitions.find(
      (candidate) => candidate.name === "create_artifact"
    );

    expect(scoped.artifactProviderContract).toBe("parameter_table");
    expect(definition?.description).toContain("pumping speed");
    expect(definition?.description).toContain("首尾空白");
    expect(ARTIFACT_PROVIDER_INSTRUCTION).toContain("pumping speed");
    expect(ARTIFACT_PROVIDER_INSTRUCTION).toContain("首尾空白");
    expect(definition?.parameters).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["contractVersion", "tables"]),
      properties: {
        contractVersion: {
          const: PARAMETER_TABLE_PROVIDER_CONTRACT_VERSION
        },
        tables: {
          items: {
            properties: {
              rows: {
                items: {
                  properties: {
                    parameterKind: {
                      enum: ["physical", "descriptor", "count", "ratio"]
                    }
                  },
                  required: [
                    "parameterKind",
                    "parameter",
                    "valueOrStatus",
                    "unit",
                    "assumptionOrCondition"
                  ]
                }
              }
            }
          }
        }
      }
    });
  });

  it("does not let the generic provider contract create a parameter table", () => {
    const scoped = registry("生成诊断报告并附参数表。");
    const definition = scoped.definitions.find(
      (candidate) => candidate.name === "create_artifact"
    );
    const kindSchema = (
      definition?.parameters.properties as Record<string, unknown>
    )?.kind as { enum?: string[] } | undefined;

    expect(scoped.artifactProviderContract).toBeUndefined();
    expect(kindSchema?.enum).not.toContain("parameter_table");
    const preflight = scoped.preflight({
      callId: "call-generic-parameter-table-bypass",
      name: "create_artifact",
      arguments: JSON.stringify({
        schemaVersion: "openvac.artifact.v1",
        kind: "parameter_table",
        title: "参数表",
        formats: ["csv"],
        summary: "参数、单位和假设",
        sections: [],
        tables: [
          {
            columns: ["参数", "值", "单位/假设"],
            rows: [["有效抽速", "10", "L/s；额定工况"]]
          }
        ]
      })
    });

    expect(preflight.ok).toBe(false);
    if (preflight.ok) throw new Error("Expected generic contract rejection.");
    expect(preflight.result).toMatchObject({
      errorCode: "INVALID_TOOL_ARGUMENTS",
      missingInputs: ["parameterTable.providerContract"]
    });
  });

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

  it("publishes the bounded provider artifact envelope", () => {
    const scoped = registry("请生成中文诊断报告并导出 CSV");
    const definition = scoped.definitions.find(
      (tool) => tool.type === "function" && tool.name === "create_artifact"
    );
    expect(definition).toBeDefined();
    expect(definition?.description).toContain("选择 CSV 时必须提供");
    expect(definition?.parameters).toMatchObject({
      properties: {
        sections: {
          maxItems: ARTIFACT_PROVIDER_LIMITS.sections,
          items: {
            properties: {
              paragraphs: {
                minItems: 1,
                maxItems: ARTIFACT_PROVIDER_LIMITS.paragraphsPerSection,
                items: {
                  minLength: 1,
                  maxLength: ARTIFACT_PROVIDER_LIMITS.paragraphCharacters
                }
              }
            }
          }
        },
        tables: {
          maxItems: ARTIFACT_PROVIDER_LIMITS.tables,
          items: {
            properties: {
              columns: {
                minItems: 1,
                maxItems: ARTIFACT_PROVIDER_LIMITS.columnsPerTable,
                uniqueItems: true,
                items: {
                  minLength: 1,
                  maxLength: ARTIFACT_PROVIDER_LIMITS.columnHeaderCharacters
                }
              },
              rows: {
                minItems: 1,
                maxItems: ARTIFACT_PROVIDER_LIMITS.rowsPerTable,
                items: {
                  minItems: 1,
                  maxItems: ARTIFACT_PROVIDER_LIMITS.columnsPerTable,
                  items: {
                    maxLength: ARTIFACT_PROVIDER_LIMITS.cellCharacters
                  }
                }
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

  it("rejects a provider artifact above the generation envelope before storage", async () => {
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

    expect(result).toMatchObject({
      ok: false,
      errorCode: "INVALID_TOOL_ARGUMENTS"
    });
    expect(storage.create).not.toHaveBeenCalled();
  });

  it("enforces aggregate provider rows and visible characters", () => {
    const base = {
      schemaVersion: "openvac.artifact.v1" as const,
      kind: "parameter_table" as const,
      title: "泵组选型参数表",
      formats: ["csv"] as const,
      summary: "参数、单位和假设",
      sections: [],
      tables: [
        {
          columns: ["参数", "值", "单位/假设"],
          rows: Array.from({ length: 32 }, (_, index) => [
            `参数 ${index + 1}`,
            String(index + 1),
            "Pa；假设稳态"
          ])
        },
        {
          columns: ["参数", "值", "单位/假设"],
          rows: Array.from({ length: 32 }, (_, index) => [
            `工况 ${index + 1}`,
            String(index + 1),
            "L/s；额定工况"
          ])
        }
      ]
    };

    expect(createArtifactProviderSchema.safeParse(base).success).toBe(true);
    expect(visibleStringCharacters(base)).toBeLessThanOrEqual(
      ARTIFACT_PROVIDER_LIMITS.visibleCharacters
    );
    expect(
      createArtifactProviderSchema.safeParse({
        ...base,
        tables: [
          base.tables[0],
          {
            ...base.tables[1],
            rows: [...base.tables[1].rows, ["额外参数", "1", "Pa"]]
          }
        ]
      }).success
    ).toBe(false);
    expect(
      createArtifactProviderSchema.safeParse(
        providerSpecWithVisibleCharacters(
          ARTIFACT_PROVIDER_LIMITS.visibleCharacters
        )
      ).success
    ).toBe(true);
    expect(
      createArtifactProviderSchema.safeParse(
        providerSpecWithVisibleCharacters(
          ARTIFACT_PROVIDER_LIMITS.visibleCharacters + 1
        )
      ).success
    ).toBe(false);
  });

  it("enforces the dedicated parameter contract at every aggregate boundary", () => {
    const base = {
      ...validParameterTableProviderPayload(),
      tables: [
        {
          title: "表一",
          rows: Array.from({ length: 32 }, (_, index) => ({
            parameterKind: "physical",
            parameter: "目标入口压力",
            valueOrStatus: String(index + 1),
            unit: "Pa",
            assumptionOrCondition: "待用户确认"
          }))
        },
        {
          title: "表二",
          rows: Array.from({ length: 32 }, (_, index) => ({
            parameterKind: "physical",
            parameter: "目标有效抽速",
            valueOrStatus: String(index + 1),
            unit: "L/s",
            assumptionOrCondition: "额定工况"
          }))
        }
      ]
    };

    expect(parameterTableProviderSchema.safeParse(base).success).toBe(true);
    expect(
      parameterTableProviderSchema.safeParse({
        ...base,
        tables: [
          base.tables[0],
          {
            ...base.tables[1],
            rows: [
              ...base.tables[1].rows,
              {
                parameterKind: "physical",
                parameter: "额外入口压力",
                valueOrStatus: "1",
                unit: "Pa",
                assumptionOrCondition: "待用户确认"
              }
            ]
          }
        ]
      }).success
    ).toBe(false);
    const scoped = registry("生成泵组选型参数表，并导出 CSV。");
    const atVisibleLimit = parameterProviderPayloadWithVisibleCharacters(
      ARTIFACT_PROVIDER_LIMITS.visibleCharacters
    );
    expect(visibleStringCharacters(atVisibleLimit)).toBe(
      ARTIFACT_PROVIDER_LIMITS.visibleCharacters
    );
    expect(
      visibleStringCharacters(
        parameterTableProviderPayloadToArtifactArguments(atVisibleLimit)
      )
    ).toBeLessThanOrEqual(ARTIFACT_PROVIDER_LIMITS.visibleCharacters);
    expect(
      scoped.preflight({
        callId: "call-parameter-visible-limit",
        name: "create_artifact",
        arguments: JSON.stringify(atVisibleLimit)
      }).ok
    ).toBe(true);
    const overVisibleLimit = scoped.preflight({
      callId: "call-parameter-visible-over-limit",
      name: "create_artifact",
      arguments: JSON.stringify(
        parameterProviderPayloadWithVisibleCharacters(
          ARTIFACT_PROVIDER_LIMITS.visibleCharacters + 1
        )
      )
    });
    expect(overVisibleLimit.ok).toBe(false);
    if (overVisibleLimit.ok)
      throw new Error("Expected provider visible-limit rejection.");
    expect(overVisibleLimit.result.missingInputs).toEqual([
      "providerEnvelope.visibleCharacters"
    ]);
    const mappedAtVisibleLimit =
      parameterProviderPayloadWithCanonicalVisibleCharacters(
        ARTIFACT_PROVIDER_LIMITS.visibleCharacters
      );
    expect(visibleStringCharacters(mappedAtVisibleLimit)).toBeLessThanOrEqual(
      ARTIFACT_PROVIDER_LIMITS.visibleCharacters
    );
    expect(
      scoped.preflight({
        callId: "call-parameter-canonical-visible-limit",
        name: "create_artifact",
        arguments: JSON.stringify(mappedAtVisibleLimit)
      }).ok
    ).toBe(true);
    const mappedAtVisibleLimitArguments =
      parameterTableProviderPayloadToArtifactArguments(mappedAtVisibleLimit);
    expect(visibleStringCharacters(mappedAtVisibleLimitArguments)).toBe(
      ARTIFACT_PROVIDER_LIMITS.visibleCharacters
    );
    expect(
      createArtifactProviderSchema.safeParse(mappedAtVisibleLimitArguments)
        .success
    ).toBe(true);
    const mappedOverVisibleLimit =
      parameterProviderPayloadWithCanonicalVisibleCharacters(
        ARTIFACT_PROVIDER_LIMITS.visibleCharacters + 1
      );
    expect(visibleStringCharacters(mappedOverVisibleLimit)).toBeLessThanOrEqual(
      ARTIFACT_PROVIDER_LIMITS.visibleCharacters
    );
    const mappedOverVisibleLimitArguments =
      parameterTableProviderPayloadToArtifactArguments(mappedOverVisibleLimit);
    expect(visibleStringCharacters(mappedOverVisibleLimitArguments)).toBe(
      ARTIFACT_PROVIDER_LIMITS.visibleCharacters + 1
    );
    expect(
      createArtifactProviderSchema.safeParse(mappedOverVisibleLimitArguments)
        .success
    ).toBe(false);
    const canonicalOverVisibleLimit = scoped.preflight({
      callId: "call-parameter-canonical-visible-over-limit",
      name: "create_artifact",
      arguments: JSON.stringify(mappedOverVisibleLimit)
    });
    expect(canonicalOverVisibleLimit.ok).toBe(false);
    if (canonicalOverVisibleLimit.ok)
      throw new Error("Expected canonical visible-limit rejection.");
    expect(canonicalOverVisibleLimit.result.missingInputs).toEqual([
      "providerEnvelope.visibleCharacters"
    ]);
    expect(
      parameterTableProviderSchema.safeParse({
        ...validParameterTableProviderPayload(),
        title: ` ${validParameterTableProviderPayload().title}`
      }).success
    ).toBe(false);
    const unicodeAtCellLimit = {
      ...validParameterTableProviderPayload(),
      tables: [
        {
          ...validParameterTableProviderPayload().tables[0],
          rows: [
            {
              ...validParameterTableProviderPayload().tables[0].rows[0],
              valueOrStatus: "😀".repeat(
                ARTIFACT_PROVIDER_LIMITS.cellCharacters
              )
            }
          ]
        }
      ]
    };
    expect(
      parameterTableProviderSchema.safeParse(unicodeAtCellLimit).success
    ).toBe(true);
    expect(
      createArtifactProviderSchema.safeParse(
        parameterTableProviderPayloadToArtifactArguments(
          parameterTableProviderSchema.parse(unicodeAtCellLimit)
        )
      ).success
    ).toBe(true);
    expect(
      parameterTableProviderSchema.safeParse({
        ...unicodeAtCellLimit,
        tables: [
          {
            ...unicodeAtCellLimit.tables[0],
            rows: [
              {
                ...unicodeAtCellLimit.tables[0].rows[0],
                valueOrStatus: "😀".repeat(
                  ARTIFACT_PROVIDER_LIMITS.cellCharacters + 1
                )
              }
            ]
          }
        ]
      }).success
    ).toBe(false);
    expect(
      parameterTableProviderSchema.safeParse({
        ...validParameterTableProviderPayload(),
        tables: [
          {
            ...validParameterTableProviderPayload().tables[0],
            rows: [
              {
                ...validParameterTableProviderPayload().tables[0].rows[0],
                unit: "u".repeat(ARTIFACT_PROVIDER_LIMITS.cellCharacters + 1)
              }
            ]
          }
        ]
      }).success
    ).toBe(false);
  });

  it("maps the dedicated parameter-table payload without inventing content", async () => {
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
    const scoped = registry("生成泵组选型参数表，并导出 CSV。", storage);
    const providerPayload = {
      contractVersion: PARAMETER_TABLE_PROVIDER_CONTRACT_VERSION,
      title: "泵组选型参数表",
      formats: ["csv"] as const,
      summary: "参数、单位和待确认工况",
      sections: [],
      tables: [
        {
          title: "泵组参数",
          rows: [
            {
              parameterKind: "physical",
              parameter: "有效抽速",
              valueOrStatus: "待用户确认",
              unit: "L/s",
              assumptionOrCondition: "待用户确认"
            }
          ]
        }
      ]
    };

    expect(
      parameterTableProviderSchema.safeParse(providerPayload).success
    ).toBe(true);
    const result = await scoped.execute({
      callId: "call-parameter-provider-contract",
      name: "create_artifact",
      arguments: JSON.stringify(providerPayload)
    });

    expect(result.ok).toBe(true);
    expect(storage.create).toHaveBeenCalledTimes(1);
    expect(storage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: expect.objectContaining({
          schemaVersion: "openvac.artifact.v1",
          kind: "parameter_table",
          tables: [
            {
              title: "泵组参数",
              columns: ["参数", "数值或状态", "单位", "假设或工况"],
              rows: [["有效抽速", "待用户确认", "L/s", "待用户确认"]]
            }
          ]
        })
      })
    );
  });

  it("rejects an incomplete row but allows non-physical rows when aggregate semantics are valid", async () => {
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
    const scoped = registry("生成泵组选型参数表，并导出 CSV。", storage);
    const preflight = scoped.preflight({
      callId: "call-incomplete-parameter-provider-contract",
      name: "create_artifact",
      arguments: JSON.stringify({
        contractVersion: PARAMETER_TABLE_PROVIDER_CONTRACT_VERSION,
        title: "泵组选型参数表",
        formats: ["csv"],
        summary: "参数、单位和假设",
        sections: [],
        tables: [
          {
            title: "泵组参数",
            rows: [
              {
                parameterKind: "physical",
                parameter: "有效抽速",
                valueOrStatus: "待用户确认",
                unit: "L/s"
              }
            ]
          }
        ]
      })
    });

    expect(preflight.ok).toBe(false);
    if (preflight.ok) throw new Error("Expected provider-contract rejection.");
    expect(preflight.result).toMatchObject({
      errorCode: "INVALID_TOOL_ARGUMENTS"
    });
    expect(JSON.stringify(preflight.result.outputItem)).toContain(
      "assumptionOrCondition"
    );
    expect(storage.create).not.toHaveBeenCalled();

    const mixedRows = scoped.preflight({
      callId: "call-mixed-parameter-provider-contract",
      name: "create_artifact",
      arguments: JSON.stringify({
        ...validParameterTableProviderPayload(),
        tables: [
          {
            title: "泵组参数",
            rows: [
              validParameterTableProviderPayload().tables[0].rows[0],
              {
                parameterKind: "descriptor",
                parameter: "备用泵密封配置",
                valueOrStatus: "待用户确认",
                unit: "不适用",
                assumptionOrCondition: "待用户确认"
              }
            ]
          }
        ]
      })
    });
    expect(mixedRows.ok).toBe(true);
    if (!mixedRows.ok)
      throw new Error("Expected aggregate semantic acceptance.");
    expect(mixedRows.artifactSpec).toMatchObject({
      kind: "parameter_table",
      tables: [
        {
          columns: ["参数", "数值或状态", "单位", "假设或工况"],
          rows: [
            ["有效抽速", "待用户确认", "L/s", "待用户确认"],
            ["备用泵密封配置", "待用户确认", "不适用", "待用户确认"]
          ]
        }
      ]
    });
    for (const testCase of [
      {
        parameterKind: "descriptor",
        parameter: "泵型号",
        unit: "不适用",
        expected: true
      },
      {
        parameterKind: "count",
        parameter: "数量",
        unit: "台",
        expected: true
      },
      {
        parameterKind: "ratio",
        parameter: "效率",
        unit: "%",
        expected: true
      },
      {
        parameterKind: "descriptor",
        parameter: "备用泵密封配置",
        unit: "不适用",
        expected: true
      },
      {
        parameterKind: "descriptor",
        parameter: "适用介质/清洁度要求",
        unit: "不适用",
        expected: true
      },
      {
        parameterKind: "ratio",
        parameter: "级间压缩比",
        unit: "无量纲",
        expected: true
      },
      {
        parameterKind: "physical",
        parameter: "有效抽速",
        unit: "L/s",
        expected: true
      },
      {
        parameterKind: "physical",
        parameter: "target inlet pressure",
        unit: "Pa",
        expected: true
      },
      {
        parameterKind: "physical",
        parameter: "腔体容积",
        unit: "L",
        expected: true
      },
      {
        parameterKind: "physical",
        parameter: "附件流导",
        unit: "L/s",
        expected: true
      },
      {
        parameterKind: "physical",
        parameter: "工艺进气量",
        unit: "Pa·m³/s",
        expected: true
      },
      {
        parameterKind: "physical",
        parameter: "chamber volume",
        unit: "L",
        expected: true
      },
      {
        parameterKind: "physical",
        parameter: "accessory conductance",
        unit: "L/s",
        expected: true
      },
      {
        parameterKind: "physical",
        parameter: "process gas flow",
        unit: "sccm",
        expected: true
      },
      {
        parameterKind: "descriptor",
        parameter: "backup pump configuration",
        unit: "n/a",
        expected: true
      },
      {
        parameterKind: "count",
        parameter: "pump quantity",
        unit: "dimensionless",
        expected: true
      },
      {
        parameterKind: "ratio",
        parameter: "overall efficiency",
        unit: "%",
        expected: true
      },
      {
        parameterKind: "physical",
        parameter: "有效抽速",
        unit: "待用户确认",
        expected: false
      },
      {
        parameterKind: "descriptor",
        parameter: "泵型号",
        unit: "-",
        expected: false
      },
      {
        parameterKind: "descriptor",
        parameter: "泵型号",
        unit: "%",
        expected: false
      },
      {
        parameterKind: "physical",
        parameter: "额定压力",
        unit: "%",
        expected: false
      },
      {
        parameterKind: "descriptor",
        parameter: "入口压力",
        unit: "不适用",
        expected: false
      },
      {
        parameterKind: "ratio",
        parameter: "额定压力",
        unit: "%",
        expected: false
      },
      {
        parameterKind: "count",
        parameter: "有效抽速",
        unit: "台",
        expected: false
      },
      {
        parameterKind: "physical",
        parameter: "泵型号",
        unit: "Pa",
        expected: false
      },
      {
        parameterKind: "descriptor",
        parameter: "自定义指标",
        unit: "不适用",
        expected: false
      },
      {
        parameterKind: "descriptor",
        parameter: "target inlet pressure",
        unit: "n/a",
        expected: false
      },
      {
        parameterKind: "descriptor",
        parameter: "chamber volume",
        unit: "n/a",
        expected: false
      },
      {
        parameterKind: "descriptor",
        parameter: "custom metric",
        unit: "n/a",
        expected: false
      },
      {
        parameterKind: "descriptor",
        parameter: "prototype",
        unit: "n/a",
        expected: false
      },
      {
        parameterKind: "descriptor",
        parameter: "brandname",
        unit: "n/a",
        expected: false
      },
      {
        parameterKind: "ratio",
        parameter: "inefficiency",
        unit: "%",
        expected: false
      },
      {
        parameterKind: "physical",
        parameter: "sometime",
        unit: "s",
        expected: false
      },
      {
        parameterKind: "descriptor",
        parameter: "proto\u200btype",
        unit: "n/a",
        expected: false
      },
      {
        parameterKind: "descriptor",
        parameter: "proto\u0301type",
        unit: "n/a",
        expected: false
      },
      {
        parameterKind: "descriptor",
        parameter: "proto\u0000type",
        unit: "n/a",
        expected: false
      }
    ]) {
      expect(
        parameterTableProviderSchema.safeParse({
          ...validParameterTableProviderPayload(),
          tables: [
            {
              title: "泵组参数",
              rows: [
                validParameterTableProviderPayload().tables[0].rows[0],
                {
                  parameterKind: testCase.parameterKind,
                  parameter: testCase.parameter,
                  valueOrStatus: "待用户确认",
                  unit: testCase.unit,
                  assumptionOrCondition: "待用户确认"
                }
              ]
            }
          ]
        }).success
      ).toBe(testCase.expected);
    }
    for (const mismatch of [
      {
        parameterKind: "descriptor",
        parameter: "入口压力",
        unit: "n/a"
      },
      {
        parameterKind: "physical",
        parameter: "泵型号",
        unit: "Pa"
      }
    ]) {
      const mismatchPreflight = scoped.preflight({
        callId: `call-authoritative-kind-${mismatch.parameterKind}`,
        name: "create_artifact",
        arguments: JSON.stringify({
          ...validParameterTableProviderPayload(),
          tables: [
            {
              title: "泵组参数",
              rows: [
                validParameterTableProviderPayload().tables[0].rows[0],
                {
                  ...mismatch,
                  valueOrStatus: "待用户确认",
                  assumptionOrCondition: "待用户确认"
                }
              ]
            }
          ]
        })
      });
      expect(mismatchPreflight.ok).toBe(false);
      if (mismatchPreflight.ok)
        throw new Error("Expected authoritative-kind rejection.");
      expect(mismatchPreflight.result.missingInputs).toEqual([
        "tables.0.rows.1.parameterKind",
        "tables.0.rows.1.unit"
      ]);
    }
    const noServerPhysical = scoped.preflight({
      callId: "call-provider-kind-cannot-satisfy-physical-aggregate",
      name: "create_artifact",
      arguments: JSON.stringify({
        ...validParameterTableProviderPayload(),
        tables: [
          {
            title: "泵组参数",
            rows: [
              {
                parameterKind: "physical",
                parameter: "泵型号",
                valueOrStatus: "待用户确认",
                unit: "Pa",
                assumptionOrCondition: "待用户确认"
              }
            ]
          }
        ]
      })
    });
    expect(noServerPhysical.ok).toBe(false);
    if (noServerPhysical.ok)
      throw new Error("Expected server-derived aggregate rejection.");
    expect(noServerPhysical.result.missingInputs).toEqual([
      "tables.0.rows.0.parameterKind",
      "tables.0.rows.0.unit",
      "tables"
    ]);
    const unsupported = scoped.preflight({
      callId: "call-unsupported-parameter-vocabulary",
      name: "create_artifact",
      arguments: JSON.stringify({
        ...validParameterTableProviderPayload(),
        tables: [
          {
            title: "泵组参数",
            rows: [
              validParameterTableProviderPayload().tables[0].rows[0],
              {
                parameterKind: "descriptor",
                parameter: "custom metric",
                valueOrStatus: "待用户确认",
                unit: "n/a",
                assumptionOrCondition: "待用户确认"
              }
            ]
          }
        ]
      })
    });
    expect(unsupported.ok).toBe(false);
    if (unsupported.ok) throw new Error("Expected vocabulary rejection.");
    expect(unsupported.result.missingInputs).toEqual([
      "tables.0.rows.1.parameter",
      "tables.0.rows.1.parameterKind"
    ]);
    expect(storage.create).not.toHaveBeenCalled();
  });

  it("rejects parameter tables without real unit and assumption values before storage", async () => {
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
    const invalidArguments = JSON.stringify({
      contractVersion: PARAMETER_TABLE_PROVIDER_CONTRACT_VERSION,
      title: "泵组选型参数表",
      formats: ["csv"],
      summary: "参数表包含单位和假设",
      sections: [],
      tables: [
        {
          title: "泵组参数",
          rows: [
            {
              parameterKind: "physical",
              parameter: "有效抽速",
              valueOrStatus: "10",
              unit: "L/s",
              assumptionOrCondition: "-"
            }
          ]
        }
      ]
    });

    const preflight = scoped.preflight({
      callId: "call-parameter-semantics-invalid",
      name: "create_artifact",
      arguments: invalidArguments
    });

    expect(preflight.ok).toBe(false);
    if (preflight.ok) throw new Error("Expected semantic preflight failure.");
    expect(preflight.result).toMatchObject({
      errorCode: "INVALID_TOOL_ARGUMENTS",
      missingInputs: ["tables.0.rows.0.assumptionOrCondition"]
    });
    expect(preflight.result.outputItem).toMatchObject({
      type: "function_call_output",
      output: expect.stringContaining("tables.0.rows.0.assumptionOrCondition")
    });
    expect(preflight.result.outputItem).not.toEqual(
      expect.objectContaining({ output: expect.stringContaining("有效抽速") })
    );
    expect(storage.create).not.toHaveBeenCalled();

    const missingUnit = scoped.preflight({
      callId: "call-parameter-unit-invalid",
      name: "create_artifact",
      arguments: JSON.stringify({
        ...JSON.parse(invalidArguments),
        tables: [
          {
            title: "泵组参数",
            rows: [
              {
                parameterKind: "physical",
                parameter: "有效抽速",
                valueOrStatus: "10",
                unit: "待用户确认",
                assumptionOrCondition: "稳态运行"
              }
            ]
          }
        ]
      })
    });
    expect(missingUnit.ok).toBe(false);
    if (missingUnit.ok) throw new Error("Expected unit preflight failure.");
    expect(missingUnit.result).toMatchObject({
      errorCode: "INVALID_TOOL_ARGUMENTS",
      missingInputs: ["tables.0.rows.0.unit", "tables"]
    });
    expect(storage.create).not.toHaveBeenCalled();

    const onlyNonPhysicalArguments = JSON.stringify({
      ...validParameterTableProviderPayload(),
      tables: [
        {
          title: "泵组参数",
          rows: [
            {
              parameterKind: "descriptor",
              parameter: "泵型号",
              valueOrStatus: "待用户确认",
              unit: "不适用",
              assumptionOrCondition: "待用户确认"
            }
          ]
        }
      ]
    });
    const onlyNonPhysical = scoped.preflight({
      callId: "call-parameter-only-non-physical",
      name: "create_artifact",
      arguments: onlyNonPhysicalArguments
    });
    expect(onlyNonPhysical.ok).toBe(false);
    if (onlyNonPhysical.ok)
      throw new Error("Expected physical-row aggregate failure.");
    expect(onlyNonPhysical.result).toMatchObject({
      errorCode: "INVALID_TOOL_ARGUMENTS",
      missingInputs: ["tables"]
    });
    await expect(
      scoped.execute({
        callId: "call-parameter-only-non-physical-execute",
        name: "create_artifact",
        arguments: onlyNonPhysicalArguments
      })
    ).resolves.toMatchObject({ ok: false });
    expect(storage.create).not.toHaveBeenCalled();

    const compositeDescriptorArguments = JSON.stringify({
      ...validParameterTableProviderPayload(),
      tables: [
        {
          title: "泵组参数",
          rows: [
            validParameterTableProviderPayload().tables[0].rows[0],
            {
              parameterKind: "descriptor",
              parameter: "备用泵密封配置",
              valueOrStatus: "待用户确认",
              unit: "不适用",
              assumptionOrCondition: "待用户确认"
            }
          ]
        }
      ]
    });
    const compositeDescriptor = scoped.preflight({
      callId: "call-parameter-composite-descriptor",
      name: "create_artifact",
      arguments: compositeDescriptorArguments
    });
    expect(compositeDescriptor.ok).toBe(true);
    if (!compositeDescriptor.ok)
      throw new Error("Expected composite descriptor acceptance.");
    expect(compositeDescriptor.artifactSpec).toMatchObject({
      tables: [
        {
          columns: ["参数", "数值或状态", "单位", "假设或工况"],
          rows: [
            ["有效抽速", "待用户确认", "L/s", "待用户确认"],
            ["备用泵密封配置", "待用户确认", "不适用", "待用户确认"]
          ]
        }
      ]
    });
    expect(storage.create).not.toHaveBeenCalled();

    const structurallyInvalid = scoped.preflight({
      callId: "call-parameter-structure-invalid",
      name: "create_artifact",
      arguments: JSON.stringify({
        ...JSON.parse(invalidArguments),
        tables: [
          {
            title: "泵组参数",
            rows: [
              {
                parameterKind: "physical",
                parameter: "有效抽速",
                valueOrStatus: "10",
                unit: "L/s"
              }
            ]
          }
        ]
      })
    });
    expect(structurallyInvalid.ok).toBe(false);
    if (structurallyInvalid.ok) {
      throw new Error("Expected structural preflight failure.");
    }
    expect(structurallyInvalid.result.errorCode).toBe("INVALID_TOOL_ARGUMENTS");
    if (structurallyInvalid.result.outputItem.type !== "function_call_output") {
      throw new Error("Expected structural function output.");
    }
    const structuralOutput = JSON.parse(
      String(structurallyInvalid.result.outputItem.output)
    ) as { missingInputs?: string[] };
    expect(structuralOutput.missingInputs).not.toContain(
      "parameterTable.assumption"
    );
    expect(structuralOutput.missingInputs?.length).toBeGreaterThan(0);
    expect(storage.create).not.toHaveBeenCalled();

    await expect(
      scoped.execute({
        callId: "call-parameter-semantics-valid",
        name: "create_artifact",
        arguments: JSON.stringify({
          ...JSON.parse(invalidArguments),
          tables: [
            {
              title: "泵组参数",
              rows: [
                {
                  parameterKind: "physical",
                  parameter: "有效抽速",
                  valueOrStatus: "10",
                  unit: "L/s",
                  assumptionOrCondition: "稳态运行"
                }
              ]
            }
          ]
        })
      })
    ).resolves.toMatchObject({ ok: true });
    expect(storage.create).toHaveBeenCalledTimes(1);
  });

  it("enforces the provider raw UTF-8 boundary after JSON parsing", () => {
    const scoped = registry("请生成泵组选型参数表并导出 CSV");
    const compact = JSON.stringify(validParameterTableProviderPayload());
    const compactBytes = Buffer.byteLength(compact, "utf8");
    expect(compactBytes).toBeLessThan(
      ARTIFACT_PROVIDER_LIMITS.rawArgumentBytes
    );
    const atLimit = `${compact}${" ".repeat(
      ARTIFACT_PROVIDER_LIMITS.rawArgumentBytes - compactBytes
    )}`;
    expect(Buffer.byteLength(atLimit, "utf8")).toBe(
      ARTIFACT_PROVIDER_LIMITS.rawArgumentBytes
    );
    expect(
      scoped.preflight({
        callId: "call-provider-raw-limit",
        name: "create_artifact",
        arguments: atLimit
      }).ok
    ).toBe(true);
    const overLimit = `${atLimit} `;
    const result = scoped.preflight({
      callId: "call-provider-raw-over-limit",
      name: "create_artifact",
      arguments: overLimit
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected provider raw limit failure.");
    expect(result.result.errorCode).toBe("INVALID_TOOL_ARGUMENTS");
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

function providerSpecWithVisibleCharacters(target: number) {
  const spec = {
    schemaVersion: "openvac.artifact.v1" as const,
    kind: "parameter_table" as const,
    title: "表",
    formats: ["csv"] as const,
    summary: "表",
    sections: [],
    tables: [
      {
        columns: [
          "参数",
          "值",
          "说明",
          "列3",
          "列4",
          "列5",
          "列6",
          "单位/假设"
        ],
        rows: Array.from({ length: 64 }, () =>
          Array.from({ length: 8 }, () => "")
        )
      }
    ]
  };
  spec.tables[0].rows[0][7] = "Pa；假设稳态";
  let remaining = target - visibleStringCharacters(spec);
  if (remaining < 0) throw new Error("Target is smaller than the base spec.");
  for (const [rowIndex, row] of spec.tables[0].rows.entries()) {
    for (let index = 0; index < row.length && remaining > 0; index += 1) {
      if (rowIndex === 0 && index === 7) continue;
      const length = Math.min(
        ARTIFACT_PROVIDER_LIMITS.cellCharacters,
        remaining
      );
      row[index] = "界".repeat(length);
      remaining -= length;
    }
  }
  if (remaining !== 0) throw new Error("Target exceeds provider capacity.");
  return spec;
}

function validParameterTableProviderPayload() {
  return {
    contractVersion: "openvac.parameter-table-provider.v2" as const,
    title: "泵组选型参数表",
    formats: ["csv" as const],
    summary: "参数、单位和假设",
    sections: [] as Array<{ heading: string; paragraphs: string[] }>,
    tables: [
      {
        title: "泵组参数",
        rows: [
          {
            parameterKind: "physical",
            parameter: "有效抽速",
            valueOrStatus: "待用户确认",
            unit: "L/s",
            assumptionOrCondition: "待用户确认"
          }
        ]
      }
    ]
  };
}

function parameterProviderPayloadWithVisibleCharacters(target: number) {
  const payload = {
    ...validParameterTableProviderPayload(),
    tables: [
      {
        title: "表",
        rows: Array.from({ length: 64 }, () => ({
          parameterKind: "physical" as const,
          parameter: "入口压力",
          valueOrStatus: "值",
          unit: "Pa",
          assumptionOrCondition: "待用户确认"
        }))
      }
    ]
  };
  let remaining = target - visibleStringCharacters(payload);
  if (remaining < 0)
    throw new Error("Target is smaller than the base payload.");
  for (const row of payload.tables[0].rows) {
    for (const key of ["valueOrStatus", "assumptionOrCondition"] as const) {
      if (remaining <= 0) break;
      const capacity =
        ARTIFACT_PROVIDER_LIMITS.cellCharacters - Array.from(row[key]).length;
      const length = Math.min(capacity, remaining);
      row[key] += "x".repeat(length);
      remaining -= length;
    }
  }
  if (remaining !== 0) throw new Error("Target exceeds provider capacity.");
  return payload;
}

function parameterProviderPayloadWithCanonicalVisibleCharacters(
  target: number
) {
  const payload = {
    ...validParameterTableProviderPayload(),
    title: "表",
    summary: "说明",
    sections: Array.from({ length: 4 }, () => ({
      heading: "节",
      paragraphs: Array.from({ length: 4 }, () => "段")
    })),
    tables: [
      {
        title: "表",
        rows: [
          {
            parameterKind: "physical" as const,
            parameter: "入口压力",
            valueOrStatus: "值",
            unit: "Pa",
            assumptionOrCondition: "待用户确认"
          }
        ]
      }
    ]
  };
  let remaining =
    target -
    visibleStringCharacters(
      parameterTableProviderPayloadToArtifactArguments(payload)
    );
  if (remaining < 0)
    throw new Error("Target is smaller than the canonical base payload.");
  const extend = (value: string, maximum: number) => {
    const length = Math.min(maximum - Array.from(value).length, remaining);
    remaining -= length;
    return value + "x".repeat(length);
  };
  payload.title = extend(
    payload.title,
    ARTIFACT_PROVIDER_LIMITS.titleCharacters
  );
  payload.summary = extend(
    payload.summary,
    ARTIFACT_PROVIDER_LIMITS.summaryCharacters
  );
  for (const section of payload.sections) {
    section.heading = extend(
      section.heading,
      ARTIFACT_PROVIDER_LIMITS.titleCharacters
    );
    for (let index = 0; index < section.paragraphs.length; index += 1) {
      section.paragraphs[index] = extend(
        section.paragraphs[index]!,
        ARTIFACT_PROVIDER_LIMITS.paragraphCharacters
      );
    }
  }
  payload.tables[0].title = extend(
    payload.tables[0].title,
    ARTIFACT_PROVIDER_LIMITS.titleCharacters
  );
  const row = payload.tables[0].rows[0];
  row.valueOrStatus = extend(
    row.valueOrStatus,
    ARTIFACT_PROVIDER_LIMITS.cellCharacters
  );
  row.assumptionOrCondition = extend(
    row.assumptionOrCondition,
    ARTIFACT_PROVIDER_LIMITS.cellCharacters
  );
  if (remaining !== 0)
    throw new Error("Target exceeds canonical provider capacity.");
  return payload;
}
