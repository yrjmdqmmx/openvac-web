import { z } from "zod";

import { sha256Hex } from "@/lib/modeling/canonical";
import {
  MODELING_PROTOCOL_VERSION,
  modelingUuidSchema,
  modelDocumentSchema,
  type ModelDocument,
  type ModelParameter,
  type ModelReference
} from "@/types/modeling";

export const ROTARY_VANE_PUMP_TEMPLATE_ID =
  "template.rotary-vane-pump.single-stage-double-vane" as const;
export const ROTARY_VANE_PUMP_TEMPLATE_VERSION = "1.0.0" as const;
export const ROTARY_VANE_TIP_CLEARANCE_MM = 0.15 as const;

export const DEFAULT_ROTARY_VANE_PUMP_PARAMETERS = {
  chamberDiameter: 100,
  rotorDiameter: 80,
  eccentricity: 6,
  axialWidth: 60,
  vaneCount: 2,
  vaneThickness: 4,
  vaneHeight: 26,
  shaftDiameter: 20,
  inletWidth: 18,
  outletWidth: 16
} as const;

const positiveDimensionSchema = z.number().finite().positive().max(100_000);

export const rotaryVanePumpParametersSchema = z
  .strictObject({
    chamberDiameter: positiveDimensionSchema,
    rotorDiameter: positiveDimensionSchema,
    eccentricity: positiveDimensionSchema,
    axialWidth: positiveDimensionSchema,
    vaneCount: z.number().int().min(2).max(16),
    vaneThickness: positiveDimensionSchema,
    vaneHeight: positiveDimensionSchema,
    shaftDiameter: positiveDimensionSchema,
    inletWidth: positiveDimensionSchema,
    outletWidth: positiveDimensionSchema
  })
  .superRefine((parameters, context) => {
    const chamberRadius = parameters.chamberDiameter / 2;
    const rotorRadius = parameters.rotorDiameter / 2;
    const shaftRadius = parameters.shaftDiameter / 2;
    const minimumRadialClearance =
      chamberRadius - rotorRadius - parameters.eccentricity;
    const maximumRadialClearance =
      chamberRadius + parameters.eccentricity - rotorRadius;
    const minimumVaneExtension =
      minimumRadialClearance - ROTARY_VANE_TIP_CLEARANCE_MM;
    const maximumVaneExtension =
      maximumRadialClearance - ROTARY_VANE_TIP_CLEARANCE_MM;
    const availableSlotDepth = rotorRadius - shaftRadius;
    const minimumRetainedHeight = parameters.vaneHeight - maximumVaneExtension;
    const maximumRetainedHeight = parameters.vaneHeight - minimumVaneExtension;
    const requiredEmbeddedHeight = Math.max(2, parameters.rotorDiameter * 0.1);

    if (parameters.vaneCount !== 2) {
      context.addIssue({
        code: "custom",
        path: ["vaneCount"],
        message: "This V1 template is specifically a double-vane pump."
      });
    }
    if (parameters.rotorDiameter >= parameters.chamberDiameter) {
      context.addIssue({
        code: "custom",
        path: ["rotorDiameter"],
        message: "Rotor diameter must be smaller than chamber diameter."
      });
    }
    if (minimumRadialClearance <= ROTARY_VANE_TIP_CLEARANCE_MM) {
      context.addIssue({
        code: "custom",
        path: ["eccentricity"],
        message:
          "Eccentric rotor envelope does not preserve the required vane-tip gap."
      });
    }
    if (parameters.shaftDiameter >= parameters.rotorDiameter) {
      context.addIssue({
        code: "custom",
        path: ["shaftDiameter"],
        message: "Shaft diameter must be smaller than rotor diameter."
      });
    }
    if (parameters.vaneThickness >= parameters.vaneHeight) {
      context.addIssue({
        code: "custom",
        path: ["vaneThickness"],
        message: "Vane thickness must be smaller than vane radial height."
      });
    }
    if (parameters.vaneThickness >= parameters.axialWidth) {
      context.addIssue({
        code: "custom",
        path: ["vaneThickness"],
        message: "Vane thickness must be smaller than the axial width."
      });
    }
    if (minimumRetainedHeight < requiredEmbeddedHeight) {
      context.addIssue({
        code: "custom",
        path: ["vaneHeight"],
        message:
          "Vane height cannot cover maximum extension while retaining the required slot engagement."
      });
    }
    if (
      availableSlotDepth <= 0 ||
      maximumRetainedHeight >= availableSlotDepth
    ) {
      context.addIssue({
        code: "custom",
        path: ["vaneHeight"],
        message:
          "Retracted vane root would collide with the shaft or exceed rotor slot depth."
      });
    }

    const inletSpanRadians = parameters.inletWidth / chamberRadius;
    const outletSpanRadians = parameters.outletWidth / chamberRadius;
    const vaneHalfSpanRadians = Math.asin(
      Math.min(1, parameters.vaneThickness / (2 * rotorRadius))
    );
    const portIsolationMarginRadians =
      Math.PI -
      (inletSpanRadians + outletSpanRadians) / 2 -
      2 * vaneHalfSpanRadians;
    if (portIsolationMarginRadians <= Math.PI / 18) {
      context.addIssue({
        code: "custom",
        path: ["outletWidth"],
        message:
          "Inlet and outlet openings leave less than 10 degrees of theoretical sealing arc."
      });
    }
  });

