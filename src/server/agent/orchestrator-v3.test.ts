import { describe, expect, it } from "vitest";

import type { CalculationResult, Citation } from "@/types/chat";
import type { AnswerV3 } from "@/types/chat-v3";

import {
  localizeKnownCalculationBlocks,
  persistAndPublishFinalAnswer,
  type OrchestratorEvent
} from "./orchestrator";

const finalAnswer: AnswerV3 = {
  schemaVersion: "openvac.answer.v3",
  answerKind: "direct",
  riskLevel: "low",
  blocks: [{ type: "paragraph", text: "已持久化回答", evidenceIds: ["E1"] }],
  missingInputs: [],
  usedEvidenceIds: ["E1"],
  usedLinkIds: []
};

const finalCitation: Citation = {
  sourceId: "E1",
  title: "Pump manual",
  publisher: "Example",
  url: "https://example.com/manual",
  sourcePolicy: {
    linkAllowed: true,
    authoritative: true,
    allowedDomains: ["example.com"]
  },
  fetchedAt: "2026-08-09T00:00:00.000Z",
  licenseClass: "open"
};

describe("Agent V3 orchestrator output boundary", () => {
  it("publishes final blocks and citations only after atomic completion succeeds", async () => {
    const order: string[] = [];
    const emitted: OrchestratorEvent[] = [];
    let resolvePersistence: ((value: { content: string }) => void) | undefined;
    const persistence = new Promise<{ content: string }>((resolve) => {
      resolvePersistence = resolve;
    });

    const completion = persistAndPublishFinalAnswer({
      persist: async () => {
        order.push("store.started");
        const stored = await persistence;
        order.push("store.completed");
        return stored;
      },
      answer: finalAnswer,
      citations: [finalCitation],
      emit: (event) => {
        emitted.push(event);
        order.push(event.type);
      }
    });

    await Promise.resolve();
    expect(order).toEqual(["store.started"]);
    expect(emitted).toEqual([]);

    resolvePersistence?.({ content: "saved" });
    await expect(completion).resolves.toEqual({ content: "saved" });
    order.push("run.completed");

    expect(order).toEqual([
      "store.started",
      "store.completed",
      "block",
      "citation",
      "run.completed"
    ]);
  });

  it("publishes no final answer events when atomic completion fails", async () => {
    const emitted: OrchestratorEvent[] = [];

    await expect(
      persistAndPublishFinalAnswer({
        persist: () => Promise.reject(new Error("transaction rolled back")),
        answer: finalAnswer,
        citations: [finalCitation],
        emit: (event) => emitted.push(event)
      })
    ).rejects.toThrow("transaction rolled back");
    expect(emitted).toEqual([]);
  });

  it("replaces model-authored calculation text with the server-localized projection", () => {
    const calculation: CalculationResult = {
      id: "calc_1",
      tool: "calculate_throughput",
      formulaId: "Q=pS",
      formulaVersion: "1.0.0",
      normalizedInputs: { pressurePa: 10, speedM3S: 0.1 },
      result: { value: 1, unit: "Pa*m3/s" },
      assumptions: ["压力与抽速取同一工作点的稳态值。"],
      warnings: [],
      sourceIds: []
    };
    const candidate = {
      schemaVersion: "openvac.answer.v3",
      answerKind: "direct",
      riskLevel: "low",
      blocks: [
        {
          type: "calculation",
          calculationId: "calc_1",
          title: "calculate_throughput",
          result: "raw value=1",
          assumptions: ["normalizedInputs"],
          warnings: []
        }
      ],
      missingInputs: [],
      usedEvidenceIds: [],
      usedLinkIds: []
    };

    const localized = localizeKnownCalculationBlocks(
      candidate,
      new Map([[calculation.id, calculation]])
    );
    const serialized = JSON.stringify(localized);

    expect(serialized).toContain("气体流量计算");
    expect(serialized).toContain("计算值为 1");
    expect(serialized).not.toContain("calculate_throughput");
    expect(serialized).not.toContain("normalizedInputs");
    expect(serialized).not.toContain("pressurePa");
  });
});
