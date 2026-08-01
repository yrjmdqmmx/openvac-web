import { describe, expect, it } from "vitest";

import rotaryVanePumpFixture from "../../../../modeling-service/tests/fixtures/rotary_vane_pump_v1.json";

import { hashModelDocument } from "@/lib/modeling/canonical";
import { modelDocumentSchema } from "@/types/modeling";

import {
  DEFAULT_ROTARY_VANE_PUMP_PARAMETERS,
  createRotaryVanePumpTemplate,
  diagnoseRotaryVanePump,
  rotaryVanePumpParametersSchema,
  validateRotaryVanePumpParameters
} from "./rotary-vane-pump";

describe("single-stage double-vane rotary pump template", () => {
  it("builds a valid original V1 document with explicit annular covers", () => {
    const document = createRotaryVanePumpTemplate();

    expect(modelDocumentSchema.safeParse(document).success).toBe(true);
    expect(document.metadata?.template?.templateId).toBe(
      "template.rotary-vane-pump.single-stage-double-vane"
    );
    expect(document.parameters.map((parameter) => parameter.name)).toEqual([
      "chamberDiameter",
      "rotorDiameter",
      "eccentricity",
      "axialWidth",
      "vaneCount",
      "vaneThickness",
      "vaneHeight",
      "shaftDiameter",
      "inletWidth",
      "outletWidth",
      "coverOuterDiameter",
      "coverThickness",
      "coverBoreDiameter"
    ]);
    expect(
      document.parameters.find((parameter) => parameter.name === "vaneCount")
    ).toMatchObject({ value: 2, editable: false });

    expect(document.parameters.slice(-3)).toMatchObject([
      {
        semanticRef: "pump.parameter.cover-outer-diameter",
        value: 118,
        source: "derived",
        editable: false
      },
      {
        semanticRef: "pump.parameter.cover-thickness",
        value: 6.75,
        source: "derived",
        editable: false
      },
      {
        semanticRef: "pump.parameter.cover-bore-diameter",
        value: 22,
        source: "derived",
        editable: false
      }
    ]);

    expect(
      document.sketches.slice(-2).map((sketch) => sketch.semanticRef)
    ).toEqual([
      "pump.sketch.front-cover-profile",
      "pump.sketch.rear-cover-profile"
    ]);
    for (const sketch of document.sketches.slice(-2)) {
      expect(sketch.entities.map((entity) => entity.semanticRef)).toEqual([
        `${sketch.semanticRef}.outer-center`,
        `${sketch.semanticRef}.bore-center`,
        `${sketch.semanticRef}.outer-circle`,
        `${sketch.semanticRef}.shaft-clearance-circle`
      ]);
      expect(sketch.entities[1]).toMatchObject({
        entityKind: "point",
        x: 6,
        y: 0
      });
      expect(sketch.solveStatus).toBe("fully_constrained");
    }

    expect(document.features.slice(-2)).toMatchObject([
      {
        semanticRef: "pump.feature.front-cover",
        featureKind: "extrude",
        direction: "reverse",
        operation: "new_body"
      },
      {
        semanticRef: "pump.feature.rear-cover",
        featureKind: "extrude",
        direction: "normal",
        operation: "new_body"
      }
    ]);
    expect(document.components.slice(-2)).toMatchObject([
      {
        semanticRef: "pump.component.front-cover",
        transform: { translationMm: [0, 0, 0] }
      },
      {
        semanticRef: "pump.component.rear-cover",
        transform: { translationMm: [0, 0, 60] }
      }
    ]);
    expect(document.assemblyConstraints.slice(-2)).toMatchObject([
      {
        semanticRef: "pump.assembly.front-cover-to-chamber",
        constraintKind: "coincident"
      },
      {
        semanticRef: "pump.assembly.rear-cover-axial-offset",
        constraintKind: "distance",
        parameterRef: {
          semanticRef: "pump.parameter.axial-width"
        }
      }
    ]);
  });

  it("recomputes non-editable cover dimensions from pump geometry", () => {
    const document = createRotaryVanePumpTemplate({
      parameters: {
        chamberDiameter: 120,
        vaneHeight: 35,
        shaftDiameter: 24
      }
    });
    const values = Object.fromEntries(
      document.parameters.map((parameter) => [parameter.name, parameter.value])
    );

    expect(values.coverOuterDiameter).toBe(141.6);
    expect(values.coverThickness).toBe(8.1);
    expect(values.coverBoreDiameter).toBe(26);
  });

  it("derives stable UUIDs and hashes from the document seed", () => {
    const first = createRotaryVanePumpTemplate();
    const second = createRotaryVanePumpTemplate();

    expect(first).toEqual(second);
    expect(hashModelDocument(first)).toBe(hashModelDocument(second));

    const customId = "77777777-7777-4777-8777-777777777777";
    const customFirst = createRotaryVanePumpTemplate({ documentId: customId });
    const customSecond = createRotaryVanePumpTemplate({ documentId: customId });
    expect(customFirst).toEqual(customSecond);
    expect(customFirst.id).toBe(customId);
    expect(customFirst.parameters[0]!.id).not.toBe(first.parameters[0]!.id);
  });

  it("keeps the cross-language fixture byte-semantically aligned", () => {
    expect(modelDocumentSchema.parse(rotaryVanePumpFixture)).toEqual(
      createRotaryVanePumpTemplate()
    );
  });

  it("rejects negative and non-finite dimensions", () => {
    expect(
      rotaryVanePumpParametersSchema.safeParse({
        ...DEFAULT_ROTARY_VANE_PUMP_PARAMETERS,
        chamberDiameter: -100
      }).success
    ).toBe(false);
    expect(
      rotaryVanePumpParametersSchema.safeParse({
        ...DEFAULT_ROTARY_VANE_PUMP_PARAMETERS,
        rotorDiameter: Number.POSITIVE_INFINITY
      }).success
    ).toBe(false);
  });

  it.each([
    {
      label: "rotor intersects chamber",
      change: { rotorDiameter: 98, eccentricity: 2 }
    },
    {
      label: "vane cannot reach far wall",
      change: { vaneHeight: 10 }
    },
    {
      label: "vane root collides with shaft",
      change: { shaftDiameter: 50, vaneHeight: 28 }
    },
    {
      label: "not a double-vane pump",
      change: { vaneCount: 3 }
    },
    {
      label: "ports erase sealing arc",
      change: { inletWidth: 150, outletWidth: 150 }
    }
  ])("rejects impossible geometry: $label", ({ change }) => {
    expect(
      rotaryVanePumpParametersSchema.safeParse({
        ...DEFAULT_ROTARY_VANE_PUMP_PARAMETERS,
        ...change
      }).success
    ).toBe(false);
  });

  it("reports analytic envelope, volume, clearance, vane travel, and ports", () => {
    const parameters = validateRotaryVanePumpParameters(
      DEFAULT_ROTARY_VANE_PUMP_PARAMETERS
    );
    const diagnostics = diagnoseRotaryVanePump(parameters);

    expect(diagnostics.method).toEqual({
      kind: "deterministic_analytic_geometry",
      deterministic: true,
      cfd: false
    });
    expect(diagnostics.envelope).toMatchObject({
      basis: "internal_chamber_only",
      radialDiameterMm: 100,
      axialWidthMm: 60,
      boundingBoxVolumeMm3: 600_000
    });
    expect(diagnostics.volumes.chamberCylinderMm3).toBeCloseTo(
      Math.PI * 50 ** 2 * 60,
      5
    );
    expect(diagnostics.volumes.geometricVoidMm3).toBeCloseTo(
      Math.PI * (50 ** 2 - 40 ** 2) * 60,
      5
    );
    expect(diagnostics.volumes.workingCellMinimumMm3).toBeGreaterThan(0);
    expect(diagnostics.volumes.workingCellMaximumMm3).toBeGreaterThan(
      diagnostics.volumes.workingCellMinimumMm3
    );
    expect(
      diagnostics.volumes.workingCellMinimumMm3 +
        diagnostics.volumes.workingCellMaximumMm3
    ).toBeCloseTo(diagnostics.volumes.geometricVoidMm3, 3);
    expect(diagnostics.volumes.workingCellMethod).toBe(
      "deterministic_polar_quadrature"
    );
    expect(diagnostics.rotation).toEqual({
      samplingStepDegrees: 1,
      samples: 360,
      collisionBoundaryAnglesDegrees: [],
      clearanceMethod: "analytic_circle_ray_intersection"
    });
    expect(diagnostics.radialClearance).toEqual({
      minimumMm: 4,
      maximumMm: 16,
      status: "pass"
    });
    expect(diagnostics.vaneExtension).toMatchObject({
      minimumMm: 3.85,
      maximumMm: 15.85,
      strokeMm: 12,
      minimumRetainedInRotorMm: 10.15,
      maximumRetainedInRotorMm: 22.15,
      availableSlotDepthMm: 30,
      controlledTipGapMinimumMm: 0.15,
      controlledTipGapMaximumMm: 0.15,
      contactState: "controlled_tip_gap"
    });
    expect(diagnostics.ports.inlet).toMatchObject({
      role: "inlet",
      chamberRegion: "expanding",
      connectivity: "connected"
    });
    expect(diagnostics.ports.outlet).toMatchObject({
      role: "outlet",
      chamberRegion: "contracting",
      connectivity: "connected"
    });
    expect(diagnostics.ports.isolatedFromEachOther).toBe(true);
    expect(diagnostics.ports.inlet.openSamples).toBeGreaterThan(0);
    expect(diagnostics.ports.outlet.openSamples).toBeGreaterThan(0);
    expect(diagnostics.ports.inlet.blockedByVaneSamples).toBeGreaterThan(0);
    expect(diagnostics.ports.outlet.blockedByVaneSamples).toBeGreaterThan(0);
    expect(diagnostics.ports.sameChamberOpenSamples).toBe(0);
    expect(diagnostics.limitations.join(" ")).toContain("No CFD");
  });
});
