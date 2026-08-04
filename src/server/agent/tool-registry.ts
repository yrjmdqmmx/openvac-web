import { z } from "zod";

import type {
  ResponsesFunctionTool,
  ResponsesInputItem
} from "@/server/providers";
import { collectLocalEvidence } from "@/server/chat/evidence";
import type { CalculationResult } from "@/types/chat";

import {
  calculatorSchemas,
  executeCalculator,
  type CalculatorName
} from "./calculators";
import { EvidenceRegistry, inferTrustTier } from "./evidence-registry";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_ARGUMENT_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;

const searchKnowledgeSchema = z.object({
  query: z.string().trim().min(2).max(2_000)
});
const openEvidenceSchema = z.object({
  evidenceId: z.string().regex(/^E\d+$/)
});

export type ToolExecutionResult = {
  ok: boolean;
  outputItem: ResponsesInputItem;
  evidenceIds: string[];
  calculations: CalculationResult[];
  missingInputs: string[];
};

export class ToolRegistry {
  readonly definitions: ResponsesFunctionTool[] = [
    {
      type: "function",
      name: "search_knowledge",
      description: "Search OpenVac's governed vacuum knowledge index.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: { query: { type: "string", minLength: 2, maxLength: 2000 } }
      },
      strict: true
    },
    {
      type: "function",
      name: "open_evidence_excerpt",
      description: "Read one excerpt already registered by the server.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["evidenceId"],
        properties: { evidenceId: { type: "string", pattern: "^E[0-9]+$" } }
      },
      strict: true
    },
    ...calculatorDefinitions()
  ];

  constructor(
    private readonly evidence: EvidenceRegistry,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {}

  async execute(input: {
    callId: string;
    name: string;
    arguments: string;
  }): Promise<ToolExecutionResult> {
    if (Buffer.byteLength(input.arguments, "utf8") > MAX_ARGUMENT_BYTES) {
      return this.output(input.callId, {
        ok: false,
        error: "TOOL_ARGUMENTS_TOO_LARGE"
      });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(input.arguments);
    } catch {
      return this.output(input.callId, {
        ok: false,
        error: "INVALID_TOOL_ARGUMENTS_JSON"
      });
    }

    return withTimeout(
      this.executeValidated(input.callId, input.name, raw),
      this.timeoutMs
    ).catch(() =>
      this.output(input.callId, {
        ok: false,
        error: "TOOL_TIMEOUT"
      })
    );
  }

  private async executeValidated(
    callId: string,
    name: string,
    raw: unknown
  ): Promise<ToolExecutionResult> {
    if (name === "search_knowledge") {
      const parsed = searchKnowledgeSchema.safeParse(raw);
      if (!parsed.success) return this.invalid(callId, parsed.error);
      const result = await collectLocalEvidence(parsed.data.query);
      const evidenceIds = result.evidence.flatMap((item) => {
        const inferred = inferTrustTier(item.citation.url);
        const id = this.evidence.add(item, {
          trustTier: inferred === "tier_a" ? "tier_a" : "tier_b",
          reviewStatus: item.citation.reviewStatus ?? "pending_review"
        });
        return id ? [id] : [];
      });
      return this.output(
        callId,
        {
          ok: true,
          retrievalMode: result.local.mode,
          evidence: this.evidence
            .modelIndex()
            .filter((item) => evidenceIds.includes(item.evidenceId))
        },
        evidenceIds
      );
    }
    if (name === "open_evidence_excerpt") {
      const parsed = openEvidenceSchema.safeParse(raw);
      if (!parsed.success) return this.invalid(callId, parsed.error);
      const entry = this.evidence
        .modelIndex()
        .find((item) => item.evidenceId === parsed.data.evidenceId);
      return this.output(
        callId,
        entry
          ? { ok: true, evidence: entry }
          : { ok: false, error: "UNKNOWN_EVIDENCE_ID" },
        entry ? [entry.evidenceId] : []
      );
    }
    if (isCalculatorName(name)) {
      const result = executeCalculator(name, raw);
      return result.ok
        ? this.output(
            callId,
            { ok: true, calculation: result.calculation },
            [],
            [result.calculation]
          )
        : this.output(
            callId,
            {
              ok: false,
              missingInputs: result.missingInputs,
              warnings: result.warnings
            },
            [],
            [],
            result.missingInputs
          );
    }
    return this.output(callId, { ok: false, error: "UNKNOWN_TOOL" });
  }

  private invalid(callId: string, error: z.ZodError): ToolExecutionResult {
    return this.output(callId, {
      ok: false,
      error: "INVALID_TOOL_ARGUMENTS",
      missingInputs: error.issues.map((issue) => issue.path.join("."))
    });
  }

  private output(
    callId: string,
    value: Record<string, unknown>,
    evidenceIds: string[] = [],
    calculations: CalculationResult[] = [],
    missingInputs: string[] = []
  ): ToolExecutionResult {
    let output = JSON.stringify(value);
    let ok = value.ok === true;
    if (Buffer.byteLength(output, "utf8") > MAX_RESULT_BYTES) {
      output = JSON.stringify({ ok: false, error: "TOOL_RESULT_TOO_LARGE" });
      ok = false;
    }
    return {
      ok,
      outputItem: { type: "function_call_output", call_id: callId, output },
      evidenceIds,
      calculations,
      missingInputs
    };
  }
}

