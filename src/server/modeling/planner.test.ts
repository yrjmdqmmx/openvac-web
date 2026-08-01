import { describe, expect, it } from "vitest";

import { applyOperationBatch } from "@/lib/modeling/operations";
import { createOperationBatchFromManualState } from "@/lib/modeling/client/protocol-adapter";
import { createRotaryVanePumpTemplate } from "@/server/modeling/domain";
import type {
  ModelProvider,
  ModelStreamEvent,
  ModelStreamRequest
} from "@/server/providers/types";

import { createModelingPlan, ModelingPlannerError } from "./planner";

class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly model = "fake-model";
  lastRequest?: ModelStreamRequest;

  constructor(private readonly events: ModelStreamEvent[]) {}

  async *stream(request: ModelStreamRequest): AsyncIterable<ModelStreamEvent> {
    this.lastRequest = request;
    yield* this.events;
  }
}

describe("createModelingPlan", () => {
  it("creates a validated, hashed parameter update without executing it", async () => {
    const document = createRotaryVanePumpTemplate();
    const eccentricity = document.parameters.find(
      (parameter) => parameter.semanticRef === "pump.parameter.eccentricity"
    );
    expect(eccentricity).toBeDefined();
    const operation = {
      operationId: "44444444-4444-4444-8444-444444444444",
      kind: "update",
      collection: "parameters",
      target: {
        id: eccentricity?.id,
        semanticRef: eccentricity?.semanticRef
      },
      changes: { value: 9 }
    };
    const args = JSON.stringify({
      title: "修改偏心量",
      summary: "将偏心量改为 9 mm，并在执行前检查干涉。",
      assumptions: [],
      warnings: [],
      missingInputs: [],
      expectedChecks: ["360° 干涉检查"],
      operations: [operation]
    });
    const midpoint = Math.floor(args.length / 2);
    const provider = new FakeProvider([
      {
        type: "tool-call-delta",
        index: 0,
        name: "submit_modeling_plan",
        argumentsDelta: args.slice(0, midpoint)
      },
      {
        type: "tool-call-delta",
        index: 0,
        argumentsDelta: args.slice(midpoint)
      },
      { type: "finish", finishReason: "tool_calls" }
    ]);

    const plan = await createModelingPlan({
      document,
      baseRevisionId: document.revisionId,
      prompt: "把偏心量改成 9 毫米",
      idempotencyKey: "planner-test-1",
      provider
    });

    expect(plan.status).toBe("validated");
    expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.operationBatch?.operations).toHaveLength(6);
    expect(plan.operationBatch?.operations[0]).toMatchObject({
      kind: "update",
      collection: "parameters",
      changes: { value: 9, source: "user" }
    });
    expect(plan.operationBatch?.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "update",
          collection: "sketches",
          target: expect.objectContaining({
            semanticRef: "pump.sketch.front-cover-profile"
          })
        }),
        expect.objectContaining({
          kind: "update",
          collection: "components",
          target: expect.objectContaining({
            semanticRef: "pump.component.rotating-group"
          })
        })
      ])
    );
    const toolSchema = JSON.stringify(
      provider.lastRequest?.tools?.[0]?.parameters ?? {}
    );
    expect(toolSchema).toContain('"parameterType"');
    expect(toolSchema).toContain('"entityKind"');
    expect(toolSchema).toContain('"featureKind"');
    expect(toolSchema).not.toContain(
      "A complete strict openvac.modeling.v1 item"
    );
    expect(
      document.parameters.find((parameter) => parameter.id === eccentricity?.id)
        ?.value
    ).not.toBe(9);
  });

  it("returns needs_input without executable operations", async () => {
    const document = createRotaryVanePumpTemplate();
    const args = JSON.stringify({
      title: "需要确认尺寸",
      summary: "目标尺寸不完整。",
      assumptions: [],
      warnings: [],
      missingInputs: ["请提供目标泵腔直径（mm）。"],
      expectedChecks: [],
      operations: []
    });
    const provider = new FakeProvider([
      {
        type: "tool-call-delta",
        index: 0,
        name: "submit_modeling_plan",
        argumentsDelta: args
      },
      { type: "finish", finishReason: "tool_calls" }
    ]);

    const plan = await createModelingPlan({
      document,
      baseRevisionId: document.revisionId,
      prompt: "把泵腔改大一些",
      idempotencyKey: "planner-test-2",
      provider
    });

    expect(plan.status).toBe("needs_input");
    expect(plan.operationBatch).toBeUndefined();
    expect(plan.missingInputs).toHaveLength(1);
  });

  it("overrides a model that guessed a dimension the user did not provide", async () => {
    const document = createRotaryVanePumpTemplate();
    const eccentricity = document.parameters.find(
      (parameter) => parameter.semanticRef === "pump.parameter.eccentricity"
    )!;
    const args = JSON.stringify({
      title: "放大偏心量",
      summary: "将偏心量改成模型推测的 9 mm。",
      assumptions: [],
      warnings: [],
      missingInputs: [],
      expectedChecks: ["360° 干涉检查"],
      operations: [
        {
          operationId: "44444444-4444-4444-8444-444444444445",
          kind: "update",
          collection: "parameters",
          target: {
            id: eccentricity.id,
            semanticRef: eccentricity.semanticRef
          },
          changes: { value: 9 }
        }
      ]
    });

    const plan = await createModelingPlan({
      document,
      baseRevisionId: document.revisionId,
      prompt: "把偏心量调大一点",
      idempotencyKey: "planner-test-guess-1",
      provider: new FakeProvider([
        {
          type: "tool-call-delta",
          index: 0,
          name: "submit_modeling_plan",
          argumentsDelta: args
        },
        { type: "finish", finishReason: "tool_calls" }
      ])
    });

    expect(plan.status).toBe("needs_input");
    expect(plan.operationBatch).toBeUndefined();
    expect(plan.missingInputs.join(" ")).toContain("目标值及单位");
    expect(plan.warnings.join(" ")).toContain("已阻止执行");
  });

  it("does not let a confirmed shaft value authorize a chamber update", async () => {
    const document = createRotaryVanePumpTemplate();
    const chamberDiameter = document.parameters.find(
      (parameter) => parameter.semanticRef === "pump.parameter.chamber-diameter"
    )!;
    const args = JSON.stringify({
      title: "修改主轴直径",
      summary: "用户只确认了主轴直径，模型却把同一数值写入泵腔直径。",
      assumptions: [],
      warnings: [],
      missingInputs: [],
      expectedChecks: ["闭合实体检查"],
      operations: [
        {
          operationId: "44444444-4444-4444-8444-444444444447",
          kind: "update",
          collection: "parameters",
          target: {
            id: chamberDiameter.id,
            semanticRef: chamberDiameter.semanticRef
          },
          changes: { value: 20 }
        }
      ]
    });

    const plan = await createModelingPlan({
      document,
      baseRevisionId: document.revisionId,
      prompt: "把主轴直径改成 20 毫米",
      idempotencyKey: "planner-cross-parameter-1",
      provider: new FakeProvider([
        {
          type: "tool-call-delta",
          index: 0,
          name: "submit_modeling_plan",
          argumentsDelta: args
        },
        { type: "finish", finishReason: "tool_calls" }
      ])
    });

    expect(plan.status).toBe("needs_input");
    expect(plan.operationBatch).toBeUndefined();
    expect(plan.missingInputs.join(" ")).toContain("Chamber diameter");
  });

  it("also blocks guessed inline sketch coordinates outside parameters", async () => {
    const document = createRotaryVanePumpTemplate();
    const sketch = document.sketches.find(
      (candidate) => candidate.semanticRef === "pump.sketch.cross-section"
    )!;
    const args = JSON.stringify({
      title: "移动转子中心",
      summary: "模型自行把转子中心横坐标改为 8 mm。",
      assumptions: [],
      warnings: [],
      missingInputs: [],
      expectedChecks: ["草图约束与整周干涉"],
      operations: [
        {
          operationId: "44444444-4444-4444-8444-444444444449",
          kind: "update",
          collection: "sketches",
          target: { id: sketch.id, semanticRef: sketch.semanticRef },
          changes: {
            entities: sketch.entities.map((entity) =>
              entity.semanticRef === "pump.sketch.cross-section.rotor-center"
                ? { ...entity, x: 8 }
                : entity
            )
          }
        }
      ]
    });

    const plan = await createModelingPlan({
      document,
      baseRevisionId: document.revisionId,
      prompt: "把转子中心往右移动一些",
      idempotencyKey: "planner-inline-guess-1",
      provider: new FakeProvider([
        {
          type: "tool-call-delta",
          index: 0,
          name: "submit_modeling_plan",
          argumentsDelta: args
        },
        { type: "finish", finishReason: "tool_calls" }
      ])
    });

    expect(plan.status).toBe("needs_input");
    expect(plan.operationBatch).toBeUndefined();
    expect(plan.missingInputs.join(" ")).toContain("8 mm");
  });

  it("does not treat zero as implicitly confirmed for an inline update", async () => {
    const document = createRotaryVanePumpTemplate();
    const sketch = document.sketches.find(
      (candidate) => candidate.semanticRef === "pump.sketch.cross-section"
    )!;
    const args = JSON.stringify({
      title: "移动转子中心",
      summary: "模型自行把转子中心横坐标归零。",
      assumptions: [],
      warnings: [],
      missingInputs: [],
      expectedChecks: ["草图约束与整周干涉"],
      operations: [
        {
          operationId: "44444444-4444-4444-8444-444444444448",
          kind: "update",
          collection: "sketches",
          target: { id: sketch.id, semanticRef: sketch.semanticRef },
          changes: {
            entities: sketch.entities.map((entity) =>
              entity.semanticRef === "pump.sketch.cross-section.rotor-center"
                ? { ...entity, x: 0 }
                : entity
            )
          }
        }
      ]
    });

    const plan = await createModelingPlan({
      document,
      baseRevisionId: document.revisionId,
      prompt: "把转子中心移到基准中心",
      idempotencyKey: "planner-inline-zero-1",
      provider: new FakeProvider([
        {
          type: "tool-call-delta",
          index: 0,
          name: "submit_modeling_plan",
          argumentsDelta: args
        },
        { type: "finish", finishReason: "tool_calls" }
      ])
    });

    expect(plan.status).toBe("needs_input");
    expect(plan.operationBatch).toBeUndefined();
    expect(plan.missingInputs.join(" ")).toContain("0 mm");
  });

  it("requires a real workbench selection for a deictic target", async () => {
    const document = createRotaryVanePumpTemplate();
    const eccentricity = document.parameters.find(
      (parameter) => parameter.semanticRef === "pump.parameter.eccentricity"
    )!;
    const args = JSON.stringify({
      title: "修改所选对象",
      summary: "将所选对象的偏心量改为 9 mm。",
      assumptions: [],
      warnings: [],
      missingInputs: [],
      expectedChecks: [],
      operations: [
        {
          operationId: "44444444-4444-4444-8444-444444444446",
          kind: "update",
          collection: "parameters",
          target: {
            id: eccentricity.id,
            semanticRef: eccentricity.semanticRef
          },
          changes: { value: 9 }
        }
      ]
    });

    const plan = await createModelingPlan({
      document,
      baseRevisionId: document.revisionId,
      prompt: "把选中的对象改成 9 mm",
      idempotencyKey: "planner-test-selection-1",
      provider: new FakeProvider([
        {
          type: "tool-call-delta",
          index: 0,
          name: "submit_modeling_plan",
          argumentsDelta: args
        },
        { type: "finish", finishReason: "tool_calls" }
      ])
    });

    expect(plan.status).toBe("needs_input");
    expect(plan.operationBatch).toBeUndefined();
    expect(plan.missingInputs.join(" ")).toContain("选择目标对象");
  });

  it("preserves manual and natural-language pump semantics for the same explicit intent", async () => {
    const document = createRotaryVanePumpTemplate();
    const manualBatch = createOperationBatchFromManualState(
      document,
      [
        {
          id: "manual-eccentricity-equivalence",
          type: "set_parameter",
          parameterId: "eccentricity",
          value: 9
        }
      ],
      "manual-ai-equivalence-1"
    )!;
    const args = JSON.stringify({
      title: "修改偏心量",
      summary: "将偏心量改为 9 mm。",
      assumptions: [],
      warnings: [],
      missingInputs: [],
      expectedChecks: ["360° 干涉检查"],
      operations: manualBatch.operations
    });

    const plan = await createModelingPlan({
      document,
      baseRevisionId: document.revisionId,
      prompt: "把偏心量改成 9 mm",
      idempotencyKey: "manual-ai-equivalence-1",
      provider: new FakeProvider([
        {
          type: "tool-call-delta",
          index: 0,
          name: "submit_modeling_plan",
          argumentsDelta: args
        },
        { type: "finish", finishReason: "tool_calls" }
      ])
    });

    expect(plan.status).toBe("validated");
    const manualDocument = applyOperationBatch(document, manualBatch);
    const aiDocument = applyOperationBatch(document, plan.operationBatch!);
    expect(withoutRevisionIdentity(aiDocument)).toEqual(
      withoutRevisionIdentity(manualDocument)
    );
  });

  it("fails closed when the model emits only prose", async () => {
    const document = createRotaryVanePumpTemplate();
    const provider = new FakeProvider([
      { type: "text-delta", text: "我已经修改好了。" },
      { type: "finish", finishReason: "stop" }
    ]);

    await expect(
      createModelingPlan({
        document,
        baseRevisionId: document.revisionId,
        prompt: "修改模型",
        idempotencyKey: "planner-test-3",
        provider
      })
    ).rejects.toBeInstanceOf(ModelingPlannerError);
  });

  it("rejects a selected semantic reference outside the base revision", async () => {
    const document = createRotaryVanePumpTemplate();

    await expect(
      createModelingPlan({
        document,
        baseRevisionId: document.revisionId,
        prompt: "在选中的对象上开孔",
        idempotencyKey: "planner-test-4",
        selectedSemanticRefs: ["feature.from-another-revision"],
        provider: new FakeProvider([])
      })
    ).rejects.toThrow("不属于当前建模版本");
  });
});

function withoutRevisionIdentity(
  document: ReturnType<typeof createRotaryVanePumpTemplate>
) {
  const semanticDocument: Partial<typeof document> = { ...document };
  delete semanticDocument.revision;
  delete semanticDocument.revisionId;
  return semanticDocument;
}