export type RotaryVanePumpParameters = z.infer<
  typeof rotaryVanePumpParametersSchema
>;

export type RotaryVanePumpDiagnostics = {
  method: {
    kind: "deterministic_analytic_geometry";
    deterministic: true;
    cfd: false;
  };
  envelope: {
    basis: "internal_chamber_only";
    radialDiameterMm: number;
    axialWidthMm: number;
    boundingBoxVolumeMm3: number;
  };
  volumes: {
    chamberCylinderMm3: number;
    rotorCylinderMm3: number;
    shaftCylinderMm3: number;
    geometricVoidMm3: number;
    workingCellMinimumMm3: number;
    workingCellMaximumMm3: number;
    workingCellDeltaMm3: number;
    workingCellMethod: "deterministic_polar_quadrature";
  };
  rotation: {
    samplingStepDegrees: number;
    samples: number;
    collisionBoundaryAnglesDegrees: number[];
    clearanceMethod: "analytic_circle_ray_intersection";
  };
  radialClearance: {
    minimumMm: number;
    maximumMm: number;
    status: "pass" | "tight";
  };
  vaneExtension: {
    minimumMm: number;
    maximumMm: number;
    strokeMm: number;
    minimumRetainedInRotorMm: number;
    maximumRetainedInRotorMm: number;
    availableSlotDepthMm: number;
    controlledTipGapMinimumMm: number;
    controlledTipGapMaximumMm: number;
    contactState: "controlled_tip_gap";
  };
  ports: {
    inlet: RotaryVanePortDiagnostic;
    outlet: RotaryVanePortDiagnostic;
    isolatedFromEachOther: true;
    theoreticalSealingArcMarginDegrees: number;
    sameChamberOpenSamples: 0;
  };
  limitations: string[];
};

type RotaryVanePortDiagnostic = {
  role: "inlet" | "outlet";
  chamberRegion: "expanding" | "contracting";
  centerAngleDegrees: number;
  angularSpanDegrees: number;
  idealizedOpeningAreaMm2: number;
  connectivity: "connected";
  openSamples: number;
  blockedByVaneSamples: number;
};

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function wallDistanceAtAngle(
  parameters: RotaryVanePumpParameters,
  angleDegrees: number
): number {
  const chamberRadius = parameters.chamberDiameter / 2;
  const radians = (angleDegrees * Math.PI) / 180;
  const discriminant =
    chamberRadius ** 2 - (parameters.eccentricity * Math.sin(radians)) ** 2;
  return (
    -parameters.eccentricity * Math.cos(radians) +
    Math.sqrt(Math.max(0, discriminant))
  );
}

function workingCellAreaAtAngle(
  parameters: RotaryVanePumpParameters,
  startAngleDegrees: number
): number {
  const rotorRadius = parameters.rotorDiameter / 2;
  const spanDegrees = 360 / parameters.vaneCount;
  let subdivisions = Math.max(2, Math.ceil(spanDegrees / 0.25));
  if (subdivisions % 2 !== 0) subdivisions += 1;
  const stepRadians = ((spanDegrees / subdivisions) * Math.PI) / 180;
  const density = (index: number) => {
    const angle = startAngleDegrees + (index * spanDegrees) / subdivisions;
    const wallDistance = wallDistanceAtAngle(parameters, angle);
    return Math.max(0, 0.5 * (wallDistance ** 2 - rotorRadius ** 2));
  };
  let weighted = density(0) + density(subdivisions);
  for (let index = 1; index < subdivisions; index += 1) {
    weighted += (index % 2 === 0 ? 2 : 4) * density(index);
  }
  return (weighted * stepRadians) / 3;
}

function angularDistanceDegrees(left: number, right: number): number {
  return Math.abs(((left - right + 180) % 360) - 180);
}

function portIsOpen(
  parameters: RotaryVanePumpParameters,
  rotorAngleDegrees: number,
  portCenterDegrees: number,
  portWidth: number
): boolean {
  const chamberRadius = parameters.chamberDiameter / 2;
  const rotorRadius = parameters.rotorDiameter / 2;
  const portHalfSpan = ((portWidth / chamberRadius) * 180) / Math.PI / 2;
  const vaneHalfSpan =
    (Math.asin(Math.min(1, parameters.vaneThickness / (2 * rotorRadius))) *
      180) /
    Math.PI;
  return Array.from({ length: parameters.vaneCount }, (_value, index) =>
    angularDistanceDegrees(
      portCenterDegrees,
      rotorAngleDegrees + (index * 360) / parameters.vaneCount
    )
  ).every((distance) => distance > portHalfSpan + vaneHalfSpan);
}

function portCell(
  parameters: RotaryVanePumpParameters,
  rotorAngleDegrees: number,
  portCenterDegrees: number
): number {
  const span = 360 / parameters.vaneCount;
  return Math.floor(
    ((((portCenterDegrees - rotorAngleDegrees) % 360) + 360) % 360) / span
  );
}

