import { createHash } from "node:crypto";
import { z } from "zod";

import type { CalculationResult } from "@/types/chat";

const positive = z.number().finite().positive();
const nonNegative = z.number().finite().nonnegative();
const positiveQuantity = z.object({ value: positive, unit: z.string().min(1) });
const nonNegativeQuantity = z.object({
  value: nonNegative,
  unit: z.string().min(1)
});

export type CalculationToolOutput =
  | { ok: true; calculation: CalculationResult }
  | { ok: false; missingInputs: string[]; warnings: string[] };

export const calculatorSchemas = {
  convert_vacuum_units: z.object({
    quantity: z.enum(["pressure", "pumping_speed", "throughput"]),
    value: z.number().finite(),
    fromUnit: z.string().min(1),
    toUnit: z.string().min(1)
  }),
  calculate_throughput: z.object({
    pressure: positiveQuantity,
    pumpingSpeed: positiveQuantity,
    outputUnit: z.string().default("Pa*m3/s")
  }),
  calculate_effective_pumping_speed: z.object({
    pumpSpeed: positiveQuantity,
    conductance: positiveQuantity,
    outputUnit: z.string().default("L/s")
  }),
  estimate_pumpdown_time: z.object({
    volume: positiveQuantity,
    pumpingSpeed: positiveQuantity,
    initialPressure: positiveQuantity,
    targetPressure: positiveQuantity,
    gasLoad: nonNegativeQuantity.optional(),
    outputUnit: z.enum(["s", "min", "h"]).default("s")
  }),
  classify_flow_regime: z.object({
    meanFreePath: positiveQuantity,
    characteristicLength: positiveQuantity
  }),
  calculate_orifice_or_tube_conductance: z.object({
    geometry: z.enum(["circular_orifice", "straight_circular_tube"]),
    diameter: positiveQuantity,
    length: positiveQuantity.optional(),
    regime: z.enum(["molecular", "viscous", "transition"]),
    meanPressure: positiveQuantity.optional(),
    dynamicViscosityPaS: positive.optional(),
    gas: z.string().default("air"),
    temperatureK: positive.default(293.15),
    outputUnit: z.string().default("L/s")
  }),
  combine_parallel_pumps: z.object({
    pumps: z
      .array(
        z.object({
          speed: positiveQuantity,
          conductance: positiveQuantity.optional()
        })
      )
      .min(1)
      .max(32),
    outputUnit: z.string().default("L/s")
  }),
  estimate_leak_or_outgassing_load: z.object({
    leakRate: nonNegativeQuantity.optional(),
    outgassingRate: nonNegativeQuantity.optional(),
    surfaceArea: positiveQuantity.optional(),
    outputUnit: z.string().default("Pa*m3/s")
  })
} as const;

export type CalculatorName = keyof typeof calculatorSchemas;

const PRESSURE_TO_PA: Record<string, number> = {
  pa: 1,
  kpa: 1_000,
  mpa: 1_000_000,
  bar: 100_000,
  mbar: 100,
  torr: 133.322_368_421_052_63,
  mtorr: 0.133_322_368_421_052_63,
  micron: 0.133_322_368_421_052_63,
  atm: 101_325
};

const SPEED_TO_M3_S: Record<string, number> = {
  "m3/s": 1,
  "m³/s": 1,
  "l/s": 1e-3,
  "m3/h": 1 / 3600,
  "m³/h": 1 / 3600,
  cfm: 0.000_471_947_45
};

const THROUGHPUT_TO_PA_M3_S: Record<string, number> = {
  "pa*m3/s": 1,
  "pa·m3/s": 1,
  "pa·m³/s": 1,
  "mbar*l/s": 0.1,
  "mbar·l/s": 0.1,
  "torr*l/s": 0.133_322_368_421_052_63,
  "torr·l/s": 0.133_322_368_421_052_63
};

const LENGTH_TO_M: Record<string, number> = {
  m: 1,
  cm: 0.01,
  mm: 0.001,
  um: 1e-6,
  µm: 1e-6
};

const VOLUME_TO_M3: Record<string, number> = {
  m3: 1,
  "m³": 1,
  l: 0.001,
  liter: 0.001,
  litre: 0.001
};

const AREA_TO_M2: Record<string, number> = {
  m2: 1,
  "m²": 1,
  cm2: 1e-4,
  "cm²": 1e-4,
  mm2: 1e-6,
  "mm²": 1e-6
};

