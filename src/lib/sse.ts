import type { ChatStreamEvent } from "@/types/chat";

export async function* parseChatEventStream(
  response: Response
): AsyncGenerator<ChatStreamEvent> {
  if (!response.body) {
    throw new Error("服务器没有返回流式响应。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
        yield JSON.parse(data) as ChatStreamEvent;
      }
      boundary = buffer.indexOf("\n\n");
    }

    if (done) break;
  }
}
