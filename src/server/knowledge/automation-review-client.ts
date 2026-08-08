import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  automationReviewReportSchema,
  knowledgeSha256Schema,
  type AutomationReviewReport
} from "./automation-review-schema";

const phaseSchema = z.enum(["initial", "verify"]);
const claimSchema = z
  .object({
    id: z.uuid(),
    phase: phaseSchema,
    inputVersionId: z.uuid(),
    inputContentHash: knowledgeSha256Schema,
    model: z.literal("gpt-5.5-codex"),
    attempts: z.number().int().min(1),
    leaseExpiresAt: z.string().min(1),
    leaseToken: z.string().min(20).max(1_000)
  })
  .strict();

const originalSchema = z
  .object({
    originalFilename: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().positive(),
    sha256: knowledgeSha256Schema,
    downloadUrl: z.url()
  })
  .strict();

const packageSchema = z
  .object({
    id: z.uuid(),
    phase: phaseSchema,
    inputVersionId: z.uuid(),
    inputContentHash: knowledgeSha256Schema,
    content: z.string(),
    citationMetadata: z.record(z.string(), z.unknown()),
    versionMetadata: z.record(z.string(), z.unknown()),
    source: z.record(z.string(), z.unknown()).nullable(),
    original: originalSchema.nullable()
  })
  .strict();

const outcomeSchema = z
  .object({
    runId: z.uuid(),
    status: z.enum(["completed", "needs_human", "failed"]),
    decision: z.enum(["approved", "rejected", "needs_human"]),
    currentVersionId: z.uuid(),
    queuedPhase: z.enum(["verify", "embedding"]).nullable(),
    idempotent: z.boolean()
  })
  .strict();

const submissionSchema = z
  .object({
    report: automationReviewReportSchema,
    revisedContent: z.string().trim().min(1).max(5_000_000).optional()
  })
  .strict();

const jobSchema = z
  .object({ claim: claimSchema, package: packageSchema })
  .strict()
  .superRefine((value, context) => {
    for (const field of [
      "id",
      "phase",
      "inputVersionId",
      "inputContentHash"
    ] as const) {
      if (value.claim[field] !== value.package[field]) {
        context.addIssue({
          code: "custom",
          message: `Claim and package ${field} do not match.`
        });
      }
    }
  });

export type KnowledgeReviewClaim = z.infer<typeof claimSchema>;
export type KnowledgeReviewPackage = z.infer<typeof packageSchema>;
export type KnowledgeReviewSubmission = {
  report: AutomationReviewReport;
  revisedContent?: string;
};

type Fetch = typeof globalThis.fetch;

export class KnowledgeReviewAutomationClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetch: Fetch;

  constructor(input: { baseUrl: string; token: string; fetch?: Fetch }) {
    const parsed = z
      .object({ baseUrl: z.url(), token: z.string().min(1) })
      .parse({ baseUrl: input.baseUrl, token: input.token });
    const baseUrl = new URL(parsed.baseUrl);
    if (!["http:", "https:"].includes(baseUrl.protocol)) {
      throw new Error("OPENVAC_BASE_URL must use HTTP or HTTPS.");
    }
    this.baseUrl = baseUrl.toString().replace(/\/$/u, "");
    this.token = parsed.token;
    this.fetch = input.fetch ?? globalThis.fetch;
  }

  async claim(phase: "initial" | "verify", max = 10) {
    const input = z
      .object({ phase: phaseSchema, max: z.number().int().min(1).max(10) })
      .parse({ phase, max });
    const response = await this.request(
      "/api/internal/knowledge-review/claims",
      {
        method: "POST",
        body: JSON.stringify(input)
      }
    );
    return z
      .object({ data: z.object({ claims: z.array(claimSchema) }).strict() })
      .strict()
      .parse(await response.json()).data.claims;
  }

  async getPackage(claim: KnowledgeReviewClaim) {
    const parsed = claimSchema.parse(claim);
    const response = await this.request(
      `/api/internal/knowledge-review/jobs/${parsed.id}/package?phase=${parsed.phase}`,
      {
        method: "GET",
        headers: { "x-knowledge-review-lease": parsed.leaseToken }
      }
    );
    return z
      .object({ data: packageSchema })
      .strict()
      .parse(await response.json()).data;
  }

  async submit(
    claim: KnowledgeReviewClaim,
    submission: KnowledgeReviewSubmission
  ) {
    const parsedClaim = claimSchema.parse(claim);
    const parsedSubmission = submissionSchema.parse(submission);
    if (
      parsedClaim.phase === "verify" &&
      parsedSubmission.revisedContent !== undefined
    ) {
      throw new Error("Verification runs cannot revise content.");
    }
    const response = await this.request(
      `/api/internal/knowledge-review/jobs/${parsedClaim.id}/result`,
      {
        method: "POST",
        body: JSON.stringify({
          phase: parsedClaim.phase,
          leaseToken: parsedClaim.leaseToken,
          inputVersionId: parsedClaim.inputVersionId,
          inputContentHash: parsedClaim.inputContentHash,
          ...parsedSubmission
        })
      }
    );
    return z
      .object({ data: outcomeSchema })
      .strict()
      .parse(await response.json()).data;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    headers.set("accept", "application/json");
    if (init.body !== undefined)
      headers.set("content-type", "application/json");
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers
    });
    if (response.ok) return response;

    let code = `HTTP_${response.status}`;
    let message = response.statusText || "Knowledge review request failed.";
    try {
      const payload = z
        .object({
          error: z
            .object({ code: z.string(), message: z.string() })
            .passthrough()
        })
        .passthrough()
        .parse(await response.json());
      code = payload.error.code;
      message = payload.error.message;
    } catch {
      // Use the status-only fallback without logging a response body.
    }
    throw new Error(`${code}: ${message.replaceAll(this.token, "[REDACTED]")}`);
  }
}

