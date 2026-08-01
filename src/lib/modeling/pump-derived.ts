import { sha256Hex } from "./canonical";
import { applyOperationBatch } from "./operations";
import {
  modelOperationBatchSchema,
  type Component,
  type Feature,
  type ModelDocument,
  type ModelOperation,
  type ModelOperationBatch,
  type ModelParameter,
  type Sketch
} from "@/types/modeling";

const ROTARY_VANE_TEMPLATE_ID =
  "template.rotary-vane-pump.single-stage-double-vane";

const REFS = {
  chamberDiameter: "pump.parameter.chamber-diameter",
  shaftDiameter: "pump.parameter.shaft-diameter",
  eccentricity: "pump.parameter.eccentricity",
  axialWidth: "pump.parameter.axial-width",
  coverOuterDiameter: "pump.parameter.cover-outer-diameter",
  coverThickness: "pump.parameter.cover-thickness",
  coverBoreDiameter: "pump.parameter.cover-bore-diameter",
  crossSectionSketch: "pump.sketch.cross-section",
  rotorCenter: "pump.sketch.cross-section.rotor-center",
  frontCoverSketch: "pump.sketch.front-cover-profile",
  frontCoverBoreCenter: "pump.sketch.front-cover-profile.bore-center",
  rearCoverSketch: "pump.sketch.rear-cover-profile",
  rearCoverBoreCenter: "pump.sketch.rear-cover-profile.bore-center",
  vanePattern: "pump.feature.vane-pattern",
  rotatingGroup: "pump.component.rotating-group",
  rearCover: "pump.component.rear-cover"
} as const;

export class PumpTemplateDerivedStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PumpTemplateDerivedStateError";
  }
}

/**
 * Appends every deterministic field implied by an editable pump parameter.
 * The additions remain visible ModelOperation entries: neither the client nor
 * the server relies on hidden mutation, and AI/manual plans share this exact
 * expansion before an authoritative kernel dry-run.
 */
export function expandRotaryVanePumpDerivedOperations(
  document: ModelDocument,
  batch: ModelOperationBatch
): ModelOperationBatch {
  if (document.metadata?.template?.templateId !== ROTARY_VANE_TEMPLATE_ID) {
    return batch;
  }

  const changedRefs = new Set(
    batch.operations.flatMap((operation) =>
      operation.kind === "update" && operation.collection === "parameters"
        ? [operation.target.semanticRef]
        : []
    )
  );
  const chamberChanged = changedRefs.has(REFS.chamberDiameter);
  const shaftChanged = changedRefs.has(REFS.shaftDiameter);
  const eccentricityChanged = changedRefs.has(REFS.eccentricity);
  const axialWidthChanged = changedRefs.has(REFS.axialWidth);
  if (
    !chamberChanged &&
    !shaftChanged &&
    !eccentricityChanged &&
    !axialWidthChanged
  ) {
    return batch;
  }

  assertRequiredDerivedState(document, {
    chamberChanged,
    shaftChanged,
    eccentricityChanged,
    axialWidthChanged
  });
  const interim = applyOperationBatch(document, batch);
  const additions: ModelOperation[] = [];
  let operationIndex = 0;
  const nextOperationId = (semanticRef: string) =>
    stableUuid(`${batch.id}:derived:${operationIndex++}:${semanticRef}`);

  if (chamberChanged) {
    const chamberDiameter = requiredParameter(
      interim,
      REFS.chamberDiameter
    ).value;
    const housingWallThickness = Math.max(6, chamberDiameter * 0.09);
    stageParameter(
      interim,
      additions,
      REFS.coverOuterDiameter,
      chamberDiameter + housingWallThickness * 2,
      nextOperationId
    );
    stageParameter(
      interim,
      additions,
      REFS.coverThickness,
      Math.max(5, housingWallThickness * 0.75),
      nextOperationId
    );
  }

  if (shaftChanged) {
    const shaftDiameter = requiredParameter(interim, REFS.shaftDiameter).value;
    stageParameter(
      interim,
      additions,
      REFS.coverBoreDiameter,
      shaftDiameter + 2,
      nextOperationId
    );
  }

  if (eccentricityChanged) {
    const eccentricity = requiredParameter(interim, REFS.eccentricity).value;
    stagePointX(
      interim,
      additions,
      REFS.crossSectionSketch,
      REFS.rotorCenter,
      eccentricity,
      nextOperationId
    );
    stagePointX(
      interim,
      additions,
      REFS.frontCoverSketch,
      REFS.frontCoverBoreCenter,
      eccentricity,
      nextOperationId
    );
    stagePointX(
      interim,
      additions,
      REFS.rearCoverSketch,
      REFS.rearCoverBoreCenter,
      eccentricity,
      nextOperationId
    );
    stagePatternAxis(interim, additions, eccentricity, nextOperationId);
    stageRotatingGroup(interim, additions, eccentricity, nextOperationId);
  }

  if (axialWidthChanged) {
    const axialWidth = requiredParameter(interim, REFS.axialWidth).value;
    stageRearCover(interim, additions, axialWidth, nextOperationId);
  }

  const expanded = modelOperationBatchSchema.parse({
    ...batch,
    operations: [...batch.operations, ...additions]
  });
  applyOperationBatch(document, expanded);
  return expanded;
}

