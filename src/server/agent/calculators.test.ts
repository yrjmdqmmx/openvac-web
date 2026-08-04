import { describe, expect, it } from "vitest";

import { executeCalculator } from "./calculators";

describe("Agent V2 deterministic vacuum calculators", () => {
  it.each([
    [1, "Pa", "mbar", 0.01],
    [1, "mbar", "Pa", 100],
    [1, "bar", "Pa", 100_000],
    [1, "kPa", "Pa", 1_000],
    [1, "Torr", "Pa", 133.322_368_421_052_63],
    [1, "mTorr", "Pa", 0.133_322_368_421_052_63],
    [1, "micron", "Pa", 0.133_322_368_421_052_63],
    [1, "atm", "Pa", 101_325]
  ])("converts %s %s to %s", (value, fromUnit, toUnit, expected) => {
    expect(
      resultValue(
        executeCalculator("convert_vacuum_units", {
          quantity: "pressure",
          value,
          fromUnit,
          toUnit
        })
      )
    ).toBeCloseTo(expected, 10);
  });

  it.each([
    [1, "L/s", "m3/s", 0.001],
    [3_600, "m3/h", "m3/s", 1],
    [1, "m3/s", "L/s", 1_000],
    [1, "cfm", "L/s", 0.471_947_45]
  ])(
    "converts pumping speed %s %s to %s",
    (value, fromUnit, toUnit, expected) => {
      expect(
        resultValue(
          executeCalculator("convert_vacuum_units", {
            quantity: "pumping_speed",
            value,
            fromUnit,
            toUnit
          })
        )
      ).toBeCloseTo(expected, 9);
    }
  );

  it.each([
    [1, "mbar*L/s", "Pa*m3/s", 0.1],
    [1, "Torr*L/s", "Pa*m3/s", 0.133_322_368_421_052_63],
    [1, "Pa*m3/s", "mbar*L/s", 10]
  ])("converts throughput %s %s to %s", (value, fromUnit, toUnit, expected) => {
    expect(
      resultValue(
        executeCalculator("convert_vacuum_units", {
          quantity: "throughput",
          value,
          fromUnit,
          toUnit
        })
      )
    ).toBeCloseTo(expected, 9);
  });

  it.each([
    [100, "Pa", 10, "L/s", 1],
    [1, "mbar", 36, "m3/h", 1]
  ])(
    "calculates Q=pS across units",
    (pressure, pressureUnit, speed, speedUnit, expected) => {
      expect(
        resultValue(
          executeCalculator("calculate_throughput", {
            pressure: { value: pressure, unit: pressureUnit },
            pumpingSpeed: { value: speed, unit: speedUnit },
            outputUnit: "Pa*m3/s"
          })
        )
      ).toBeCloseTo(expected, 10);
    }
  );

  it.each([
    [100, 100, 50],
    [100, 50, 100 / 3]
  ])(
    "calculates effective speed with pump=%s and conductance=%s",
    (pump, conductance, expected) => {
      expect(
        resultValue(
          executeCalculator("calculate_effective_pumping_speed", {
            pumpSpeed: { value: pump, unit: "L/s" },
            conductance: { value: conductance, unit: "L/s" },
            outputUnit: "L/s"
          })
        )
      ).toBeCloseTo(expected, 10);
    }
  );

  it("estimates ideal pumpdown with no gas load", () => {
    const output = executeCalculator("estimate_pumpdown_time", {
      volume: { value: 1, unit: "m3" },
      pumpingSpeed: { value: 1, unit: "m3/s" },
      initialPressure: { value: 1000, unit: "Pa" },
      targetPressure: { value: 1, unit: "Pa" },
      outputUnit: "s"
    });
    expect(resultValue(output, "time")).toBeCloseTo(Math.log(1000), 10);
  });

  it("includes a constant gas load in pumpdown", () => {
    const output = executeCalculator("estimate_pumpdown_time", {
      volume: { value: 100, unit: "L" },
      pumpingSpeed: { value: 10, unit: "L/s" },
      initialPressure: { value: 100, unit: "Pa" },
      targetPressure: { value: 2, unit: "Pa" },
      gasLoad: { value: 0.01, unit: "Pa*m3/s" },
      outputUnit: "s"
    });
    expect(resultValue(output, "equilibriumPressurePa")).toBeCloseTo(1, 10);
    expect(resultValue(output, "time")).toBeGreaterThan(0);
  });

  it.each([1, 0.5])(
    "marks target pressure %s Pa unreachable at equilibrium",
    (target) => {
      const output = executeCalculator("estimate_pumpdown_time", {
        volume: { value: 100, unit: "L" },
        pumpingSpeed: { value: 10, unit: "L/s" },
        initialPressure: { value: 100, unit: "Pa" },
        targetPressure: { value: target, unit: "Pa" },
        gasLoad: { value: 0.01, unit: "Pa*m3/s" },
        outputUnit: "s"
      });
      expect(resultField(output, "reachable")).toBe(false);
      expect(resultField(output, "time")).toBeNull();
    }
  );

  it("rejects a pumpdown target above the initial pressure", () => {
    expect(
      executeCalculator("estimate_pumpdown_time", {
        volume: { value: 1, unit: "m3" },
        pumpingSpeed: { value: 1, unit: "m3/s" },
        initialPressure: { value: 1, unit: "Pa" },
        targetPressure: { value: 2, unit: "Pa" }
      })
    ).toMatchObject({ ok: false });
  });

  it.each([
    [0.001, "viscous"],
    [0.01, "transition"],
    [10, "transition"],
    [10.001, "molecular"]
  ])("classifies Kn=%s as %s", (knudsenNumber, regime) => {
    const output = executeCalculator("classify_flow_regime", {
      meanFreePath: { value: knudsenNumber, unit: "m" },
      characteristicLength: { value: 1, unit: "m" }
    });
    expect(resultField(output, "regime")).toBe(regime);
  });

  it("calculates molecular circular-orifice conductance", () => {
    const output = executeCalculator("calculate_orifice_or_tube_conductance", {
      geometry: "circular_orifice",
      diameter: { value: 2, unit: "cm" },
      regime: "molecular",
      outputUnit: "L/s"
    });
    expect(resultValue(output)).toBeCloseTo(11.6 * Math.PI, 9);
  });

  it("calculates molecular straight-tube conductance", () => {
    const output = executeCalculator("calculate_orifice_or_tube_conductance", {
      geometry: "straight_circular_tube",
      diameter: { value: 2, unit: "cm" },
      length: { value: 10, unit: "cm" },
      regime: "molecular",
      outputUnit: "L/s"
    });
    expect(resultValue(output)).toBeCloseTo((12.1 * 8) / 10, 9);
  });

  it("returns a range for transition conductance", () => {
    const output = executeCalculator("calculate_orifice_or_tube_conductance", {
      geometry: "straight_circular_tube",
      diameter: { value: 1, unit: "cm" },
      length: { value: 10, unit: "cm" },
      regime: "transition",
      meanPressure: { value: 1, unit: "mbar" },
      dynamicViscosityPaS: 1.81e-5,
      outputUnit: "L/s"
    });
    expect(resultField(output, "range")).toBe(true);
    expect(resultValue(output, "upper")).toBeGreaterThanOrEqual(
      resultValue(output, "lower")
    );
  });

  it.each([
    ["straight_circular_tube", "molecular", ["length"]],
    [
      "circular_orifice",
      "viscous",
      ["粘滞流圆孔需要孔板厚度、压差和经验证的孔口流量模型"]
    ]
  ])(
    "fails closed for unsupported conductance inputs",
    (geometry, regime, missingInputs) => {
      expect(
        executeCalculator("calculate_orifice_or_tube_conductance", {
          geometry,
          diameter: { value: 1, unit: "cm" },
          regime
        })
      ).toMatchObject({ ok: false, missingInputs });
    }
  );

  it("sums parallel pump effective speeds", () => {
    const output = executeCalculator("combine_parallel_pumps", {
      pumps: [
        { speed: { value: 100, unit: "L/s" } },
        {
          speed: { value: 100, unit: "L/s" },
          conductance: { value: 100, unit: "L/s" }
        }
      ],
      outputUnit: "L/s"
    });
    expect(resultValue(output)).toBeCloseTo(150, 10);
  });

  it("rejects an empty parallel pump list", () => {
    expect(
      executeCalculator("combine_parallel_pumps", {
        pumps: [],
        outputUnit: "L/s"
      })
    ).toMatchObject({ ok: false });
  });

  it("adds leak and outgassing loads", () => {
    const output = executeCalculator("estimate_leak_or_outgassing_load", {
      leakRate: { value: 0.1, unit: "Pa*m3/s" },
      outgassingRate: { value: 0.001, unit: "Pa*m3/s/m2" },
      surfaceArea: { value: 10, unit: "m2" },
      outputUnit: "Pa*m3/s"
    });
    expect(resultValue(output)).toBeCloseTo(0.11, 10);
  });

  it("requires area for an outgassing load", () => {
    expect(
      executeCalculator("estimate_leak_or_outgassing_load", {
        outgassingRate: { value: 1, unit: "Pa*m3/s/m2" }
      })
    ).toMatchObject({ ok: false, missingInputs: ["surfaceArea"] });
  });

  it("requires at least one load component", () => {
    expect(
      executeCalculator("estimate_leak_or_outgassing_load", {})
    ).toMatchObject({
      ok: false
    });
  });

  it("rejects units outside the verified conversion table", () => {
    expect(
      executeCalculator("convert_vacuum_units", {
        quantity: "pressure",
        value: 1,
        fromUnit: "psi",
        toUnit: "Pa"
      })
    ).toMatchObject({ ok: false, missingInputs: ["Unsupported unit: psi"] });
  });

  it("refuses to reuse the air conductance constant for another gas", () => {
    expect(
      executeCalculator("calculate_orifice_or_tube_conductance", {
        geometry: "circular_orifice",
        diameter: { value: 1, unit: "cm" },
        regime: "molecular",
        gas: "helium"
      })
    ).toMatchObject({ ok: false });
  });
});

function resultField(
  output: ReturnType<typeof executeCalculator>,
  key: string
) {
  if (!output.ok)
    throw new Error(
      `Expected a calculation: ${output.missingInputs.join(",")}`
    );
  return output.calculation.result[key];
}

function resultValue(
  output: ReturnType<typeof executeCalculator>,
  key = "value"
): number {
  const value = resultField(output, key);
  if (typeof value !== "number") throw new Error(`Expected numeric ${key}.`);
  return value;
}
