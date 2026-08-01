import { describe, expect, it } from "vitest";

import { storedProblemReportAssociations } from "./context-policy";

describe("problem report context persistence policy", () => {
  it("drops request association IDs unless context sharing is explicit", () => {
    expect(
      storedProblemReportAssociations({
        includeContext: false,
        conversationId: "conversation-1",
        messageId: "message-1"
      })
    ).toEqual({ conversationId: null, messageId: null });
  });

  it("keeps association IDs only when context sharing is enabled", () => {
    expect(
      storedProblemReportAssociations({
        includeContext: true,
        conversationId: "conversation-1",
        messageId: "message-1"
      })
    ).toEqual({
      conversationId: "conversation-1",
      messageId: "message-1"
    });
  });
});