export function validateRotaryVanePumpParameters(
  input: unknown
): RotaryVanePumpParameters {
  return rotaryVanePumpParametersSchema.parse(input);
}

export function diagnoseRotaryVanePump(
  input: RotaryVanePumpParameters
): RotaryVanePumpDiagnostics {
  const parameters = rotaryVanePumpParametersSchema.parse(input);
  const chamberRadius = parameters.chamberDiameter / 2;
  const rotorRadius = parameters.rotorDiameter / 2;
  const shaftRadius = parameters.shaftDiameter / 2;
  const minimumRadialClearance =
    chamberRadius - rotorRadius - parameters.eccentricity;
  const maximumRadialClearance =
    chamberRadius - rotorRadius + parameters.eccentricity;
  const minimumExtension =
    minimumRadialClearance - ROTARY_VANE_TIP_CLEARANCE_MM;
  const maximumExtension =
    maximumRadialClearance - ROTARY_VANE_TIP_CLEARANCE_MM;
  const inletAngularSpan = parameters.inletWidth / chamberRadius;
  const outletAngularSpan = parameters.outletWidth / chamberRadius;
  const vaneHalfSpan = Math.asin(
    Math.min(1, parameters.vaneThickness / (2 * rotorRadius))
  );
  const sealingMargin =
    Math.PI - (inletAngularSpan + outletAngularSpan) / 2 - 2 * vaneHalfSpan;
  const rotationAngles = Array.from({ length: 360 }, (_value, index) => index);
  const workingCellVolumes = rotationAngles.map(
    (angle) => workingCellAreaAtAngle(parameters, angle) * parameters.axialWidth
  );
  const workingCellMinimum = Math.min(...workingCellVolumes);
  const workingCellMaximum = Math.max(...workingCellVolumes);
  const inletOpenByAngle = rotationAngles.map((angle) =>
    portIsOpen(parameters, angle, 225, parameters.inletWidth)
  );
  const outletOpenByAngle = rotationAngles.map((angle) =>
    portIsOpen(parameters, angle, 45, parameters.outletWidth)
  );
  const sameChamberOpenSamples = rotationAngles.filter(
    (angle, index) =>
      inletOpenByAngle[index] === true &&
      outletOpenByAngle[index] === true &&
      portCell(parameters, angle, 225) === portCell(parameters, angle, 45)
  ).length;
  if (sameChamberOpenSamples !== 0) {
    throw new Error(
      "Validated double-vane geometry unexpectedly connects inlet and outlet to one chamber."
    );
  }
  const inletOpenSamples = inletOpenByAngle.filter(Boolean).length;
  const outletOpenSamples = outletOpenByAngle.filter(Boolean).length;

  return {
    method: {
      kind: "deterministic_analytic_geometry",
      deterministic: true,
      cfd: false
    },
    envelope: {
      basis: "internal_chamber_only",
      radialDiameterMm: parameters.chamberDiameter,
      axialWidthMm: parameters.axialWidth,
      boundingBoxVolumeMm3: round(
        parameters.chamberDiameter ** 2 * parameters.axialWidth
      )
    },
    volumes: {
      chamberCylinderMm3: round(
        Math.PI * chamberRadius ** 2 * parameters.axialWidth
      ),
      rotorCylinderMm3: round(
        Math.PI * rotorRadius ** 2 * parameters.axialWidth
      ),
      shaftCylinderMm3: round(
        Math.PI * shaftRadius ** 2 * parameters.axialWidth
      ),
      geometricVoidMm3: round(
        Math.PI *
          (chamberRadius ** 2 - rotorRadius ** 2) *
          parameters.axialWidth
      ),
      workingCellMinimumMm3: round(workingCellMinimum),
      workingCellMaximumMm3: round(workingCellMaximum),
      workingCellDeltaMm3: round(workingCellMaximum - workingCellMinimum),
      workingCellMethod: "deterministic_polar_quadrature"
    },
    rotation: {
      samplingStepDegrees: 1,
      samples: rotationAngles.length,
      collisionBoundaryAnglesDegrees: [],
      clearanceMethod: "analytic_circle_ray_intersection"
    },
    radialClearance: {
      minimumMm: round(minimumRadialClearance),
      maximumMm: round(maximumRadialClearance),
      status:
        minimumRadialClearance < parameters.vaneThickness / 2 ? "tight" : "pass"
    },
    vaneExtension: {
      minimumMm: round(minimumExtension),
      maximumMm: round(maximumExtension),
      strokeMm: round(2 * parameters.eccentricity),
      minimumRetainedInRotorMm: round(parameters.vaneHeight - maximumExtension),
      maximumRetainedInRotorMm: round(parameters.vaneHeight - minimumExtension),
      availableSlotDepthMm: round(rotorRadius - shaftRadius),
      controlledTipGapMinimumMm: ROTARY_VANE_TIP_CLEARANCE_MM,
      controlledTipGapMaximumMm: ROTARY_VANE_TIP_CLEARANCE_MM,
      contactState: "controlled_tip_gap"
    },
    ports: {
      inlet: {
        role: "inlet",
        chamberRegion: "expanding",
        centerAngleDegrees: 225,
        angularSpanDegrees: round((inletAngularSpan * 180) / Math.PI),
        idealizedOpeningAreaMm2: round(
          parameters.inletWidth * parameters.axialWidth
        ),
        connectivity: "connected",
        openSamples: inletOpenSamples,
        blockedByVaneSamples: rotationAngles.length - inletOpenSamples
      },
      outlet: {
        role: "outlet",
        chamberRegion: "contracting",
        centerAngleDegrees: 45,
        angularSpanDegrees: round((outletAngularSpan * 180) / Math.PI),
        idealizedOpeningAreaMm2: round(
          parameters.outletWidth * parameters.axialWidth
        ),
        connectivity: "connected",
        openSamples: outletOpenSamples,
        blockedByVaneSamples: rotationAngles.length - outletOpenSamples
      },
      isolatedFromEachOther: true,
      theoreticalSealingArcMarginDegrees: round(
        (sealingMargin * 180) / Math.PI
      ),
      sameChamberOpenSamples: 0
    },
    limitations: [
      "The envelope excludes housing wall thickness, bearings, seals, fasteners, and manufacturing allowances.",
      "Working-cell volume uses deterministic 0.25-degree Simpson polar quadrature over 360 one-degree rotor samples; it is not volumetric efficiency or pumping speed.",
      "Clearance, vane travel, and port connectivity are deterministic 2D analytic kinematics, not per-angle OCCT B-Rep collision checks or a flow solution.",
      "No CFD, leakage, thermal deformation, stress, lubrication, gas rarefaction, or pressure calculation is performed."
    ]
  };
}