export function createKnowledgeReviewAutomationClientFromEnv(
  env: NodeJS.ProcessEnv = process.env
): KnowledgeReviewAutomationClient {
  return new KnowledgeReviewAutomationClient({
    baseUrl: requiredEnv(env, "OPENVAC_BASE_URL"),
    token: requiredEnv(env, "OPENVAC_KNOWLEDGE_REVIEW_TOKEN")
  });
}

export async function writeKnowledgeReviewJob(
  directory: string,
  input: { claim: KnowledgeReviewClaim; package: KnowledgeReviewPackage }
): Promise<string> {
  const job = jobSchema.parse(input);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, `${job.claim.phase}-${job.claim.id}.json`);
  await writeFile(path, `${JSON.stringify(job, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(path, 0o600);
  return path;
}

export function parseKnowledgeReviewJob(input: unknown) {
  return jobSchema.parse(input);
}

export function parseKnowledgeReviewSubmission(input: unknown) {
  return submissionSchema.parse(input);
}

export type KnowledgeReviewRunnerArgs =
  | {
      command: "claim";
      phase: "initial" | "verify";
      max: number;
      stateDir: string;
    }
  | { command: "submit"; jobPath: string; reportPath: string };

export function parseKnowledgeReviewRunnerArgs(
  argv: string[]
): KnowledgeReviewRunnerArgs {
  const [command, ...rest] = argv;
  if (command === "claim") {
    let phase: "initial" | "verify" = "initial";
    let max = 10;
    let stateDir = ".openvac/knowledge-review";
    for (let index = 0; index < rest.length; index += 2) {
      const option = rest[index];
      const value = rest[index + 1];
      if (!value) throw new Error(`Missing value for ${option ?? "option"}.`);
      if (option === "--phase") phase = phaseSchema.parse(value);
      else if (option === "--max")
        max = z.coerce.number().int().min(1).max(10).parse(value);
      else if (option === "--state-dir") stateDir = value;
      else throw new Error(`Unknown argument: ${option}`);
    }
    return { command, phase, max, stateDir };
  }
  if (command === "submit") {
    let jobPath: string | undefined;
    let reportPath: string | undefined;
    for (let index = 0; index < rest.length; index += 2) {
      const option = rest[index];
      const value = rest[index + 1];
      if (!value) throw new Error(`Missing value for ${option ?? "option"}.`);
      if (option === "--job") jobPath = value;
      else if (option === "--report") reportPath = value;
      else throw new Error(`Unknown argument: ${option}`);
    }
    if (!jobPath || !reportPath) {
      throw new Error("submit requires --job and --report.");
    }
    return { command, jobPath, reportPath };
  }
  throw new Error("Expected claim or submit command.");
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