function assertRequiredDerivedState(
  document: ModelDocument,
  changes: {
    chamberChanged: boolean;
    shaftChanged: boolean;
    eccentricityChanged: boolean;
    axialWidthChanged: boolean;
  }
) {
  if (changes.chamberChanged) {
    requiredParameter(document, REFS.chamberDiameter);
    requiredParameter(document, REFS.coverOuterDiameter);
    requiredParameter(document, REFS.coverThickness);
  }
  if (changes.shaftChanged) {
    requiredParameter(document, REFS.shaftDiameter);
    requiredParameter(document, REFS.coverBoreDiameter);
  }
  if (changes.axialWidthChanged) {
    requiredParameter(document, REFS.axialWidth);
    if (
      !document.components.some(
        (component) => component.semanticRef === REFS.rearCover
      )
    ) {
      throw inconsistent(`缺少派生组件引用 ${REFS.rearCover}`);
    }
  }
  if (!changes.eccentricityChanged) return;
  requiredParameter(document, REFS.eccentricity);
  for (const [sketchRef, pointRef] of [
    [REFS.crossSectionSketch, REFS.rotorCenter],
    [REFS.frontCoverSketch, REFS.frontCoverBoreCenter],
    [REFS.rearCoverSketch, REFS.rearCoverBoreCenter]
  ] as const) {
    const point = requiredSketch(document, sketchRef).entities.find(
      (entity) => entity.semanticRef === pointRef
    );
    if (!point || point.entityKind !== "point") {
      throw inconsistent(`缺少派生点引用 ${pointRef}`);
    }
  }
  const pattern = document.features.find(
    (feature) => feature.semanticRef === REFS.vanePattern
  );
  if (!pattern || pattern.featureKind !== "circular_pattern") {
    throw inconsistent(`缺少派生特征引用 ${REFS.vanePattern}`);
  }
  if (
    !document.components.some(
      (component) => component.semanticRef === REFS.rotatingGroup
    )
  ) {
    throw inconsistent(`缺少派生组件引用 ${REFS.rotatingGroup}`);
  }
}

function requiredParameter(document: ModelDocument, semanticRef: string) {
  const parameter = document.parameters.find(
    (candidate) => candidate.semanticRef === semanticRef
  );
  if (!parameter) {
    throw inconsistent(`缺少派生参数引用 ${semanticRef}`);
  }
  return parameter;
}

function stageParameter(
  document: ModelDocument,
  operations: ModelOperation[],
  semanticRef: string,
  value: number,
  operationId: (semanticRef: string) => string
) {
  const parameter = requiredParameter(document, semanticRef);
  if (parameter.editable || parameter.source !== "derived") {
    throw inconsistent(`派生参数 ${semanticRef} 的只读来源已漂移`);
  }
  if (sameNumber(parameter.value, value)) return;
  operations.push({
    operationId: operationId(semanticRef),
    kind: "update",
    collection: "parameters",
    target: reference(parameter),
    changes: { value, source: "derived" }
  });
}

