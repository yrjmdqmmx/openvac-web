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
    TIME_SENSITIVE.test(input.question) ||
    input.localEvidenceCount === 0 ||
    (input.riskLevel === "high" && input.resolvedMode === "deep")
  );
}