const OUTGASSING_TO_PA_M3_S_M2: Record<string, number> = {
  "pa*m3/s/m2": 1,
  "pa·m3/s/m2": 1,
  "pa·m³/s/m²": 1,
  "mbar*l/s/cm2": 1_000,
  "mbar·l/s/cm²": 1_000,
  "torr*l/s/cm2": 1_333.223_684_210_526_2,
  "torr·l/s/cm²": 1_333.223_684_210_526_2
};

export function executeCalculator(
  name: CalculatorName,
  rawArguments: unknown
): CalculationToolOutput {
  const parsed = calculatorSchemas[name].safeParse(rawArguments);
  if (!parsed.success) {
    return {
      ok: false,
      missingInputs: parsed.error.issues.map((issue) =>
        issue.path.length ? issue.path.join(".") : issue.message
      ),
      warnings: ["计算参数未通过 OpenVac 本地 Schema 校验。"]
    };
  }

  try {
    switch (name) {
      case "convert_vacuum_units":
        return convertVacuumUnits(
          parsed.data as z.infer<
            (typeof calculatorSchemas)["convert_vacuum_units"]
          >
        );
      case "calculate_throughput":
        return calculateThroughput(
          parsed.data as z.infer<
            (typeof calculatorSchemas)["calculate_throughput"]
          >
        );
      case "calculate_effective_pumping_speed":
        return calculateEffectivePumpingSpeed(
          parsed.data as z.infer<
            (typeof calculatorSchemas)["calculate_effective_pumping_speed"]
          >
        );
      case "estimate_pumpdown_time":
        return estimatePumpdownTime(
          parsed.data as z.infer<
            (typeof calculatorSchemas)["estimate_pumpdown_time"]
          >
        );
      case "classify_flow_regime":
        return classifyFlowRegime(
          parsed.data as z.infer<
            (typeof calculatorSchemas)["classify_flow_regime"]
          >
        );
      case "calculate_orifice_or_tube_conductance":
        return calculateConductance(
          parsed.data as z.infer<
            (typeof calculatorSchemas)["calculate_orifice_or_tube_conductance"]
          >
        );
      case "combine_parallel_pumps":
        return combineParallelPumps(
          parsed.data as z.infer<
            (typeof calculatorSchemas)["combine_parallel_pumps"]
          >
        );
      case "estimate_leak_or_outgassing_load":
        return estimateLeakOrOutgassingLoad(
          parsed.data as z.infer<
            (typeof calculatorSchemas)["estimate_leak_or_outgassing_load"]
          >
        );
    }
  } catch (error) {
    return {
      ok: false,
      missingInputs: [
        error instanceof Error ? error.message : "无法识别计算参数"
      ],
      warnings: ["单位或参数不在当前已验证公式覆盖范围内。"]
    };
  }
}

function convertVacuumUnits(
  input: z.infer<(typeof calculatorSchemas)["convert_vacuum_units"]>
): CalculationToolOutput {
  const factors =
    input.quantity === "pressure"
      ? PRESSURE_TO_PA
      : input.quantity === "pumping_speed"
        ? SPEED_TO_M3_S
        : THROUGHPUT_TO_PA_M3_S;
  const base = toBase(input.value, input.fromUnit, factors);
  const value = fromBase(base, input.toUnit, factors);
  return success("convert_vacuum_units", "unit-conversion", "1.0.0", input, {
    value,
    unit: input.toUnit
  });
}

function calculateThroughput(
  input: z.infer<(typeof calculatorSchemas)["calculate_throughput"]>
): CalculationToolOutput {
  const pressurePa = toBase(
    input.pressure.value,
    input.pressure.unit,
    PRESSURE_TO_PA
  );
  const speedM3S = toBase(
    input.pumpingSpeed.value,
    input.pumpingSpeed.unit,
    SPEED_TO_M3_S
  );
  const throughput = pressurePa * speedM3S;
  return success(
    "calculate_throughput",
    "Q=pS",
    "1.0.0",
    { pressurePa, speedM3S },
    {
      value: fromBase(throughput, input.outputUnit, THROUGHPUT_TO_PA_M3_S),
      unit: input.outputUnit
    },
    ["压力与抽速取同一工作点的稳态值。"],
    [],
    ["openvac.formula.throughput.q-equals-p-times-s.v1"]
  );
}

