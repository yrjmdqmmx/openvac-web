import { describe, expect, it } from "vitest";

import {
  orderConversationMessages,
  promptAdminTableShape,
  sourceAdminTableShape
} from "./store";

describe("conversation message ordering", () => {
  it("uses the per-conversation sequence instead of timestamp or id order", () => {
    const answer = { id: "a-answer", sequence: 2, role: "assistant" };
    const question = { id: "z-question", sequence: 1, role: "user" };

    expect(orderConversationMessages([answer, question])).toEqual([
      question,
      answer
    ]);
  });
});

describe("generic administrator table shapes", () => {
  it("normalizes source publisher, domain, and license fields", () => {
    expect(
      sourceAdminTableShape({
        id: "source-1",
        name: "OpenVac manual",
        publisher: null,
        baseUrl: "https://docs.example.com/pumps",
        licensePolicy: "metadata-only",
        sourceTier: "manufacturer_metadata"
      })
    ).toMatchObject({
      id: "source-1",
      publisher: "OpenVac manual",
      domain: "docs.example.com",
      licenseClass: "metadata-only"
    });
  });

  it("normalizes prompt key and evaluation fields", () => {
    expect(
      promptAdminTableShape({
        id: "prompt-1",
        key: "expert.answer",
        version: 3
      })
    ).toMatchObject({
      id: "prompt-1",
      name: "expert.answer",
      version: 3,
      evaluationScore: null
    });
  });
});
