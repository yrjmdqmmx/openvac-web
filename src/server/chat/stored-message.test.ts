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
    ).toEqual({
      id: "message-1",
      role: "assistant",
      status: "completed",
      content: "answer",
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