function stagePointX(
  document: ModelDocument,
  operations: ModelOperation[],
  sketchRef: string,
  pointRef: string,
  x: number,
  operationId: (semanticRef: string) => string
) {
  const sketch = requiredSketch(document, sketchRef);
  const point = sketch.entities.find(
    (entity) => entity.semanticRef === pointRef
  );
  if (!point || point.entityKind !== "point") {
    throw inconsistent(`缺少派生点引用 ${pointRef}`);
  }
  if (sameNumber(point.x, x) && sameNumber(point.y, 0)) return;
  operations.push({
    operationId: operationId(pointRef),
    kind: "update",
    collection: "sketches",
    target: reference(sketch),
    changes: {
      entities: sketch.entities.map((entity) =>
        entity.id === point.id && entity.semanticRef === point.semanticRef
          ? { ...point, x, y: 0 }
          : entity
      )
    }
  });
}

function stagePatternAxis(
  document: ModelDocument,
  operations: ModelOperation[],
  eccentricity: number,
  operationId: (semanticRef: string) => string
) {
  const feature = document.features.find(
    (candidate) => candidate.semanticRef === REFS.vanePattern
  );
  if (!feature || feature.featureKind !== "circular_pattern") {
    throw inconsistent(`缺少派生特征引用 ${REFS.vanePattern}`);
  }
  const axisOrigin: [number, number, number] = [
    eccentricity,
    feature.axisOrigin[1],
    feature.axisOrigin[2]
  ];
  if (sameVector(feature.axisOrigin, axisOrigin)) return;
  operations.push({
    operationId: operationId(REFS.vanePattern),
    kind: "update",
    collection: "features",
    target: reference(feature),
    changes: { axisOrigin }
  });
}

function stageRotatingGroup(
  document: ModelDocument,
  operations: ModelOperation[],
  eccentricity: number,
  operationId: (semanticRef: string) => string
) {
  const component = document.components.find(
    (candidate) => candidate.semanticRef === REFS.rotatingGroup
  );
  if (!component) {
    throw inconsistent(`缺少派生组件引用 ${REFS.rotatingGroup}`);
  }
  const translationMm: [number, number, number] = [
    eccentricity,
    component.transform.translationMm[1],
    component.transform.translationMm[2]
  ];
  if (sameVector(component.transform.translationMm, translationMm)) return;
  operations.push({
    operationId: operationId(REFS.rotatingGroup),
    kind: "update",
    collection: "components",
    target: reference(component),
    changes: {
      transform: { ...component.transform, translationMm }
    }
  });
}

function stageRearCover(
  document: ModelDocument,
  operations: ModelOperation[],
  axialWidth: number,
  operationId: (semanticRef: string) => string
) {
  const component = document.components.find(
    (candidate) => candidate.semanticRef === REFS.rearCover
  );
  if (!component) {
    throw inconsistent(`缺少派生组件引用 ${REFS.rearCover}`);
  }
  const translationMm: [number, number, number] = [
    component.transform.translationMm[0],
    component.transform.translationMm[1],
    axialWidth
  ];
  if (sameVector(component.transform.translationMm, translationMm)) return;
  operations.push({
    operationId: operationId(REFS.rearCover),
    kind: "update",
    collection: "components",
    target: reference(component),
    changes: {
      transform: { ...component.transform, translationMm }
    }
  });
}

function requiredSketch(document: ModelDocument, semanticRef: string) {
  const sketch = document.sketches.find(
    (candidate) => candidate.semanticRef === semanticRef
  );
  if (!sketch) throw inconsistent(`缺少派生草图引用 ${semanticRef}`);
  return sketch;
}

function reference(value: ModelParameter | Sketch | Feature | Component): {
  id: string;
  semanticRef: string;
} {
  return { id: value.id, semanticRef: value.semanticRef };
}

function sameNumber(left: number, right: number) {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(right) * 1e-12);
}

function sameVector(
  left: readonly number[],
  right: readonly number[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => sameNumber(value, right[index]!))
  );
}

function stableUuid(seed: string) {
  const characters = sha256Hex(seed).slice(0, 32).split("");
  characters[12] = "5";
  const variant = Number.parseInt(characters[16] ?? "0", 16);
  characters[16] = ((variant & 0x3) | 0x8).toString(16);
  const hex = characters.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function inconsistent(detail: string) {
  return new PumpTemplateDerivedStateError(
    `旋片泵模板派生状态不完整（${detail}），已拒绝写入以避免参数、几何和装配状态漂移。`
  );
}
