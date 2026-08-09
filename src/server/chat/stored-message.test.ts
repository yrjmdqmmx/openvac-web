import { describe, expect, it } from "vitest";

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
