import { describe, expect, it } from "vitest";
import { ChatStreamProtocolError, parseChatEventStream } from "@/lib/sse";

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

  it("rejects a truncated stream that never sends complete", async () => {
    const response = streamResponse([
      'data: {"type":"delta","text":"未完成"}\n\n'
    ]);

    await expect(collectEvents(response)).rejects.toBeInstanceOf(
      ChatStreamProtocolError
    );
    await expect(
      collectEvents(
        streamResponse(['data: {"type":"delta","text":"未完成"}\n\n'])
      )
    ).rejects.toThrow("未收到完整的回答");
  });

  it("rejects duplicate complete events", async () => {
    const complete =
      'data: {"type":"complete","conversationId":"c1","messageId":"m1","meta":{"riskLevel":"low","missingInputs":[],"webSearched":false,"citations":[]}}\n\n';

    await expect(
      collectEvents(streamResponse([complete, complete]))
    ).rejects.toThrow("重复发送");
  });

  it("rejects data sent after the single complete event", async () => {
    const complete =
      'data: {"type":"complete","conversationId":"c1","messageId":"m1","meta":{"riskLevel":"low","missingInputs":[],"webSearched":false,"citations":[]}}\n\n';

    await expect(
      collectEvents(
        streamResponse([complete, 'data: {"type":"delta","text":"late"}\n\n'])
      )
    ).rejects.toThrow("完成后继续发送");
  });

  it("accepts V2 terminal events and drops duplicate or backwards sequences", async () => {
    const events = await collectEvents(
      streamResponse([
        'data: {"type":"run.accepted","runId":"r1","sequence":1,"turnId":"t1","conversationId":"c1","messageId":"m1","answerVersion":1}\n\n',
        'data: {"type":"stage.changed","runId":"r1","sequence":2,"stage":"analyzing","label":"分析"}\n\n',
        'data: {"type":"stage.changed","runId":"r1","sequence":2,"stage":"searching","label":"重复"}\n\n',
        'data: {"type":"stage.changed","runId":"r1","sequence":1,"stage":"searching","label":"乱序"}\n\n',
        'data: {"type":"run.failed","runId":"r1","sequence":3,"code":"FAILED","message":"失败","retryable":true,"suggestedAction":"retry","charged":false}\n\n'
      ])
    );

    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ sequence: 2, label: "分析" });
    expect(events[2]).toMatchObject({ type: "run.failed", sequence: 3 });
  });

  it("rejects a truncated V2 stream without a semantic terminal event", async () => {
    await expect(
      collectEvents(
        streamResponse([
          'data: {"type":"run.accepted","runId":"r1","sequence":1,"turnId":"t1","conversationId":"c1","messageId":"m1","answerVersion":1}\n\n'
        ])
      )
    ).rejects.toThrow("未收到完整的回答");
  });
});

function streamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    })
  );
}

async function collectEvents(response: Response) {
  const events = [];
  for await (const event of parseChatEventStream(response)) events.push(event);
  return events;
}