function calculatorDefinitions(): ResponsesFunctionTool[] {
  const quantitySchema = {
    type: "object",
    additionalProperties: false,
    required: ["value", "unit"],
    properties: { value: { type: "number" }, unit: { type: "string" } }
  };
  const parameters: Record<CalculatorName, Record<string, unknown>> = {
    convert_vacuum_units: {
      type: "object",
      additionalProperties: false,
      required: ["quantity", "value", "fromUnit", "toUnit"],
      properties: {
        quantity: { enum: ["pressure", "pumping_speed", "throughput"] },
        value: { type: "number" },
        fromUnit: { type: "string" },
        toUnit: { type: "string" }
      }
    },
    calculate_throughput: objectSchema(["pressure", "pumpingSpeed"], {
      pressure: quantitySchema,
      pumpingSpeed: quantitySchema,
      outputUnit: { type: "string" }
    }),
    calculate_effective_pumping_speed: objectSchema(
      ["pumpSpeed", "conductance"],
      {
        pumpSpeed: quantitySchema,
        conductance: quantitySchema,
        outputUnit: { type: "string" }
      }
    ),
    estimate_pumpdown_time: objectSchema(
      ["volume", "pumpingSpeed", "initialPressure", "targetPressure"],
      {
        volume: quantitySchema,
        pumpingSpeed: quantitySchema,
        initialPressure: quantitySchema,
        targetPressure: quantitySchema,
        gasLoad: quantitySchema,
        outputUnit: { enum: ["s", "min", "h"] }
      }
    ),
    classify_flow_regime: objectSchema(
      ["meanFreePath", "characteristicLength"],
      {
        meanFreePath: quantitySchema,
        characteristicLength: quantitySchema
      }
    ),
    calculate_orifice_or_tube_conductance: objectSchema(
      ["geometry", "diameter", "regime"],
      {
        geometry: { enum: ["circular_orifice", "straight_circular_tube"] },
        diameter: quantitySchema,
        length: quantitySchema,
        regime: { enum: ["molecular", "viscous", "transition"] },
        meanPressure: quantitySchema,
        dynamicViscosityPaS: { type: "number", exclusiveMinimum: 0 },
        gas: { type: "string" },
        temperatureK: { type: "number", exclusiveMinimum: 0 },
        outputUnit: { type: "string" }
      }
    ),
    combine_parallel_pumps: objectSchema(["pumps"], {
      pumps: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: objectSchema(["speed"], {
          speed: quantitySchema,
          conductance: quantitySchema
        })
      },
      outputUnit: { type: "string" }
    }),
    estimate_leak_or_outgassing_load: objectSchema([], {
      leakRate: quantitySchema,
      outgassingRate: quantitySchema,
      surfaceArea: quantitySchema,
      outputUnit: { type: "string" }
    })
  };
  return (Object.keys(calculatorSchemas) as CalculatorName[]).map((name) => ({
    type: "function",
    name,
    description: `Run deterministic OpenVac calculation: ${name}.`,
    parameters: parameters[name],
    strict: true
  }));
}

function objectSchema(required: string[], properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required, properties };
}

function isCalculatorName(name: string): name is CalculatorName {
  return Object.prototype.hasOwnProperty.call(calculatorSchemas, name);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("tool timeout")), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
