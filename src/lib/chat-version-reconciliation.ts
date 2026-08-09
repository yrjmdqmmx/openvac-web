import type { ChatMessage } from "@/types/chat";

export type ReconciledTurn = {
  selected: ChatMessage;
  selectableVersions: number[];
  historicalVersions: ChatMessage[];
};

export function reconcileChatMessages(
  messages: ChatMessage[],
  selectedVersionByTurn: Record<string, number>
): { visibleMessages: ChatMessage[]; turns: Map<string, ReconciledTurn> } {
  const grouped = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const turnId = versionedTurnId(message);
    if (!turnId) continue;
    grouped.set(turnId, [...(grouped.get(turnId) ?? []), message]);
  }

  const turns = new Map<string, ReconciledTurn>();
  const selectedMessages = new Set<ChatMessage>();
  for (const [turnId, candidates] of grouped) {
    const canonicalByVersion = new Map<number, ChatMessage>();
    for (const candidate of candidates) {
      const version = candidate.meta?.answerVersion;
      if (version === undefined) continue;
      const current = canonicalByVersion.get(version);
      if (!current || messageQuality(candidate) > messageQuality(current)) {
        canonicalByVersion.set(version, candidate);
      }
    }
    const versions = [...canonicalByVersion.keys()].sort(
      (left, right) => left - right
    );
    const requestedVersion = selectedVersionByTurn[turnId];
    const selected =
      (requestedVersion !== undefined
        ? canonicalByVersion.get(requestedVersion)
        : undefined) ?? canonicalByVersion.get(versions.at(-1) ?? -1);
    if (!selected) continue;
    selectedMessages.add(selected);
    turns.set(turnId, {
      selected,
      selectableVersions: versions.filter(
        (version) => canonicalByVersion.get(version)?.status === "completed"
      ),
      historicalVersions: versions
        .map((version) => canonicalByVersion.get(version))
        .filter((message): message is ChatMessage => message !== undefined)
        .filter(
          (message) => message !== selected && message.status !== "completed"
        )
    });
  }

  return {
    visibleMessages: messages.filter((message) => {
      const turnId = versionedTurnId(message);
      return !turnId || selectedMessages.has(message);
    }),
    turns
  };
}

function versionedTurnId(message: ChatMessage) {
  return message.role === "assistant" &&
    message.meta?.turnId &&
    message.meta.answerVersion !== undefined
    ? message.meta.turnId
    : undefined;
}

function messageQuality(message: ChatMessage) {
  const statusScore = {
    streaming: 0,
    error: 1,
    incomplete: 2,
    completed: 3
  }[message.status ?? "streaming"];
  const answerScore = message.meta?.answerV3
    ? 4
    : message.meta?.answer
      ? 3
      : message.meta?.answerBlocks?.length
        ? 2
        : message.content
          ? 1
          : 0;
  return statusScore * 10 + answerScore;
}
