import { describe, expect, it } from "vitest";
import { VERIFIED_LINK_LABEL_FALLBACK } from "@/server/chat-v3/verified-link-label";

import {
  serializeStoredCitation,
  serializeStoredMessage
} from "./stored-message";

describe("stored chat message serialization", () => {
  it("places normalized citations in assistant meta", () => {
    const citation = serializeStoredCitation(
      {
        id: "citation-1",
        title: "Pump manual",
        url: "https://example.com/manual",
        license: "open",
        locator: { pageOrSection: "P.12" },
        metadata: {
          sourceId: "manual:1",
          publisher: "Example",
          fetchedAt: "2026-07-31T00:00:00.000Z"
        }
      },
      "example.com"
    );

    expect(
      serializeStoredMessage(
        {
          id: "message-1",
          role: "assistant",
          status: "completed",
          content: "answer",
          metadata: {
            riskLevel: "medium",
            missingInputs: ["入口压力"],
            webSearched: true
          }
        },
        citation ? [citation] : []
      )
    ).toMatchObject({
      id: "message-1",
      role: "assistant",
      status: "completed",
      content: "answer",
      parts: [{ type: "text", text: "answer" }],
      meta: {
        riskLevel: "medium",
        missingInputs: ["入口压力"],
        webSearched: true,
        citations: [
          {
            sourceId: "manual:1",
            title: "Pump manual",
            publisher: "Example",
            url: "https://example.com/manual",
            sourcePolicy: {
              linkAllowed: true,
              authoritative: true,
              allowedDomains: ["example.com"]
            },
            pageOrSection: "P.12",
            fetchedAt: "2026-07-31T00:00:00.000Z",
            licenseClass: "open"
          }
        ]
      }
    });
  });

  it("canonicalizes historical web citation and AnswerV3 link labels together", () => {
    const citation = serializeStoredCitation(
      {
        id: "citation-web-1",
        title: "provider tool_call result",
        url: "https://example.com/manual",
        license: "open",
        locator: {},
        metadata: {
          sourceId: "E1",
          originalSourceId: "web:legacy",
          publisher: "Example",
          fetchedAt: "2026-07-31T00:00:00.000Z"
        }
      },
      "example.com"
    );
    const serialized = serializeStoredMessage(
      {
        id: "message-web-v3",
        role: "assistant",
        status: "completed",
        content: "provider tool_call result",
        metadata: {
          riskLevel: "medium",
          verifiedLinks: [
            {
              type: "verified_link",
              linkId: "W1",
              url: "https://example.com/manual",
              label: "provider tool_call result",
              hostname: "example.com",
              status: "verified",
              evidenceIds: ["E1"]
            }
          ],
          artifacts: [
            {
              type: "artifact",
              artifactId: "00000000-0000-4000-8000-000000000071",
              kind: "parameter_table",
              title: "历史参数表",
              formats: ["csv"],
              status: "ready"
            }
          ]
        },
        answerPayload: {
          schemaVersion: "openvac.answer.v3",
          answerKind: "expert",
          riskLevel: "medium",
          blocks: [
            {
              type: "paragraph",
              text: "前级压力需要按具体型号核对。",
              evidenceIds: ["E1"]
            },
            {
              type: "link_reference",
              linkId: "W1",
              label: "provider tool_call result"
            }
          ],
          missingInputs: [],
          usedEvidenceIds: ["E1"],
          usedLinkIds: ["W1"]
        }
      },
      citation ? [citation] : []
    );

    expect(serialized?.meta?.citations[0]?.title).toBe(
      VERIFIED_LINK_LABEL_FALLBACK
    );
    expect(serialized?.meta?.answerV3?.blocks.at(-1)).toMatchObject({
      type: "link_reference",
      linkId: "W1",
      label: VERIFIED_LINK_LABEL_FALLBACK
    });
    expect(serialized?.content).toContain(VERIFIED_LINK_LABEL_FALLBACK);
    expect(serialized?.parts?.[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/\[1\]/u)
    });
    expect(
      serialized?.parts?.[0]?.type === "text"
        ? serialized.parts[0].text
        : undefined
    ).toContain(VERIFIED_LINK_LABEL_FALLBACK);
    expect(serialized?.parts).toHaveLength(3);
    expect(
      serialized?.parts?.filter((part) => part.type === "text")
    ).toHaveLength(1);
    expect(serialized?.parts?.[1]).toEqual({
      type: "verified_link",
      linkId: "W1",
      url: "https://example.com/manual",
      label: VERIFIED_LINK_LABEL_FALLBACK,
      hostname: "example.com",
      status: "verified",
      evidenceIds: ["E1"]
    });
    expect(serialized?.parts?.[2]).toEqual({
      type: "artifact",
      artifactId: "00000000-0000-4000-8000-000000000071",
      kind: "parameter_table",
      title: "历史参数表",
      formats: ["csv"],
      status: "ready"
    });
    expect(JSON.stringify(serialized)).not.toMatch(/provider|tool_call/u);
  });

  it("restores verified links and artifacts without exposing signed URLs", () => {
    const serialized = serializeStoredMessage(
      {
        id: "message-v3-parts",
        role: "assistant",
        status: "completed",
        content: "查看结果",
        metadata: {
          verifiedLinks: [
            {
              type: "verified_link",
              linkId: "link-1",
              url: "https://docs.example.com/manual",
              label: "设备手册",
              hostname: "docs.example.com",
              status: "verified"
            },
            {
              type: "verified_link",
              linkId: "link-secret",
              url: "https://docs.example.com/private?Signature=secret",
              label: "私有地址",
              hostname: "docs.example.com",
              status: "verified"
            }
          ],
          artifacts: [
            {
              type: "artifact",
              artifactId: "00000000-0000-4000-8000-000000000041",
              kind: "diagnosis_report",
              title: "诊断报告",
              formats: ["pdf", "docx"],
              status: "ready"
            }
          ]
        }
      },
      []
    );

    expect(serialized?.parts).toEqual([
      { type: "text", text: "查看结果" },
      {
        type: "verified_link",
        linkId: "link-1",
        url: "https://docs.example.com/manual",
        label: "设备手册",
        hostname: "docs.example.com",
        status: "verified"
      },
      {
        type: "artifact",
        artifactId: "00000000-0000-4000-8000-000000000041",
        kind: "diagnosis_report",
        title: "诊断报告",
        formats: ["pdf", "docx"],
        status: "ready"
      }
    ]);
    expect(JSON.stringify(serialized)).not.toContain("Signature");
    expect(JSON.stringify(serialized)).not.toContain("secret");
  });

  it("hydrates legacy attachment IDs with owned bound attachment metadata", () => {
    const serialized = serializeStoredMessage(
      {
        id: "message-legacy-attachment",
        role: "user",
        status: "completed",
        content: "请检查附件",
        metadata: {
          inputParts: [
            { type: "text", text: "请检查附件" },
            {
              type: "attachment",
              attachmentId: "00000000-0000-4000-8000-000000000051"
            }
          ]
        }
      },
      [],
      [
        {
          type: "attachment",
          attachmentId: "00000000-0000-4000-8000-000000000051",
          kind: "image",
          filename: "真空计读数.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          status: "ready"
        }
      ]
    );

    expect(serialized).toMatchObject({
      inputParts: [
        { type: "text", text: "请检查附件" },
        {
          type: "attachment",
          attachmentId: "00000000-0000-4000-8000-000000000051"
        }
      ],
      parts: [
        { type: "text", text: "请检查附件" },
        {
          type: "attachment",
          attachmentId: "00000000-0000-4000-8000-000000000051",
          kind: "image",
          filename: "真空计读数.png",
          mimeType: "image/png",
          sizeBytes: 2048,
          status: "ready"
        }
      ]
    });
  });

  it("drops non-public roles and citations without a URL", () => {
    expect(
      serializeStoredMessage(
        {
          id: "tool-1",
          role: "tool",
          status: "completed",
          content: "hidden",
          metadata: {}
        },
        []
      )
    ).toBeNull();
    expect(
      serializeStoredCitation({
        id: "citation-2",
        title: "Private row",
        url: null,
        license: null,
        locator: {},
        metadata: {}
      })
    ).toBeNull();
  });

  it("does not expose legacy modeling card metadata", () => {
    const serialized = serializeStoredMessage(
      {
        id: "message-modeling",
        role: "assistant",
        status: "completed",
        content: "打开建模项目",
        metadata: {
          modelingCards: [
            {
              kind: "project",
              projectId: "11111111-1111-4111-8111-111111111111",
              title: "原创旋片泵",
              href: "https://evil.example/steal"
            }
          ]
        }
      },
      []
    );
    expect(JSON.stringify(serialized)).not.toContain("modelingCards");
    expect(JSON.stringify(serialized)).not.toContain("evil.example");
  });

  it.each(["failed", "cancelled"])(
    "restores retry identifiers for %s answers without exposing provider or tool metadata",
    (status) => {
      const serialized = serializeStoredMessage(
        {
          id: `message-${status}`,
          role: "assistant",
          status,
          content: "本次回答未完成，可重试。",
          metadata: {
            turnId: "00000000-0000-4000-8000-000000000021",
            runId: "00000000-0000-4000-8000-000000000022",
            answerVersion: 3,
            provider: "private-provider",
            toolCalls: [{ toolName: "private_tool" }]
          },
          answerPayload: {
            providerResponseId: "provider-secret",
            toolName: "private_tool"
          }
        },
        []
      );

      expect(serialized).toMatchObject({
        status: "error",
        meta: {
          riskLevel: "low",
          missingInputs: [],
          webSearched: false,
          citations: [],
          turnId: "00000000-0000-4000-8000-000000000021",
          runId: "00000000-0000-4000-8000-000000000022",
          answerVersion: 3
        }
      });
      expect(JSON.stringify(serialized)).not.toMatch(
        /private-provider|private_tool|provider-secret/u
      );
    }
  );

  it("localizes legacy V2 calculation tool names before history reaches the UI", () => {
    const serialized = serializeStoredMessage(
      {
        id: "message-calculation",
        role: "assistant",
        status: "completed",
        content: "legacy projection",
        metadata: { riskLevel: "low" },
        answerPayload: {
          schemaVersion: "openvac.answer.v2",
          answerKind: "grounded",
          conclusion: [
            {
              text: "estimate_pumpdown_time 计算结果。",
              evidenceIds: []
            }
          ],
          assumptions: [],
          evidence: [],
          missingInputs: [],
          nextSteps: [],
          calculationRefs: ["calc_1"]
        }
      },
      []
    );

    const projection = JSON.stringify(serialized);
    expect(projection).toContain("抽空时间估算");
    expect(projection).not.toContain("estimate_pumpdown_time");
  });
});