function calculateEffectivePumpingSpeed(
  input: z.infer<
    (typeof calculatorSchemas)["calculate_effective_pumping_speed"]
  >
): CalculationToolOutput {
  const pumpSpeedM3S = toBase(
    input.pumpSpeed.value,
    input.pumpSpeed.unit,
    SPEED_TO_M3_S
  );
  const conductanceM3S = toBase(
    input.conductance.value,
    input.conductance.unit,
    SPEED_TO_M3_S
  );
  const effectiveM3S = 1 / (1 / pumpSpeedM3S + 1 / conductanceM3S);
  return success(
    "calculate_effective_pumping_speed",
    "1/Seff=1/Spump+1/C",
    "1.0.0",
    { pumpSpeedM3S, conductanceM3S },
    {
      value: fromBase(effectiveM3S, input.outputUnit, SPEED_TO_M3_S),
      unit: input.outputUnit
    },
    ["泵与真空容器之间按单一等效导流元件处理。"],
    [],
    ["openvac.formula.effective-pumping-speed.series.v1"]
  );
}

function estimatePumpdownTime(
  input: z.infer<(typeof calculatorSchemas)["estimate_pumpdown_time"]>
): CalculationToolOutput {
  const volumeM3 = toBase(input.volume.value, input.volume.unit, VOLUME_TO_M3);
  const speedM3S = toBase(
    input.pumpingSpeed.value,
    input.pumpingSpeed.unit,
    SPEED_TO_M3_S
  );
  const initialPa = toBase(
    input.initialPressure.value,
    input.initialPressure.unit,
    PRESSURE_TO_PA
  );
  const targetPa = toBase(
    input.targetPressure.value,
    input.targetPressure.unit,
    PRESSURE_TO_PA
  );
  const gasLoadPaM3S = input.gasLoad
    ? toBase(input.gasLoad.value, input.gasLoad.unit, THROUGHPUT_TO_PA_M3_S)
    : 0;
  if (targetPa >= initialPa) {
    return {
      ok: false,
      missingInputs: ["targetPressure 必须低于 initialPressure"],
      warnings: ["抽空模型不适用于升压过程。"]
    };
  }
  const equilibriumPa = gasLoadPaM3S / speedM3S;
  if (targetPa <= equilibriumPa) {
    return success(
      "estimate_pumpdown_time",
      "p(t)=peq+(p0-peq)exp(-St/V)",
      "1.1.0",
      { volumeM3, speedM3S, initialPa, targetPa, gasLoadPaM3S },
      {
        reachable: false,
        equilibriumPressurePa: equilibriumPa,
        time: null,
        unit: input.outputUnit
      },
      ["抽速与恒定气载在整个压力区间内保持不变。"],
      ["目标压力不高于理论平衡压力，按该模型不可达。"],
      ["openvac.formula.pumpdown.constant-speed-load.v1"]
    );
  }
  const seconds =
    (volumeM3 / speedM3S) *
    Math.log((initialPa - equilibriumPa) / (targetPa - equilibriumPa));
  return success(
    "estimate_pumpdown_time",
    "p(t)=peq+(p0-peq)exp(-St/V)",
    "1.1.0",
    { volumeM3, speedM3S, initialPa, targetPa, gasLoadPaM3S },
    {
      reachable: true,
      equilibriumPressurePa: equilibriumPa,
      time: seconds / timeDivisor(input.outputUnit),
      unit: input.outputUnit
    },
    ["容器充分混合；抽速与气载恒定；未计入泵启动、导流变化和材料解吸瞬态。"],
    ["这是理想化估算，不能替代泵曲线和实测抽空曲线。"],
    ["openvac.formula.pumpdown.constant-speed-load.v1"]
  );
}

function classifyFlowRegime(
  input: z.infer<(typeof calculatorSchemas)["classify_flow_regime"]>
): CalculationToolOutput {
  const meanFreePathM = toBase(
    input.meanFreePath.value,
    input.meanFreePath.unit,
    LENGTH_TO_M
  );
  const characteristicLengthM = toBase(
    input.characteristicLength.value,
    input.characteristicLength.unit,
    LENGTH_TO_M
  );
  const knudsenNumber = meanFreePathM / characteristicLengthM;
  const regime =
    knudsenNumber < 0.01
      ? "viscous"
      : knudsenNumber > 10
        ? "molecular"
        : "transition";
  return success(
    "classify_flow_regime",
    "Kn=lambda/L",
    "1.0.0",
    { meanFreePathM, characteristicLengthM },
    { knudsenNumber, regime },
    ["特征长度由用户按流道几何选择。"],
    regime === "transition"
      ? ["过渡流不应套用单一纯粘滞流或纯分子流公式。"]
      : [],
    ["openvac.formula.knudsen-flow-regime.v1"]
  );
}

