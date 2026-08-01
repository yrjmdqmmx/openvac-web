export function storedProblemReportAssociations(input: {
  includeContext: boolean;
  conversationId?: string;
  messageId?: string;
}): { conversationId: string | null; messageId: string | null } {
  if (!input.includeContext) {
    return { conversationId: null, messageId: null };
  }
  return {
    conversationId: input.conversationId ?? null,
    messageId: input.messageId ?? null
  };
}
