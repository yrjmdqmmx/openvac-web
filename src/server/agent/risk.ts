export type RiskLevel = "low" | "medium" | "high";

export type HighRiskHazard =
  | "oxygen"
  | "flammable_or_explosive"
  | "toxic"
  | "corrosive"
  | "high_temperature"
  | "electrical_repair"
  | "interlock_bypass";

export interface RiskAssessment {
  level: RiskLevel;
  hazards: HighRiskHazard[];
  requiresExternalProfessional: boolean;
  safetyDirective?: string;
}

const HIGH_RISK_PATTERNS: Array<{
  hazard: HighRiskHazard;
  pattern: RegExp;
}> = [
  {
    hazard: "oxygen",
    pattern: /(?:氧气|富氧|液氧|制氧|\bO2\b|\boxygen\b)/iu
  },
  {
    hazard: "flammable_or_explosive",
    pattern:
      /(?:易燃|可燃|爆炸性|爆炸极限|氢气|甲烷|乙炔|丙烷|汽油蒸气|溶剂蒸气|\bflammable\b|\bexplosive\b|\bhydrogen\b|\bmethane\b)/iu
  },
  {
    hazard: "toxic",
    pattern:
      /(?:有毒|毒性|硫化氢|氯气|一氧化碳|氨气|光气|砷化氢|\btoxic\b|\bpoisonous\b)/iu
  },
  {
    hazard: "corrosive",
    pattern:
      /(?:腐蚀性|强酸|强碱|盐酸|硫酸|硝酸|氢氟酸|氟气|氯化氢|\bcorrosive\b|\bstrong acid\b|\bstrong alkali\b)/iu
  },
  {
    hazard: "high_temperature",
    pattern:
      /(?:高温|过热|灼热|热油|烫伤|\bhigh[- ]temperature\b|\boverheat(?:ed|ing)?\b|(?:[89]\d|[1-9]\d{2,})\s*°?\s*[Cc℃])/iu
  },
  {
    hazard: "electrical_repair",
    pattern:
      /(?:带电(?:拆|修|测|接)|电气(?:拆修|维修|检修|接线)|拆(?:配电|变频器)|短接电源|强制送电|(?:电机|控制柜|配电柜|变频器|电源|线路|端子).{0,12}(?:拆修|维修|检修|拆线|接线)|(?:拆修|维修|检修|拆线|接线).{0,12}(?:电机|控制柜|配电柜|变频器|电源|线路|端子)|(?:绝缘电阻|兆欧表|摇表).{0,12}(?:测量|测试|检测|怎么测|如何测)|(?:测量|测试|检测|怎么测|如何测).{0,12}(?:绝缘电阻|兆欧表|摇表)|(?:启动电容|运行电容|电容器|电气(?:部件|元件)|断路器|空气开关|空开|熔断器|保险丝|接触器|热继电器|继电器).{0,12}(?:更换|替换|拆换|拆装|检修|维修|测量|测试|排查|复位)|(?:更换|替换|拆换|拆装|检修|维修|测量|测试|排查|复位).{0,12}(?:启动电容|运行电容|电容器|电气(?:部件|元件)|断路器|空气开关|空开|熔断器|保险丝|接触器|热继电器|继电器)|(?:断路器|空气开关|空开).{0,12}(?:跳闸|脱扣)|(?:跳闸|脱扣).{0,12}(?:怎么|如何|排查|检修|维修|复位)|(?:漏电|触电).{0,12}(?:怎么|如何|维修|检修|排查|修)|(?:怎么|如何|维修|检修|排查|修).{0,12}(?:漏电|触电)|\blive electrical (?:repair|work)\b|\benergized (?:repair|work)\b|\b(?:motor|control (?:cabinet|panel)|inverter|power supply|wiring|terminal).{0,24}(?:repair|service|rewir(?:e|ing)|disconnect|connect)\b|\b(?:repair|service|rewir(?:e|ing)|disconnect|connect).{0,24}(?:motor|control (?:cabinet|panel)|inverter|power supply|wiring|terminal)\b|\b(?:insulation resistance|megohmmeter|megger).{0,24}(?:measure|test|check|inspect)\b|\b(?:measure|test|check|inspect).{0,24}(?:insulation resistance|megohmmeter|megger)\b|\b(?:(?:start|starting|run|running) capacitor|electrical component|circuit breaker|breaker|fuse|contactor|thermal overload relay|relay).{0,24}(?:replace|change|service|repair|measure|test|troubleshoot|reset)\b|\b(?:replace|change|service|repair|measure|test|troubleshoot|reset).{0,24}(?:(?:start|starting|run|running) capacitor|electrical component|circuit breaker|breaker|fuse|contactor|thermal overload relay|relay)\b|\b(?:circuit breaker|breaker).{0,24}(?:trip|tripping|reset|troubleshoot)\b|\b(?:trip|tripping).{0,24}(?:circuit breaker|breaker)\b|\b(?:electric shock|ground fault|earth leakage).{0,24}(?:repair|fix|troubleshoot)\b|\b(?:repair|fix|troubleshoot).{0,24}(?:electric shock|ground fault|earth leakage)\b)/iu
  },
  {
    hazard: "interlock_bypass",
    pattern:
      /(?:(?:绕过|旁路|屏蔽|短接|跨接|取消|解除|拆掉|拔掉|断开|直连|直通|接死|跳线(?:跨接)?|直接(?:连|接)(?:通|起来)?).{0,12}(?:联锁|互锁|保护|急停(?:回路|开关|触点)?|安全(?:回路|开关|联锁))|(?:联锁|互锁|保护|急停(?:回路|开关|触点)?|安全(?:回路|开关|联锁)).{0,12}(?:绕过|旁路|屏蔽|短接|跨接|取消|解除|拆掉|拔掉|断开|直连|直通|接死|跳线(?:跨接)?|直接(?:连|接)(?:通|起来)?)|\b(?:bypass|disable|override|jumper|jump|bridge|shunt|defeat|hotwire|circumvent|disconnect|remove|short(?:-circuit)?(?:\s+out)?|wire\s+around|cut\s+out|hard-?wire)\b.{0,32}\b(?:interlock|safety(?:\s+(?:interlock|circuit|switch))?|emergency[-\s]?stop|e[-\s]?stop)\b|\b(?:interlock|safety(?:\s+(?:interlock|circuit|switch))?|emergency[-\s]?stop|e[-\s]?stop)\b.{0,32}\b(?:bypass|disable|override|jumper|jump|bridge|shunt|defeat|hotwire|circumvent|disconnect|remove|short(?:-circuit)?(?:\s+out)?|wire\s+around|cut\s+out|hard-?wire)\b)/iu
  }
];