function calculateConductance(
  input: z.infer<
    (typeof calculatorSchemas)["calculate_orifice_or_tube_conductance"]
  >
): CalculationToolOutput {
  if (input.gas.toLowerCase() !== "air") {
    return {
      ok: false,
      missingInputs: ["仅支持 air；其他气体需要经验证的气体修正参数"],
      warnings: ["未对未知气体伪造导流系数。"]
    };
  }
  const diameterM = toBase(
    input.diameter.value,
    input.diameter.unit,
    LENGTH_TO_M
  );
  const diameterCm = diameterM * 100;
  const areaCm2 = Math.PI * (diameterCm / 2) ** 2;
  const temperatureFactor = Math.sqrt(input.temperatureK / 293.15);
  const molecularLs =
    input.geometry === "circular_orifice"
      ? 11.6 * areaCm2 * temperatureFactor
      : input.length
        ? ((12.1 * diameterCm ** 3) /
            (toBase(input.length.value, input.length.unit, LENGTH_TO_M) *
              100)) *
          temperatureFactor
        : undefined;
  if (molecularLs === undefined) {
    return {
      ok: false,
      missingInputs: ["length"],
      warnings: ["直圆管导流计算需要管长。"]
    };
  }
  if (input.regime === "molecular") {
    return conductanceSuccess(
      input,
      diameterM,
      molecularLs,
      molecularLs,
      "molecular"
    );
  }
  if (input.geometry === "circular_orifice") {
    return {
      ok: false,
      missingInputs: ["粘滞流圆孔需要孔板厚度、压差和经验证的孔口流量模型"],
      warnings: ["当前版本只对分子流圆孔给出确定性导流值。"]
    };
  }
  const missing: string[] = [];
  if (!input.length) missing.push("length");
  if (!input.meanPressure) missing.push("meanPressure");
  if (!input.dynamicViscosityPaS) missing.push("dynamicViscosityPaS");
  if (missing.length) {
    return {
      ok: false,
      missingInputs: missing,
      warnings: ["粘滞流和过渡流范围需要平均压力及动力粘度。"]
    };
  }
  const lengthM = toBase(input.length!.value, input.length!.unit, LENGTH_TO_M);
  const meanPressurePa = toBase(
    input.meanPressure!.value,
    input.meanPressure!.unit,
    PRESSURE_TO_PA
  );
  const viscousM3S =
    (Math.PI * diameterM ** 4 * meanPressurePa) /
    (128 * input.dynamicViscosityPaS! * lengthM);
  const viscousLs = viscousM3S * 1_000;
  return conductanceSuccess(
    input,
    diameterM,
    input.regime === "transition"
      ? Math.min(molecularLs, viscousLs)
      : viscousLs,
    input.regime === "transition"
      ? Math.max(molecularLs, viscousLs)
      : viscousLs,
    input.regime
  );
}

function conductanceSuccess(
  input: z.infer<
    (typeof calculatorSchemas)["calculate_orifice_or_tube_conductance"]
  >,
  diameterM: number,
  lowerLs: number,
  upperLs: number,
  regime: string
): CalculationToolOutput {
  const factor = SPEED_TO_M3_S[normalizeUnit(input.outputUnit)];
  if (!factor)
    throw new TypeError(`Unsupported conductance unit: ${input.outputUnit}`);
  return success(
    "calculate_orifice_or_tube_conductance",
    regime === "molecular"
      ? input.geometry === "circular_orifice"
        ? "C=11.6A (air, 293.15K)"
        : "C=12.1D^3/L (air, 293.15K)"
      : regime === "viscous"
        ? "C=pi*d^4*pmean/(128*eta*L)"
        : "validated molecular/viscous bounds",
    "1.0.0",
    {
      diameterM,
      temperatureK: input.temperatureK,
      geometry: input.geometry,
      regime
    },
    regime === "transition"
      ? {
          lower: (lowerLs * 1e-3) / factor,
          upper: (upperLs * 1e-3) / factor,
          unit: input.outputUnit,
          range: true
        }
      : {
          value: (lowerLs * 1e-3) / factor,
          unit: input.outputUnit,
          range: false
        },
    ["空气；直圆管；给定流态和温度在公式适用范围内。"],
    regime === "transition"
      ? ["过渡流仅返回纯流态公式形成的估算范围，不宣称单点精度。"]
      : [],
    ["openvac.formula.conductance.circular-air.v1"]
  );
}

