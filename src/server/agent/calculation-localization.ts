import type { PublicCalculation, CalculationResult } from "@/types/chat";

const CALCULATION_TITLES: Readonly<Record<string, string>> = {
  convert_vacuum_units: "真空单位换算",
  calculate_throughput: "气体流量计算",
  calculate_effective_pumping_speed: "有效抽速计算",
  estimate_pumpdown_time: "抽空时间估算",
  classify_flow_regime: "流态判定",
  calculate_orifice_or_tube_conductance: "孔口或管道流导计算",
  combine_parallel_pumps: "并联泵有效抽速计算",
  estimate_leak_or_outgassing_load: "漏气与放气负载估算"
};

const INTERNAL_CALCULATION_TEXT =
  /(?:https?:\/\/|www\.|\b(?:provider|tool|formula|raw|formulaId|formulaVersion|normalizedInputs|rawArguments|resultKey|function_call|tool_call)\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b[a-z]+(?:[A-Z][A-Za-z0-9]*)+\b|(?:x-amz|x-oss)-[a-z-]*signature|ossaccesskeyid)/u;

export function localizeCalculation(
  calculation: CalculationResult
): PublicCalculation {
  const localized = renderLocalizedResult(calculation);
  return {
    calculationId: calculation.id,
    title: CALCULATION_TITLES[calculation.tool] ?? "确定性计算结果",
    result: localized.result,
    ...(localized.unit ? { unit: localized.unit } : {}),
    assumptions: unique(
      calculation.assumptions.map((value) =>
        localizeSupportingText(
          value,
          "计算采用本地校验后的输入条件与适用边界。"
        )
      )
    ),
    warnings: unique(
      calculation.warnings.map((value) =>
        localizeSupportingText(value, "请结合制造商资料和实测工况复核结果。")
      )
    )
  };
}

export function localizeCalculations(
  calculations: readonly CalculationResult[]
): PublicCalculation[] {
  return calculations.map(localizeCalculation);
}

function renderLocalizedResult(calculation: CalculationResult): {
  result: string;
  unit?: string;
} {
  const values = calculation.result;
  const unit = readUnit(values.unit);

  if (calculation.tool === "estimate_pumpdown_time") {
    const equilibrium = readFiniteNumber(values.equilibriumPressurePa);
    const reachable = values.reachable === true;
    const time = readFiniteNumber(values.time);
    if (!reachable) {
      return {
        result:
          equilibrium === undefined
            ? "按当前假设，目标压力不可达。"
            : `按当前假设，目标压力不可达；理论平衡压力约为 ${formatNumber(equilibrium)} Pa。`
      };
    }
    if (time !== undefined) {
      const displayUnit = localizeTimeUnit(unit);
      return {
        result: `估算抽空时间约为 ${formatNumber(time)}${displayUnit ? ` ${displayUnit}` : ""}${
          equilibrium === undefined
            ? "。"
            : `；理论平衡压力约为 ${formatNumber(equilibrium)} Pa。`
        }`
      };
    }
  }

  if (calculation.tool === "classify_flow_regime") {
    const knudsen = readFiniteNumber(values.knudsenNumber);
    const regime = localizeRegime(values.regime);
    return {
      result:
        knudsen === undefined
          ? `判定为${regime}。`
          : `克努森数约为 ${formatNumber(knudsen)}，判定为${regime}。`
    };
  }

  const lower = readFiniteNumber(values.lower);
  const upper = readFiniteNumber(values.upper);
  if (lower !== undefined && upper !== undefined) {
    return {
      result: `估算范围为 ${formatNumber(lower)} 至 ${formatNumber(upper)}。`,
      ...(unit ? { unit } : {})
    };
  }

  const value = readFiniteNumber(values.value);
  if (value !== undefined) {
    return {
      result: `计算值为 ${formatNumber(value)}。`,
      ...(unit ? { unit } : {})
    };
  }

  const numericValues = Object.values(values).filter(
    (entry): entry is number =>
      typeof entry === "number" && Number.isFinite(entry)
  );
  if (numericValues.length > 0) {
    return {
      result: `计算得到 ${numericValues.map(formatNumber).join("、")}。`,
      ...(unit ? { unit } : {})
    };
  }

  return { result: "计算已完成，结果需结合输入条件解释。" };
}

function localizeRegime(value: unknown): string {
  if (value === "viscous") return "粘滞流";
  if (value === "molecular") return "分子流";
  if (value === "transition") return "过渡流";
  return "待结合工况确认的流态";
}

function localizeSupportingText(value: string, fallback: string): string {
  const text = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!text || INTERNAL_CALCULATION_TEXT.test(text)) return fallback;
  // Validated calculators currently emit Chinese assumptions and warnings.
  // Unknown English-only provider payloads are deliberately not projected.
  return /[\p{Script=Han}]/u.test(text) ? text.slice(0, 500) : fallback;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readUnit(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const unit = value.normalize("NFKC").trim();
  return unit && unit.length <= 40 && !INTERNAL_CALCULATION_TEXT.test(unit)
    ? unit
    : undefined;
}

function localizeTimeUnit(unit: string | undefined): string | undefined {
  if (unit === "s") return "秒";
  if (unit === "min") return "分钟";
  if (unit === "h") return "小时";
  return unit;
}

function formatNumber(value: number): string {
  if (value === 0) return "0";
  const absolute = Math.abs(value);
  if (absolute >= 1e6 || absolute < 1e-4) {
    return value.toExponential(6).replace(/\.?(?:0+)(?=e)/u, "");
  }
  return Number(value.toPrecision(8)).toString();
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