const ENGINEERING_PATTERN =
  /(?:选型|选泵|抽速|抽空时间|抽气时间|流导|极限压力|工作压力|气体负载|泄漏率|方案|型号|配件|维修|故障|异响|返油|温升|\bpump(?:\s|-)?down\s+time\b)/iu;

const SAFETY_COMPONENT_PATTERN =
  /(?:联锁|互锁|急停(?:回路|开关|触点|继电器)?|安全(?:回路|开关|联锁|触点|继电器)|\b(?:interlock|safety(?:\s+(?:interlock|circuit|switch|relay|contacts?))?|emergency[-\s]?stop(?:\s+(?:circuit|switch|relay|contacts?))?|e[-\s]?stop(?:\s+(?:circuit|switch|relay|contacts?))?)\b)/iu;

const EXPLICIT_SAFETY_INSPECTION_PATTERN =
  /(?:检查|检测|检验|排查|状态|报警|告警|故障诊断|是否正常|(?:按|对照).{0,8}(?:手册|说明书)|\b(?:inspect(?:ion)?|check(?:ing)?|status|alarm|troubleshoot(?:ing)?|diagnos(?:e|is|tic)|verify|test(?:ing)?|manual)\b)/iu;

const DANGEROUS_SAFETY_ACTION_PATTERN =
  /(?:绕过|旁路|屏蔽|短接|跨接|取消|解除|拆掉|拔掉|断开|直连|直通|接死|跳线|直接(?:连|接)|强制.{0,8}(?:闭合|吸合|接通|保持)|保持.{0,8}(?:闭合|吸合|接通)|\b(?:bypass|disable|override|jumper|jump|bridge|shunt|defeat|hotwire|circumvent|disconnect|remove|short(?:-circuit)?(?:\s+out)?|wire\s+around|cut\s+out|hard-?wire|forc(?:e|ing).{0,16}(?:closed|on|energized|engaged))\b)/iu;