function combineParallelPumps(
  input: z.infer<(typeof calculatorSchemas)["combine_parallel_pumps"]>
): CalculationToolOutput {
  const branchSpeedsM3S = input.pumps.map((pump) => {
    const speed = toBase(pump.speed.value, pump.speed.unit, SPEED_TO_M3_S);
    if (!pump.conductance) return speed;
    const conductance = toBase(
      pump.conductance.value,
      pump.conductance.unit,
      SPEED_TO_M3_S
    );
    return 1 / (1 / speed + 1 / conductance);
  });
  const combined = branchSpeedsM3S.reduce((sum, value) => sum + value, 0);
  return success(
    "combine_parallel_pumps",
    "Stotal=sum(Seffective,i)",
    "1.0.0",
    { branchCount: branchSpeedsM3S.length },
    {
      value: fromBase(combined, input.outputUnit, SPEED_TO_M3_S),
      unit: input.outputUnit
    },
    ["各并联支路工作压力相同，且泵曲线在该工作点允许相加。"],
    ["不适用于缺少制造商曲线的串联泵简化。"],
    ["openvac.formula.parallel-pumps.sum.v1"]
  );
}

function estimateLeakOrOutgassingLoad(
  input: z.infer<(typeof calculatorSchemas)["estimate_leak_or_outgassing_load"]>
): CalculationToolOutput {
  if (!input.leakRate && !input.outgassingRate) {
    return {
      ok: false,
      missingInputs: ["leakRate 或 outgassingRate"],
      warnings: []
    };
  }
  if (input.outgassingRate && !input.surfaceArea) {
    return {
      ok: false,
      missingInputs: ["surfaceArea"],
      warnings: ["材料放气负载需要暴露表面积。"]
    };
  }
  const leak = input.leakRate
    ? toBase(input.leakRate.value, input.leakRate.unit, THROUGHPUT_TO_PA_M3_S)
    : 0;
  const outgassing = input.outgassingRate
    ? toBase(
        input.outgassingRate.value,
        input.outgassingRate.unit,
        OUTGASSING_TO_PA_M3_S_M2
      ) * toBase(input.surfaceArea!.value, input.surfaceArea!.unit, AREA_TO_M2)
    : 0;
  const total = leak + outgassing;
  return success(
    "estimate_leak_or_outgassing_load",
    "Qtotal=Qleak+qoutgassing*A",
    "1.0.0",
    { leakPaM3S: leak, outgassingPaM3S: outgassing },
    {
      value: fromBase(total, input.outputUnit, THROUGHPUT_TO_PA_M3_S),
      unit: input.outputUnit
    },
    ["漏率与单位面积放气率在所述时间和温度下恒定。"],
    ["不能据此自动给出故障定论或最终工程批准。"],
    ["openvac.formula.gas-load.sum.v1"]
  );
}

function success(
  tool: string,
  formulaId: string,
  formulaVersion: string,
  normalizedInputs: Record<string, number | string | boolean | null>,
  result: Record<string, number | string | boolean | null>,
  assumptions: string[] = [],
  warnings: string[] = [],
  sourceIds: string[] = []
): CalculationToolOutput {
  const digest = createHash("sha256")
    .update(JSON.stringify({ tool, formulaId, normalizedInputs, result }))
    .digest("hex")
    .slice(0, 20);
  return {
    ok: true,
    calculation: {
      id: `calc_${digest}`,
      tool,
      formulaId,
      formulaVersion,
      normalizedInputs,
      result,
      assumptions,
      warnings,
      sourceIds
    }
  };
}

function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/\s+/g, "");
}

function toBase(
  value: number,
  unit: string,
  factors: Record<string, number>
): number {
  const factor = factors[normalizeUnit(unit)];
  if (!factor) throw new TypeError(`Unsupported unit: ${unit}`);
  return value * factor;
}

function fromBase(
  value: number,
  unit: string,
  factors: Record<string, number>
): number {
  const factor = factors[normalizeUnit(unit)];
  if (!factor) throw new TypeError(`Unsupported unit: ${unit}`);
  return value / factor;
}

function timeDivisor(unit: "s" | "min" | "h"): number {
  return unit === "s" ? 1 : unit === "min" ? 60 : 3600;
}