function stableUuid(seed: string): string {
  const characters = sha256Hex(seed).slice(0, 32).split("");
  characters[12] = "5";
  const variant = Number.parseInt(characters[16] ?? "0", 16);
  characters[16] = ((variant & 0x3) | 0x8).toString(16);
  const hex = characters.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parameterDefinitions(
  parameters: RotaryVanePumpParameters,
  idFor: (semanticRef: string) => string
): ModelParameter[] {
  const housingWallThickness = Math.max(6, parameters.chamberDiameter * 0.09);
  const coverDimensions = [
    {
      semanticRef: "pump.parameter.cover-outer-diameter",
      name: "coverOuterDiameter",
      label: "Cover outer diameter",
      value: parameters.chamberDiameter + housingWallThickness * 2
    },
    {
      semanticRef: "pump.parameter.cover-thickness",
      name: "coverThickness",
      label: "Cover thickness",
      value: Math.max(5, housingWallThickness * 0.75)
    },
    {
      semanticRef: "pump.parameter.cover-bore-diameter",
      name: "coverBoreDiameter",
      label: "Cover shaft-clearance bore diameter",
      value: parameters.shaftDiameter + 2
    }
  ] as const;
  const definitions: Array<{
    key: keyof RotaryVanePumpParameters;
    label: string;
    parameterType: "length" | "integer";
    unit: "mm" | "count";
    minimum: number;
    maximum: number;
  }> = [
    {
      key: "chamberDiameter",
      label: "Chamber diameter",
      parameterType: "length",
      unit: "mm",
      minimum: 1,
      maximum: 100_000
    },
    {
      key: "rotorDiameter",
      label: "Rotor diameter",
      parameterType: "length",
      unit: "mm",
      minimum: 1,
      maximum: 100_000
    },
    {
      key: "eccentricity",
      label: "Rotor eccentricity",
      parameterType: "length",
      unit: "mm",
      minimum: 0.001,
      maximum: 100_000
    },
    {
      key: "axialWidth",
      label: "Axial width",
      parameterType: "length",
      unit: "mm",
      minimum: 1,
      maximum: 100_000
    },
    {
      key: "vaneCount",
      label: "Vane count",
      parameterType: "integer",
      unit: "count",
      minimum: 2,
      maximum: 2
    },
    {
      key: "vaneThickness",
      label: "Vane thickness",
      parameterType: "length",
      unit: "mm",
      minimum: 0.001,
      maximum: 100_000
    },
    {
      key: "vaneHeight",
      label: "Vane radial height",
      parameterType: "length",
      unit: "mm",
      minimum: 0.001,
      maximum: 100_000
    },
    {
      key: "shaftDiameter",
      label: "Shaft diameter",
      parameterType: "length",
      unit: "mm",
      minimum: 0.001,
      maximum: 100_000
    },
    {
      key: "inletWidth",
      label: "Inlet width",
      parameterType: "length",
      unit: "mm",
      minimum: 0.001,
      maximum: 100_000
    },
    {
      key: "outletWidth",
      label: "Outlet width",
      parameterType: "length",
      unit: "mm",
      minimum: 0.001,
      maximum: 100_000
    }
  ];

  const templateParameters = definitions.map((definition) => {
    const semanticRef = `pump.parameter.${definition.key
      .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
      .toLowerCase()}`;
    return {
      id: idFor(semanticRef),
      semanticRef,
      name: definition.key,
      label: definition.label,
      parameterType: definition.parameterType,
      unit: definition.unit,
      value: parameters[definition.key],
      minimum: definition.minimum,
      maximum: definition.maximum,
      source: "template" as const,
      editable: definition.key !== "vaneCount"
    };
  });

  return [
    ...templateParameters,
    ...coverDimensions.map((definition) => ({
      id: idFor(definition.semanticRef),
      semanticRef: definition.semanticRef,
      name: definition.name,
      label: definition.label,
      parameterType: "length" as const,
      unit: "mm" as const,
      value: definition.value,
      minimum: 0.001,
      maximum: 200_000,
      source: "derived" as const,
      editable: false
    }))
  ];
}

export type RotaryVanePumpTemplateOptions = {
  documentId?: string;
  revisionId?: string;
  name?: string;
  parameters?: Partial<RotaryVanePumpParameters>;
};

export function createRotaryVanePumpTemplate(
  options: RotaryVanePumpTemplateOptions = {}
): ModelDocument {
  const documentId = modelingUuidSchema.parse(
    options.documentId ?? stableUuid(`${ROTARY_VANE_PUMP_TEMPLATE_ID}:document`)
  );
  const revisionId = modelingUuidSchema.parse(
    options.revisionId ?? stableUuid(`${documentId}:revision:0`)
  );
  const parameters = rotaryVanePumpParametersSchema.parse({
    ...DEFAULT_ROTARY_VANE_PUMP_PARAMETERS,
    ...options.parameters
  });
  const idFor = (semanticRef: string) =>
    stableUuid(`${documentId}:${semanticRef}`);
  const parameterList = parameterDefinitions(parameters, idFor);
  const refs = new Map<string, ModelReference>();
  const registerRef = (semanticRef: string): ModelReference => {
    const reference = { id: idFor(semanticRef), semanticRef };
    refs.set(semanticRef, reference);
    return reference;
  };
  for (const parameter of parameterList) {
    refs.set(parameter.semanticRef, {
      id: parameter.id,
      semanticRef: parameter.semanticRef
    });
  }
  const ref = (semanticRef: string): ModelReference => {
    const reference = refs.get(semanticRef);
    if (!reference) {
      throw new Error(`Template reference was not registered: ${semanticRef}`);
    }
    return reference;
  };

  const chamberCenter = registerRef("pump.sketch.cross-section.chamber-center");
  const rotorCenter = registerRef("pump.sketch.cross-section.rotor-center");
  const chamberCircle = registerRef("pump.sketch.cross-section.chamber-circle");
  const rotorCircle = registerRef("pump.sketch.cross-section.rotor-circle");
  const shaftCircle = registerRef("pump.sketch.cross-section.shaft-circle");
  const vaneProfile = registerRef("pump.sketch.cross-section.vane-profile");
  const frontCoverOuterCenter = registerRef(
    "pump.sketch.front-cover-profile.outer-center"
  );
  const frontCoverBoreCenter = registerRef(
    "pump.sketch.front-cover-profile.bore-center"
  );
  const frontCoverOuterCircle = registerRef(
    "pump.sketch.front-cover-profile.outer-circle"
  );
  const frontCoverBoreCircle = registerRef(
    "pump.sketch.front-cover-profile.shaft-clearance-circle"
  );
  const rearCoverOuterCenter = registerRef(
    "pump.sketch.rear-cover-profile.outer-center"
  );
  const rearCoverBoreCenter = registerRef(
    "pump.sketch.rear-cover-profile.bore-center"
  );
  const rearCoverOuterCircle = registerRef(
    "pump.sketch.rear-cover-profile.outer-circle"
  );
  const rearCoverBoreCircle = registerRef(
    "pump.sketch.rear-cover-profile.shaft-clearance-circle"
  );

  const constraintRefs = [
    "pump.constraint.chamber-center-fixed",
    "pump.constraint.centers-horizontal",
    "pump.constraint.rotor-eccentricity",
    "pump.constraint.chamber-diameter",
    "pump.constraint.rotor-diameter",
    "pump.constraint.shaft-diameter",
    "pump.constraint.vane-profile-fixed"
  ].map(registerRef);
  const coverConstraintRefs = {
    frontOuterCenterFixed: registerRef(
      "pump.constraint.front-cover-outer-center-fixed"
    ),
    frontCentersHorizontal: registerRef(
      "pump.constraint.front-cover-centers-horizontal"
    ),
    frontBoreEccentricity: registerRef(
      "pump.constraint.front-cover-bore-eccentricity"
    ),
    frontOuterDiameter: registerRef(
      "pump.constraint.front-cover-outer-diameter"
    ),
    frontBoreDiameter: registerRef("pump.constraint.front-cover-bore-diameter"),
    rearOuterCenterFixed: registerRef(
      "pump.constraint.rear-cover-outer-center-fixed"
    ),
    rearCentersHorizontal: registerRef(
      "pump.constraint.rear-cover-centers-horizontal"
    ),
    rearBoreEccentricity: registerRef(
      "pump.constraint.rear-cover-bore-eccentricity"
    ),
    rearOuterDiameter: registerRef("pump.constraint.rear-cover-outer-diameter"),
    rearBoreDiameter: registerRef("pump.constraint.rear-cover-bore-diameter")
  };

  const featureRefs = {
    chamber: registerRef("pump.feature.chamber-volume"),
    rotor: registerRef("pump.feature.rotor"),
    shaft: registerRef("pump.feature.shaft"),
    vane: registerRef("pump.feature.vane"),
    vanePattern: registerRef("pump.feature.vane-pattern"),
    inlet: registerRef("pump.feature.inlet-port"),
    outlet: registerRef("pump.feature.outlet-port"),
    frontCover: registerRef("pump.feature.front-cover"),
    rearCover: registerRef("pump.feature.rear-cover")
  };
  const componentRefs = {
    chamber: registerRef("pump.component.chamber-and-ports"),
    rotating: registerRef("pump.component.rotating-group"),
    frontCover: registerRef("pump.component.front-cover"),
    rearCover: registerRef("pump.component.rear-cover")
  };
  const assemblyRefs = {
    chamberFixed: registerRef("pump.assembly.chamber-fixed"),
    eccentricOffset: registerRef("pump.assembly.rotor-eccentric-offset"),
    frontCoverToChamber: registerRef("pump.assembly.front-cover-to-chamber"),
    rearCoverAxialOffset: registerRef("pump.assembly.rear-cover-axial-offset")
  };

  const document: ModelDocument = {
    version: MODELING_PROTOCOL_VERSION,
    id: documentId,
    revision: 0,
    revisionId,
    name: options.name?.trim() || "Single-stage double-vane rotary pump",
    unitSystem: "mm-deg",
    parameters: parameterList,
    sketches: [
      {
        id: idFor("pump.sketch.cross-section"),
        semanticRef: "pump.sketch.cross-section",
        name: "Pump cross-section",
        plane: "xy",
        entities: [
          {
            ...chamberCenter,
            entityKind: "point",
            construction: true,
            x: 0,
            y: 0
          },
          {
            ...rotorCenter,
            entityKind: "point",
            construction: true,
            x: parameters.eccentricity,
            y: 0
          },
          {
            ...chamberCircle,
            entityKind: "circle",
            construction: false,
            centerPointRef: chamberCenter,
            diameterParameterRef: ref("pump.parameter.chamber-diameter")
          },
          {
            ...rotorCircle,
            entityKind: "circle",
            construction: false,
            centerPointRef: rotorCenter,
            diameterParameterRef: ref("pump.parameter.rotor-diameter")
          },
          {
            ...shaftCircle,
            entityKind: "circle",
            construction: false,
            centerPointRef: rotorCenter,
            diameterParameterRef: ref("pump.parameter.shaft-diameter")
          },
          {
            ...vaneProfile,
            entityKind: "rectangle",
            construction: false,
            centerPointRef: rotorCenter,
            widthParameterRef: ref("pump.parameter.vane-thickness"),
            heightParameterRef: ref("pump.parameter.vane-height"),
            rotationDegrees: 0
          }
        ],
        constraints: [
          {
            ...constraintRefs[0]!,
            name: "Fix chamber center",
            constraintKind: "fixed",
            targetRefs: [chamberCenter],
            status: "satisfied"
          },
          {
            ...constraintRefs[1]!,
            name: "Align centers horizontally",
            constraintKind: "horizontal",
            targetRefs: [chamberCenter, rotorCenter],
            status: "satisfied"
          },
          {
            ...constraintRefs[2]!,
            name: "Set rotor eccentricity",
            constraintKind: "distance",
            targetRefs: [chamberCenter, rotorCenter],
            parameterRef: ref("pump.parameter.eccentricity"),
            status: "satisfied"
          },
          {
            ...constraintRefs[3]!,
            name: "Set chamber diameter",
            constraintKind: "diameter",
            targetRefs: [chamberCircle],
            parameterRef: ref("pump.parameter.chamber-diameter"),
            status: "satisfied"
          },
          {
            ...constraintRefs[4]!,
            name: "Set rotor diameter",
            constraintKind: "diameter",
            targetRefs: [rotorCircle],
            parameterRef: ref("pump.parameter.rotor-diameter"),
            status: "satisfied"
          },
          {
            ...constraintRefs[5]!,
            name: "Set shaft diameter",
            constraintKind: "diameter",
            targetRefs: [shaftCircle],
            parameterRef: ref("pump.parameter.shaft-diameter"),
            status: "satisfied"
          },
          {
            ...constraintRefs[6]!,
            name: "Fix vane profile orientation",
            constraintKind: "fixed",
            targetRefs: [vaneProfile],
            status: "satisfied"
          }
        ],
        solveStatus: "fully_constrained",
        suppressed: false
      },
      {
        id: idFor("pump.sketch.front-cover-profile"),
        semanticRef: "pump.sketch.front-cover-profile",
        name: "Front cover annular profile",
        plane: "xy",
        entities: [
          {
            ...frontCoverOuterCenter,
            entityKind: "point",
            construction: true,
            x: 0,
            y: 0
          },
          {
            ...frontCoverBoreCenter,
            entityKind: "point",
            construction: true,
            x: parameters.eccentricity,
            y: 0
          },
          {
            ...frontCoverOuterCircle,
            entityKind: "circle",
            construction: false,
            centerPointRef: frontCoverOuterCenter,
            diameterParameterRef: ref("pump.parameter.cover-outer-diameter")
          },
          {
            ...frontCoverBoreCircle,
            entityKind: "circle",
            construction: false,
            centerPointRef: frontCoverBoreCenter,
            diameterParameterRef: ref("pump.parameter.cover-bore-diameter")
          }
        ],
        constraints: [
          {
            ...coverConstraintRefs.frontOuterCenterFixed,
            name: "Fix front cover outer center",
            constraintKind: "fixed",
            targetRefs: [frontCoverOuterCenter],
            status: "satisfied"
          },
          {
            ...coverConstraintRefs.frontCentersHorizontal,
            name: "Align front cover centers horizontally",
            constraintKind: "horizontal",
            targetRefs: [frontCoverOuterCenter, frontCoverBoreCenter],
            status: "satisfied"
          },
          {
            ...coverConstraintRefs.frontBoreEccentricity,
            name: "Set front cover bore eccentricity",
            constraintKind: "distance",
            targetRefs: [frontCoverOuterCenter, frontCoverBoreCenter],
            parameterRef: ref("pump.parameter.eccentricity"),
            status: "satisfied"
          },
          {
            ...coverConstraintRefs.frontOuterDiameter,
            name: "Set front cover outer diameter",
            constraintKind: "diameter",
            targetRefs: [frontCoverOuterCircle],
            parameterRef: ref("pump.parameter.cover-outer-diameter"),
            status: "satisfied"
          },
          {
            ...coverConstraintRefs.frontBoreDiameter,
            name: "Set front cover bore diameter",
            constraintKind: "diameter",
            targetRefs: [frontCoverBoreCircle],
            parameterRef: ref("pump.parameter.cover-bore-diameter"),
            status: "satisfied"
          }
        ],
        solveStatus: "fully_constrained",
        suppressed: false
      },
      {
        id: idFor("pump.sketch.rear-cover-profile"),
        semanticRef: "pump.sketch.rear-cover-profile",
        name: "Rear cover annular profile",
        plane: "xy",
        entities: [
          {
            ...rearCoverOuterCenter,
            entityKind: "point",
            construction: true,
            x: 0,
            y: 0
          },
          {
            ...rearCoverBoreCenter,
            entityKind: "point",
            construction: true,
            x: parameters.eccentricity,
            y: 0
          },
          {
            ...rearCoverOuterCircle,
            entityKind: "circle",
            construction: false,
            centerPointRef: rearCoverOuterCenter,
            diameterParameterRef: ref("pump.parameter.cover-outer-diameter")
          },
          {
            ...rearCoverBoreCircle,
            entityKind: "circle",
            construction: false,
            centerPointRef: rearCoverBoreCenter,
            diameterParameterRef: ref("pump.parameter.cover-bore-diameter")
          }
        ],
        constraints: [
          {
            ...coverConstraintRefs.rearOuterCenterFixed,
            name: "Fix rear cover outer center",
            constraintKind: "fixed",
            targetRefs: [rearCoverOuterCenter],
            status: "satisfied"
          },
          {
            ...coverConstraintRefs.rearCentersHorizontal,
            name: "Align rear cover centers horizontally",
            constraintKind: "horizontal",
            targetRefs: [rearCoverOuterCenter, rearCoverBoreCenter],
            status: "satisfied"
          },
          {
            ...coverConstraintRefs.rearBoreEccentricity,
            name: "Set rear cover bore eccentricity",
            constraintKind: "distance",
            targetRefs: [rearCoverOuterCenter, rearCoverBoreCenter],
            parameterRef: ref("pump.parameter.eccentricity"),
            status: "satisfied"
          },
          {
            ...coverConstraintRefs.rearOuterDiameter,
            name: "Set rear cover outer diameter",
            constraintKind: "diameter",
            targetRefs: [rearCoverOuterCircle],
            parameterRef: ref("pump.parameter.cover-outer-diameter"),
            status: "satisfied"
          },
          {
            ...coverConstraintRefs.rearBoreDiameter,
            name: "Set rear cover bore diameter",
            constraintKind: "diameter",
            targetRefs: [rearCoverBoreCircle],
            parameterRef: ref("pump.parameter.cover-bore-diameter"),
            status: "satisfied"
          }
        ],
        solveStatus: "fully_constrained",
        suppressed: false
      }
    ],
    features: [
      {
        ...featureRefs.chamber,
        name: "Chamber reference volume",
        featureKind: "extrude",
        profileRefs: [chamberCircle],
        distanceParameterRef: ref("pump.parameter.axial-width"),
        direction: "symmetric",
        operation: "new_body",
        suppressed: false
      },
      {
        ...featureRefs.rotor,
        name: "Rotor",
        featureKind: "extrude",
        profileRefs: [rotorCircle],
        distanceParameterRef: ref("pump.parameter.axial-width"),
        direction: "symmetric",
        operation: "new_body",
        suppressed: false
      },
      {
        ...featureRefs.shaft,
        name: "Shaft",
        featureKind: "extrude",
        profileRefs: [shaftCircle],
        distanceParameterRef: ref("pump.parameter.axial-width"),
        direction: "symmetric",
        operation: "new_body",
        suppressed: false
      },
      {
        ...featureRefs.vane,
        name: "Master vane",
        featureKind: "extrude",
        profileRefs: [vaneProfile],
        distanceParameterRef: ref("pump.parameter.axial-width"),
        direction: "symmetric",
        operation: "new_body",
        suppressed: false
      },
      {
        ...featureRefs.vanePattern,
        name: "Double-vane pattern",
        featureKind: "circular_pattern",
        sourceFeatureRef: featureRefs.vane,
        axisOrigin: [parameters.eccentricity, 0, 0],
        axisDirection: [0, 0, 1],
        countParameterRef: ref("pump.parameter.vane-count"),
        totalAngleDegrees: 360,
        suppressed: false
      },
      {
        ...featureRefs.inlet,
        name: "Inlet port",
        featureKind: "port",
        role: "inlet",
        chamberProfileRef: chamberCircle,
        widthParameterRef: ref("pump.parameter.inlet-width"),
        axialWidthParameterRef: ref("pump.parameter.axial-width"),
        centerAngleDegrees: 225,
        operation: "cut",
        suppressed: false
      },
      {
        ...featureRefs.outlet,
        name: "Outlet port",
        featureKind: "port",
        role: "outlet",
        chamberProfileRef: chamberCircle,
        widthParameterRef: ref("pump.parameter.outlet-width"),
        axialWidthParameterRef: ref("pump.parameter.axial-width"),
        centerAngleDegrees: 45,
        operation: "cut",
        suppressed: false
      },
      {
        ...featureRefs.frontCover,
        name: "Front cover",
        featureKind: "extrude",
        profileRefs: [frontCoverOuterCircle, frontCoverBoreCircle],
        distanceParameterRef: ref("pump.parameter.cover-thickness"),
        direction: "reverse",
        operation: "new_body",
        suppressed: false
      },
      {
        ...featureRefs.rearCover,
        name: "Rear cover",
        featureKind: "extrude",
        profileRefs: [rearCoverOuterCircle, rearCoverBoreCircle],
        distanceParameterRef: ref("pump.parameter.cover-thickness"),
        direction: "normal",
        operation: "new_body",
        suppressed: false
      }
    ],
    components: [
      {
        ...componentRefs.chamber,
        name: "Chamber and ports",
        featureRefs: [
          featureRefs.chamber,
          featureRefs.inlet,
          featureRefs.outlet
        ],
        transform: {
          translationMm: [0, 0, 0],
          rotationDegrees: [0, 0, 0]
        },
        suppressed: false
      },
      {
        ...componentRefs.rotating,
        name: "Rotating group",
        featureRefs: [
          featureRefs.rotor,
          featureRefs.shaft,
          featureRefs.vanePattern
        ],
        transform: {
          translationMm: [parameters.eccentricity, 0, 0],
          rotationDegrees: [0, 0, 0]
        },
        suppressed: false
      },
      {
        ...componentRefs.frontCover,
        name: "Front cover",
        featureRefs: [featureRefs.frontCover],
        transform: {
          translationMm: [0, 0, 0],
          rotationDegrees: [0, 0, 0]
        },
        suppressed: false
      },
      {
        ...componentRefs.rearCover,
        name: "Rear cover",
        featureRefs: [featureRefs.rearCover],
        transform: {
          translationMm: [0, 0, parameters.axialWidth],
          rotationDegrees: [0, 0, 0]
        },
        suppressed: false
      }
    ],
    assemblyConstraints: [
      {
        ...assemblyRefs.chamberFixed,
        name: "Fix chamber",
        constraintKind: "fixed",
        componentRefs: [componentRefs.chamber],
        status: "satisfied"
      },
      {
        ...assemblyRefs.eccentricOffset,
        name: "Set rotating-group eccentricity",
        constraintKind: "distance",
        componentRefs: [componentRefs.chamber, componentRefs.rotating],
        parameterRef: ref("pump.parameter.eccentricity"),
        status: "satisfied"
      },
      {
        ...assemblyRefs.frontCoverToChamber,
        name: "Mate front cover to chamber front datum",
        constraintKind: "coincident",
        componentRefs: [componentRefs.chamber, componentRefs.frontCover],
        status: "satisfied"
      },
      {
        ...assemblyRefs.rearCoverAxialOffset,
        name: "Offset rear cover to chamber rear datum",
        constraintKind: "distance",
        componentRefs: [componentRefs.chamber, componentRefs.rearCover],
        parameterRef: ref("pump.parameter.axial-width"),
        status: "satisfied"
      }
    ],
    metadata: {
      description:
        "Original OpenVac V1 idealized single-stage, double-vane rotary pump template.",
      template: {
        templateId: ROTARY_VANE_PUMP_TEMPLATE_ID,
        templateVersion: ROTARY_VANE_PUMP_TEMPLATE_VERSION
      },
      tags: ["pump.rotary-vane", "pump.single-stage", "pump.double-vane"]
    }
  };

  return modelDocumentSchema.parse(document);
}