const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const UNSAFE_CONTROL = /\p{Cc}/gu;
const SIMPLE_INNER_SEPARATOR = /[\s:：._/\\\-‐-―·•]+/u;
const HAN_INNER_SEPARATOR =
  /(?<=\p{Script=Han})[\s:：._/\\\-‐-―·•]+(?=\p{Script=Han})/gu;

const ASCII_RISK_TOKEN_NORMALIZERS: Array<[RegExp, string]> = [
  [
    new RegExp(String.raw`\bby${SIMPLE_INNER_SEPARATOR.source}pass\b`, "giu"),
    "bypass"
  ],
  [
    new RegExp(
      String.raw`\binter${SIMPLE_INNER_SEPARATOR.source}lock\b`,
      "giu"
    ),
    "interlock"
  ],
  [
    new RegExp(String.raw`\be${SIMPLE_INNER_SEPARATOR.source}stop\b`, "giu"),
    "e-stop"
  ],
  [
    new RegExp(String.raw`\bre${SIMPLE_INNER_SEPARATOR.source}wire\b`, "giu"),
    "rewire"
  ],
  [
    new RegExp(String.raw`\bhot${SIMPLE_INNER_SEPARATOR.source}wire\b`, "giu"),
    "hotwire"
  ],
  [
    new RegExp(String.raw`\bhard${SIMPLE_INNER_SEPARATOR.source}wire\b`, "giu"),
    "hardwire"
  ],
  [
    new RegExp(
      String.raw`\ben${SIMPLE_INNER_SEPARATOR.source}ergized\b`,
      "giu"
    ),
    "energized"
  ]
];

export function classifyVacuumRisk(question: string): RiskAssessment {
  const normalized = normalizeRiskQuestion(question);
  const separatorNormalized = normalizeRiskTokenSeparators(normalized);
  const matchable = [
    ...new Set([
      normalized,
      normalized.replace(/\s+/gu, ""),
      separatorNormalized,
      separatorNormalized.replace(/\s+/gu, "")
    ])
  ];
  const hazards = HIGH_RISK_PATTERNS.filter(({ pattern }) =>
    matchable.some((value) => pattern.test(value))
  ).map(({ hazard }) => hazard);
  const mentionsSafetyComponent = matchable.some((value) =>
    SAFETY_COMPONENT_PATTERN.test(value)
  );
  const isExplicitInspection = matchable.some((value) =>
    EXPLICIT_SAFETY_INSPECTION_PATTERN.test(value)
  );
  const containsDangerousAction = matchable.some((value) =>
    DANGEROUS_SAFETY_ACTION_PATTERN.test(value)
  );

  if (
    mentionsSafetyComponent &&
    (!isExplicitInspection || containsDangerousAction) &&
    !hazards.includes("interlock_bypass")
  ) {
    hazards.push("interlock_bypass");
  }

  if (hazards.length > 0) {
    return {
      level: "high",
      hazards,
      requiresExternalProfessional: true,
      safetyDirective:
        "只提供安全级停机、隔离能源、通风/泄压和按厂家程序检查的建议；不得指导带电拆修、绕过联锁或在介质与工况不明时继续运行。必须索取设备型号、介质、压力、温度和现场安全条件，并要求联系设备制造商、本单位安全负责人或具备资质的现场人员。问题反馈不是紧急支持渠道。"
    };
  }

  if (matchable.some((value) => ENGINEERING_PATTERN.test(value))) {
    return {
      level: "medium",
      hazards: [],
      requiresExternalProfessional: false
    };
  }

  return {
    level: "low",
    hazards: [],
    requiresExternalProfessional: false
  };
}

function normalizeRiskQuestion(value: string): string {
  return value
    .normalize("NFKC")
    .replace(DEFAULT_IGNORABLE, "")
    .replace(UNSAFE_CONTROL, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeRiskTokenSeparators(value: string): string {
  let normalized = value.replace(HAN_INNER_SEPARATOR, "");
  for (const [pattern, replacement] of ASCII_RISK_TOKEN_NORMALIZERS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized;
}
