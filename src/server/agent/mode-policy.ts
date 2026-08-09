import type {
  RequestedAgentMode,
  ResolvedAgentMode,
  RiskLevel,
  WebMode
} from "@/types/chat";

const TIME_SENSITIVE =
  /(?:最新|目前|现在|当前|今天|近期|价格|库存|停产|在售|新型号|新版|公告|法规更新)/u;
const COMPLEX =
  /(?:计算|估算|比较|选型|方案|故障|异常|联锁|漏率|放气|抽空时间|导流|为什么).{0,80}(?:并且|同时|以及|然后|如何|多少)?/u;

export type AgentRunBudgetProfile = {
  timeoutEnvironmentName: "AGENT_AUTO_TIMEOUT_MS" | "AGENT_DEEP_TIMEOUT_MS";
  timeoutFallbackMs: 120_000 | 180_000;
  maxToolRounds: 1 | 3;
  inputTokenBudget: 65_536 | 131_072;
  outputTokenEnvironmentName:
    "AGENT_AUTO_MAX_OUTPUT_TOKENS" | "AGENT_DEEP_MAX_OUTPUT_TOKENS";
  outputTokenFallback: 4_096 | 8_192;
};

export function resolveAgentMode(input: {
  requested: RequestedAgentMode;
  question: string;
  riskLevel: RiskLevel;
}): ResolvedAgentMode {
  if (input.requested === "deep") return "deep";
  if (input.riskLevel !== "low" || COMPLEX.test(input.question)) return "deep";
  return "fast";
}

export function shouldUseWeb(input: {
  webMode: WebMode;
  question: string;
  riskLevel: RiskLevel;
  localEvidenceCount: number;
  resolvedMode: ResolvedAgentMode;
}): boolean {
  if (input.webMode === "always") return true;
  return (
    requiresFreshWebEvidence(input.question) ||
    input.localEvidenceCount === 0 ||
    (input.riskLevel === "high" && input.resolvedMode === "deep")
  );
}

export function requiresFreshWebEvidence(question: string): boolean {
  return TIME_SENSITIVE.test(question.normalize("NFKC"));
}

export function agentRunBudgetProfile(
  requestedMode: RequestedAgentMode
): AgentRunBudgetProfile {
  if (requestedMode === "deep") {
    return {
      timeoutEnvironmentName: "AGENT_DEEP_TIMEOUT_MS",
      timeoutFallbackMs: 180_000,
      maxToolRounds: 3,
      inputTokenBudget: 131_072,
      outputTokenEnvironmentName: "AGENT_DEEP_MAX_OUTPUT_TOKENS",
      outputTokenFallback: 8_192
    };
  }
  return {
    timeoutEnvironmentName: "AGENT_AUTO_TIMEOUT_MS",
    timeoutFallbackMs: 120_000,
    maxToolRounds: 1,
    inputTokenBudget: 65_536,
    outputTokenEnvironmentName: "AGENT_AUTO_MAX_OUTPUT_TOKENS",
    outputTokenFallback: 4_096
  };
}

export function effectiveAgentRunTimeoutMs(
  mode: RequestedAgentMode | ResolvedAgentMode,
  environment: Record<string, string | undefined> = process.env
): number {
  const profile = agentRunBudgetProfile(mode === "deep" ? "deep" : "auto");
  const configured = Number.parseInt(
    environment[profile.timeoutEnvironmentName] ?? "",
    10
  );
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    return profile.timeoutFallbackMs;
  }
  return Math.max(configured, profile.timeoutFallbackMs);
}
