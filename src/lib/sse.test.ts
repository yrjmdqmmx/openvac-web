import { describe, expect, it } from "vitest";
import { parseChatEventStream } from "@/lib/sse";

describe("parseChatEventStream", () => {
  it("parses events split across chunks", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"type":"delta","text":"真')
          );
          controller.enqueue(encoder.encode('空"}\n\n'));
          controller.enqueue(
            encoder.encode(
              'event: complete\ndata: {"type":"complete","conversationId":"c1","messageId":"m1","meta":{"riskLevel":"low","missingInputs":[],"webSearched":false,"citations":[]}}\n\n'
            )
          );
          controller.close();
        }
      })
    );

    const events = [];
    for await (const event of parseChatEventStream(response)) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "delta", text: "真空" });
  });
});
