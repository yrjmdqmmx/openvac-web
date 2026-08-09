import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/types/chat";
import { reconcileChatMessages } from "./chat-version-reconciliation";

function version(
  id: string,
  answerVersion: number,
  status: ChatMessage["status"],
  content: string
): ChatMessage {
  return {
    id,
    role: "assistant",
    content,
    status,
    meta: {
      riskLevel: "low",
      missingInputs: [],
      webSearched: false,
      citations: [],
      turnId: "turn-a",
      answerVersion
    }
  };
}

describe("reconcileChatMessages", () => {
  it("keeps only the strongest record when a skeleton and answer share a version", () => {
    const skeleton = version("skeleton", 2, "streaming", "");
    const completed = version("completed", 2, "completed", "最终回答");
    const result = reconcileChatMessages([skeleton, completed], {});

    expect(result.visibleMessages).toEqual([completed]);
    expect(result.turns.get("turn-a")?.historicalVersions).toEqual([]);
  });

  it("folds old failed and incomplete versions while keeping completed versions selectable", () => {
    const failed = version("failed", 1, "error", "失败内容");
    const incomplete = version("incomplete", 2, "incomplete", "未完成内容");
    const completed = version("completed", 3, "completed", "最终回答");
    const result = reconcileChatMessages([failed, incomplete, completed], {});

    expect(result.visibleMessages).toEqual([completed]);
    expect(result.turns.get("turn-a")).toMatchObject({
      selectableVersions: [3],
      historicalVersions: [failed, incomplete]
    });
  });

  it("honors an explicitly selected completed version", () => {
    const first = version("first", 1, "completed", "第一版");
    const second = version("second", 2, "completed", "第二版");
    const result = reconcileChatMessages([first, second], { "turn-a": 1 });

    expect(result.visibleMessages).toEqual([first]);
    expect(result.turns.get("turn-a")?.selectableVersions).toEqual([1, 2]);
  });
});
