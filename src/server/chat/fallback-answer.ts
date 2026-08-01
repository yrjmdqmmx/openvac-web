import type { RiskAssessment } from "@/server/agent";

const GREETING = /^(?:你好|您好|嗨|hi|hello|在吗)[!！?？。,.，\s]*$/iu;

export function buildNoEvidenceAnswer(input: {
  question: string;
  risk: RiskAssessment;
}) {
  const greeting = GREETING.test(input.question.trim());
  const highRisk = input.risk.level === "high";

  const conclusion = greeting
    ? "你好，我是 OpenVac 真空泵专家。你可以直接描述选泵、工况、故障或配件识别问题。"
    : highRisk
      ? "当前没有可核验的直接证据，且问题涉及高风险工况。请先停机并隔离能源，暂不要继续运行或拆修；请联系设备制造商、本单位安全负责人或具备资质的现场人员。"
      : "当前知识库没有检索到足以支持确定结论的直接证据。我可以继续帮你梳理问题，但需要先补充设备与工况信息。";

  return [
    "## 结论",
    conclusion,
    "",
    "## 采用的条件/假设",
    greeting
      ? "本条消息按问候处理，尚未假设任何设备型号或运行工况。"
      : "未假设具体品牌、型号、介质、压力、温度或现场安全条件。",
    "",
    "## 依据与来源",
    "暂无可核验的直接证据，本轮不引用外部资料，也不据此给出确定性工程参数。",
    "",
    "## 仍缺少的信息",
    greeting
      ? "请说明你想咨询的真空泵型号、应用场景或故障现象。"
      : "请补充泵的准确型号、抽取介质、入口与目标压力、目标或实测抽速，以及温度和运行时间。",
    "",
    "## 建议下一步",
    highRisk
      ? input.risk.safetyDirective ||
        "保持停机并隔离能源，记录现场信息后联系合格人员确认。"
      : "把铭牌型号和当前工况发给我。若现场存在人身、火灾、爆炸或介质泄漏风险，请立即按本单位应急程序处理；问题反馈不是紧急支持渠道。"
  ].join("\n");
}
