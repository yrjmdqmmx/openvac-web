import type { ChatStreamEvent } from "@/types/chat";

export class ChatStreamProtocolError extends Error {
  readonly code = "CHAT_STREAM_PROTOCOL_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ChatStreamProtocolError";
  }
}

export async function* parseChatEventStream(
  response: Response
): AsyncGenerator<ChatStreamEvent> {
  if (!response.body) {
    throw new Error("服务器没有返回流式响应。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completeSeen = false;
  let protocol: 1 | 2 | undefined;
  let lastSequence = 0;
  let reachedEof = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");

        if (data && data !== "[DONE]") {
          const event = JSON.parse(data) as ChatStreamEvent;
          const isV2 = "runId" in event && "sequence" in event;
          if (protocol === undefined) protocol = isV2 ? 2 : 1;
          if ((protocol === 2) !== isV2) {
            throw new ChatStreamProtocolError(
              "服务器在同一回答中混用了协议版本，请刷新对话历史。"
            );
          }
          if (isV2) {
            if (
              !Number.isSafeInteger(event.sequence) ||
              event.sequence <= lastSequence
            ) {
              boundary = buffer.indexOf("\n\n");
              continue;
            }
            lastSequence = event.sequence;
          }
          const terminal =
            event.type === "complete" ||
            event.type === "run.completed" ||
            event.type === "run.cancelled" ||
            event.type === "run.failed";
          if (terminal) {
            if (completeSeen) {
              throw new ChatStreamProtocolError(
                "服务器重复发送了回答完成标记，请刷新对话历史。"
              );
            }
            completeSeen = true;
          } else if (completeSeen) {
            throw new ChatStreamProtocolError(
              "服务器在回答完成后继续发送了数据，请刷新对话历史。"
            );
          }
          yield event;
        }
        boundary = buffer.indexOf("\n\n");
      }

      if (done) {
        reachedEof = true;
        break;
      }
    }

    if (!completeSeen) {
      throw new ChatStreamProtocolError(
        "连接中断，未收到完整的回答。请刷新对话历史后重试。"
      );
    }
  } finally {
    if (!reachedEof) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
