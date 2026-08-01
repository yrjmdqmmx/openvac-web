import { describe, expect, it } from "vitest";

import {
  canonicalStringify,
  hashCanonicalSpec,
  hashModelDocument,
  hashModelingPlanDraft,
  sha256Hex
} from "@/lib/modeling/canonical";
import {
  applyOperationBatch,
  ModelingSemanticError
} from "@/lib/modeling/operations";
import {
  MODELING_PROTOCOL_VERSION,
  engineBuildResultSchema,
  featureSchema,
  jobEventSchema,
  modelingPlanDraftSchema,
  modelDocumentSchema,
  modelOperationBatchSchema,
  semanticFaceSelectorSchema,
  semanticTopologySelectorSchema,
  sketchConstraintSchema,
  type Feature,
  type ModelDocument,
  type ModelParameter,
  type ModelReference
} from "@/types/modeling";
import { createRotaryVanePumpTemplate } from "@/server/modeling/domain";

const BATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function reference(value: { id: string; semanticRef: string }): ModelReference {
  return { id: value.id, semanticRef: value.semanticRef };
}

function featureParameterDocument(): ModelDocument {
  const document = structuredClone(createRotaryVanePumpTemplate());
  const source = document.features[0]!;
  const point = document.sketches[0]!.entities.find(
    (entity) => entity.entityKind === "point"
  )!;
  const profile = document.sketches[0]!.entities.find(
    (entity) => entity.entityKind === "circle"
  )!;
  const length = document.parameters.find(
    (parameter) => parameter.name === "vaneThickness"
  )!;
  const count = document.parameters.find(
    (parameter) => parameter.name === "vaneCount"
  )!;
  const angle: ModelParameter = {
    id: "75000000-0000-4000-8000-000000000001",
    semanticRef: "pump.parameter.protocol-test-angle",
    name: "protocolTestAngle",
    label: "Protocol test angle",
    parameterType: "angle",
    unit: "deg",
    value: 90,
    minimum: 1,
    maximum: 360,
    source: "user",
    editable: true
  };
  document.parameters.push(angle);

  const sourceRef = reference(source);
  const pointRef = reference(point);
  const profileRef = reference(profile);
  const lengthRef = reference(length);
  const countRef = reference(count);
  const features: Feature[] = [
    {
      id: "75000000-0000-4000-8000-000000000002",
      semanticRef: "pump.feature.protocol-test-revolve",
      name: "Protocol test revolve",
      featureKind: "revolve",
      profileRefs: [profileRef],
      axisRef: pointRef,
      angleParameterRef: reference(angle),
      operation: "new_body",
      suppressed: false
    },
    {
      id: "75000000-0000-4000-8000-000000000003",
      semanticRef: "pump.feature.protocol-test-hole",
      name: "Protocol test hole",
      featureKind: "hole",
      placement: { placementKind: "point", pointRef },
      diameterParameterRef: lengthRef,
      termination: "blind",
      depthParameterRef: lengthRef,
      operation: "cut",
      suppressed: false
    },
    {
      id: "75000000-0000-4000-8000-000000000004",
      semanticRef: "pump.feature.protocol-test-fillet",
      name: "Protocol test fillet",
      featureKind: "fillet",
      sourceFeatureRefs: [sourceRef],
      edgeSelector: "vertical",
      radiusParameterRef: lengthRef,
      suppressed: false
    },
    {
      id: "75000000-0000-4000-8000-000000000005",
      semanticRef: "pump.feature.protocol-test-chamfer",
      name: "Protocol test chamfer",
      featureKind: "chamfer",
      sourceFeatureRefs: [sourceRef],
      edgeSelector: "parallel_x",
      distanceParameterRef: lengthRef,
      suppressed: false
    },
    {
      id: "75000000-0000-4000-8000-000000000006",
      semanticRef: "pump.feature.protocol-test-linear-pattern",
      name: "Protocol test linear pattern",
      featureKind: "linear_pattern",
      sourceFeatureRef: sourceRef,
      directionVector: [1, 0, 0],
      countParameterRef: countRef,
      spacingParameterRef: lengthRef,
      suppressed: false
    }
  ];
  document.features.push(...features);
  return document;
}

function replaceFeatureParameterReference(
  document: ModelDocument,
  featureSemanticRef: string,
  field: string,
  parameter: ModelParameter
): number {
  const featureIndex = document.features.findIndex(
    (feature) => feature.semanticRef === featureSemanticRef
  );
  if (featureIndex < 0)
    throw new Error(`Missing feature ${featureSemanticRef}`);
  const feature = document.features[featureIndex] as unknown as Record<
    string,
    unknown
  >;
  feature[field] = reference(parameter);
  return featureIndex;
}

function pointReferencedPrimitiveDocument(): ModelDocument {
  const document = structuredClone(createRotaryVanePumpTemplate());
  const sketch = document.sketches[0]!;
  const points = sketch.entities.filter(
    (entity) => entity.entityKind === "point"
  );
  if (points.length < 2) throw new Error("test template needs two points");
  const thirdPoint = {
    id: "76000000-0000-4000-8000-000000000001",
    semanticRef: "pump.sketch.cross-section.point-ref-third",
    entityKind: "point" as const,
    construction: true,
    x: 12,
    y: 12
  };
  const length = document.parameters.find(
    (parameter) => parameter.parameterType === "length"
  );
  if (!length) throw new Error("test template needs a length parameter");
  const firstRef = reference(points[0]!);
  const secondRef = reference(points[1]!);
  const thirdRef = reference(thirdPoint);
  const lengthRef = reference(length);
  sketch.entities.push(
    thirdPoint,
    {
      id: "76000000-0000-4000-8000-000000000002",
      semanticRef: "pump.sketch.cross-section.point-ref-line",
      entityKind: "line",
      construction: true,
      startPointRef: firstRef,
      endPointRef: secondRef
    },
    {
      id: "76000000-0000-4000-8000-000000000003",
      semanticRef: "pump.sketch.cross-section.point-ref-circle",
      entityKind: "circle",
      construction: true,
      centerPointRef: firstRef,
      diameterParameterRef: lengthRef
    },
    {
      id: "76000000-0000-4000-8000-000000000004",
      semanticRef: "pump.sketch.cross-section.point-ref-rectangle",
      entityKind: "rectangle",
      construction: true,
      centerPointRef: secondRef,
      widthParameterRef: lengthRef,
      heightParameterRef: lengthRef,
      rotationDegrees: 0
    },
    {
      id: "76000000-0000-4000-8000-000000000005",
      semanticRef: "pump.sketch.cross-section.point-ref-arc",
      entityKind: "arc",
      construction: true,
      centerPointRef: firstRef,
      startPointRef: secondRef,
      endPointRef: thirdRef,
      clockwise: false
    }
  );
  return document;
}

describe("openvac.modeling.v1 protocol", () => {
  it("accepts the deterministic pump template with stable identities", () => {
    const first = createRotaryVanePumpTemplate();
    const second = createRotaryVanePumpTemplate();

    expect(modelDocumentSchema.parse(first)).toEqual(first);
    expect(first.version).toBe(MODELING_PROTOCOL_VERSION);
    expect(first.id).toBe(second.id);
    expect(first.revisionId).toBe(second.revisionId);
    expect(first.parameters.map((parameter) => parameter.id)).toEqual(
      second.parameters.map((parameter) => parameter.id)
    );
    expect(
      new Set(first.parameters.map((parameter) => parameter.semanticRef)).size
    ).toBe(first.parameters.length);
  });

  it("accepts mass input only as an explicit positive user density", () => {
    const document = structuredClone(createRotaryVanePumpTemplate());
    document.metadata = {
      ...document.metadata,
      material: {
        name: "用户指定材料",
        densityKgM3: 7_850,
        densitySource: "user"
      }
    };

    expect(
      modelDocumentSchema.parse(document).metadata?.material?.densityKgM3
    ).toBe(7_850);
    expect(() =>
      modelDocumentSchema.parse({
        ...document,
        metadata: {
          ...document.metadata,
          material: { densityKgM3: 0, densitySource: "user" }
        }
      })
    ).toThrow();
    expect(() =>
      modelDocumentSchema.parse({
        ...document,
        metadata: {
          ...document.metadata,
          material: { densityKgM3: 7_850, densitySource: "inferred" }
        }
      })
    ).toThrow();
  });

  it("rejects arbitrary executable or topology-index payload fields", () => {
    const documentWithScript = structuredClone(
      createRotaryVanePumpTemplate()
    ) as unknown as Record<string, unknown>;
    const features = documentWithScript.features as Array<
      Record<string, unknown>
    >;
    features[0]!.script = "return shell('rm -rf /')";
    expect(modelDocumentSchema.safeParse(documentWithScript).success).toBe(
      false
    );

    const document = createRotaryVanePumpTemplate();
    const eccentricity = document.parameters.find(
      (parameter) => parameter.semanticRef === "pump.parameter.eccentricity"
    )!;
    expect(
      modelOperationBatchSchema.safeParse({
        version: MODELING_PROTOCOL_VERSION,
        id: BATCH_ID,
        documentId: document.id,
        baseRevisionId: document.revisionId,
        idempotencyKey: "forbidden-payload-1",
        operations: [
          {
            operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            kind: "update",
            collection: "parameters",
            target: {
              id: eccentricity.id,
              semanticRef: eccentricity.semanticRef
            },
            changes: {
              value: 7,
              code: "process.exit()",
              rawFaceIndex: 42
            }
          }
        ]
      }).success
    ).toBe(false);
  });

  it("enforces the sketch constraint status enum", () => {
    const document = createRotaryVanePumpTemplate();
    const valid = document.sketches[0]!.constraints[0]!;

    expect(sketchConstraintSchema.safeParse(valid).success).toBe(true);
    expect(
      sketchConstraintSchema.safeParse({ ...valid, status: "almost_solved" })
        .success
    ).toBe(false);
  });

  it("accepts the V1 midpoint constraint", () => {
    const document = createRotaryVanePumpTemplate();
    const points = document.sketches[0]!.entities.filter(
      (entity) => entity.entityKind === "point"
    );
    const base = document.sketches[0]!.constraints[0]!;

    expect(
      sketchConstraintSchema.safeParse({
        ...base,
        id: "74000000-0000-4000-8000-000000000001",
        semanticRef: "pump.constraint.midpoint-test",
        name: "Midpoint test",
        constraintKind: "midpoint",
        targetRefs: points.slice(0, 2).map(({ id, semanticRef }) => ({
          id,
          semanticRef
        })),
        parameterRef: undefined
      }).success
    ).toBe(true);
  });

  it("accepts line, center, and arc references that resolve to local points", () => {
    const document = pointReferencedPrimitiveDocument();

    expect(modelDocumentSchema.safeParse(document).success).toBe(true);
  });

  it.each([
    ["line start", "pump.sketch.cross-section.point-ref-line", "startPointRef"],
    ["line end", "pump.sketch.cross-section.point-ref-line", "endPointRef"],
    [
      "circle center",
      "pump.sketch.cross-section.point-ref-circle",
      "centerPointRef"
    ],
    [
      "rectangle center",
      "pump.sketch.cross-section.point-ref-rectangle",
      "centerPointRef"
    ],
    ["arc center", "pump.sketch.cross-section.point-ref-arc", "centerPointRef"],
    ["arc start", "pump.sketch.cross-section.point-ref-arc", "startPointRef"],
    ["arc end", "pump.sketch.cross-section.point-ref-arc", "endPointRef"]
  ] as const)(
    "rejects a %s reference that resolves to a local non-point entity",
    (_, entitySemanticRef, field) => {
      const document = pointReferencedPrimitiveDocument();
      const sketch = document.sketches[0]!;
      const line = sketch.entities.find(
        (entity) =>
          entity.semanticRef === "pump.sketch.cross-section.point-ref-line"
      )!;
      const targetIndex = sketch.entities.findIndex(
        (entity) => entity.semanticRef === entitySemanticRef
      );
      if (targetIndex < 0) throw new Error("missing point-reference fixture");
      const target = sketch.entities[targetIndex] as unknown as Record<
        string,
        ModelReference
      >;
      target[field] = reference(line);

      const result = modelDocumentSchema.safeParse(document);

      expect(result.success).toBe(false);
      if (result.success) throw new Error("expected point reference rejection");
      expect(
        result.error.issues.some(
          (issue) =>
            issue.path.join(".") ===
              `sketches.0.entities.${targetIndex}.${field}` &&
            issue.message ===
              "This sketch reference must identify a point entity."
        )
      ).toBe(true);
    }
  );

  it("accepts ordered closed polylines and parameterized slots in one sketch", () => {
    const document = structuredClone(createRotaryVanePumpTemplate());
    const sketch = document.sketches[0]!;
    const existingPoints = sketch.entities.filter(
      (entity) => entity.entityKind === "point"
    );
    const thirdPoint = {
      id: "70000000-0000-4000-8000-000000000001",
      semanticRef: "pump.sketch.cross-section.polyline-point",
      entityKind: "point" as const,
      construction: true,
      x: 8,
      y: 8
    };
    const pointRefs = [...existingPoints, thirdPoint].map(
      ({ id, semanticRef }) => ({ id, semanticRef })
    );
    const width = document.parameters.find(
      (parameter) => parameter.name === "vaneThickness"
    )!;
    sketch.entities.push(
      thirdPoint,
      {
        id: "70000000-0000-4000-8000-000000000002",
        semanticRef: "pump.sketch.cross-section.closed-polyline",
        entityKind: "polyline",
        construction: true,
        pointRefs,
        closed: true
      },
      {
        id: "70000000-0000-4000-8000-000000000003",
        semanticRef: "pump.sketch.cross-section.centerline-slot",
        entityKind: "slot",
        construction: false,
        startPointRef: pointRefs[0]!,
        endPointRef: pointRefs[2]!,
        widthParameterRef: {
          id: width.id,
          semanticRef: width.semanticRef
        }
      }
    );

    const parsed = modelDocumentSchema.parse(document);
    const polyline = parsed.sketches[0]!.entities.find(
      (entity) => entity.entityKind === "polyline"
    );
    const slot = parsed.sketches[0]!.entities.find(
      (entity) => entity.entityKind === "slot"
    );
    expect(polyline).toMatchObject({ closed: true, construction: true });
    expect(slot).toMatchObject({ construction: false });
  });

  it.each(["polyline", "slot"] as const)(
    "rejects a %s point reference crossing sketch boundaries",
    (entityKind) => {
      const document = structuredClone(createRotaryVanePumpTemplate());
      const localPoint = document.sketches[0]!.entities.find(
        (entity) => entity.entityKind === "point"
      )!;
      const remotePoint = {
        id: "73000000-0000-4000-8000-000000000001",
        semanticRef: "pump.sketch.secondary.remote-point",
        entityKind: "point" as const,
        construction: false,
        x: 1,
        y: 1
      };
      document.sketches.push({
        id: "73000000-0000-4000-8000-000000000002",
        semanticRef: "pump.sketch.secondary",
        name: "Secondary sketch",
        plane: "xy",
        entities: [remotePoint],
        constraints: [],
        solveStatus: "under_constrained",
        suppressed: false
      });
      const localRef = {
        id: localPoint.id,
        semanticRef: localPoint.semanticRef
      };
      const remoteRef = {
        id: remotePoint.id,
        semanticRef: remotePoint.semanticRef
      };
      const width = document.parameters.find(
        (parameter) => parameter.name === "vaneThickness"
      )!;
      document.sketches[0]!.entities.push(
        entityKind === "polyline"
          ? {
              id: "73000000-0000-4000-8000-000000000003",
              semanticRef: "pump.sketch.cross-section.invalid-polyline",
              entityKind,
              construction: false,
              pointRefs: [localRef, remoteRef],
              closed: false
            }
          : {
              id: "73000000-0000-4000-8000-000000000004",
              semanticRef: "pump.sketch.cross-section.invalid-slot",
              entityKind,
              construction: false,
              startPointRef: localRef,
              endPointRef: remoteRef,
              widthParameterRef: {
                id: width.id,
                semanticRef: width.semanticRef
              }
            }
      );

      expect(modelDocumentSchema.safeParse(document).success).toBe(false);
    }
  );

  it("rejects a slot width reference that is not a parameter", () => {
    const document = structuredClone(createRotaryVanePumpTemplate());
    const points = document.sketches[0]!.entities.filter(
      (entity) => entity.entityKind === "point"
    );
    document.sketches[0]!.entities.push({
      id: "74000000-0000-4000-8000-000000000001",
      semanticRef: "pump.sketch.cross-section.invalid-width-slot",
      entityKind: "slot",
      construction: false,
      startPointRef: {
        id: points[0]!.id,
        semanticRef: points[0]!.semanticRef
      },
      endPointRef: {
        id: points[1]!.id,
        semanticRef: points[1]!.semanticRef
      },
      widthParameterRef: {
        id: points[0]!.id,
        semanticRef: points[0]!.semanticRef
      }
    });

    expect(modelDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("supports bounded CAD features without raw topology indices", () => {
    const document = createRotaryVanePumpTemplate();
    const source = document.features[0]!;
    const point = document.sketches[0]!.entities.find(
      (entity) => entity.entityKind === "point"
    )!;
    const length = document.parameters.find(
      (parameter) => parameter.name === "vaneThickness"
    )!;
    const count = document.parameters.find(
      (parameter) => parameter.name === "vaneCount"
    )!;
    const sourceRef = { id: source.id, semanticRef: source.semanticRef };
    const lengthRef = { id: length.id, semanticRef: length.semanticRef };
    const features = [
      {
        id: "71000000-0000-4000-8000-000000000001",
        semanticRef: "pump.feature.hole-test",
        name: "Hole",
        featureKind: "hole",
        placement: {
          placementKind: "point",
          pointRef: { id: point.id, semanticRef: point.semanticRef }
        },
        diameterParameterRef: lengthRef,
        termination: "through_all",
        operation: "cut",
        suppressed: false
      },
      {
        id: "71000000-0000-4000-8000-000000000002",
        semanticRef: "pump.feature.fillet-test",
        name: "Fillet",
        featureKind: "fillet",
        sourceFeatureRefs: [sourceRef],
        edgeSelector: "vertical",
        radiusParameterRef: lengthRef,
        suppressed: false
      },
      {
        id: "71000000-0000-4000-8000-000000000003",
        semanticRef: "pump.feature.chamfer-test",
        name: "Chamfer",
        featureKind: "chamfer",
        sourceFeatureRefs: [sourceRef],
        edgeSelector: "top",
        distanceParameterRef: lengthRef,
        suppressed: false
      },
      {
        id: "71000000-0000-4000-8000-000000000004",
        semanticRef: "pump.feature.mirror-test",
        name: "Mirror",
        featureKind: "mirror",
        sourceFeatureRefs: [sourceRef],
        mirrorPlane: "yz",
        suppressed: false
      },
      {
        id: "71000000-0000-4000-8000-000000000005",
        semanticRef: "pump.feature.linear-pattern-test",
        name: "Linear pattern",
        featureKind: "linear_pattern",
        sourceFeatureRef: sourceRef,
        directionVector: [1, 0, 0],
        countParameterRef: { id: count.id, semanticRef: count.semanticRef },
        spacingParameterRef: lengthRef,
        suppressed: false
      },
      {
        id: "71000000-0000-4000-8000-000000000006",
        semanticRef: "pump.feature.imported-step-test",
        name: "Imported STEP",
        featureKind: "imported_step",
        artifactId: "72000000-0000-4000-8000-000000000001",
        artifactSha256: "a".repeat(64),
        sourceName: "sanitized-part.step",
        bodySemanticRefs: ["pump.imported.body.main"],
        suppressed: false
      }
    ];

    for (const feature of features) {
      expect(featureSchema.safeParse(feature).success).toBe(true);
    }
    expect(
      modelDocumentSchema.safeParse({
        ...document,
        features: [...document.features, ...features]
      }).success
    ).toBe(true);
    expect(semanticTopologySelectorSchema.safeParse("face_12").success).toBe(
      false
    );
    expect(
      featureSchema.safeParse({ ...features[1], rawFaceIndex: 12 }).success
    ).toBe(false);
  });

  it("accepts a document whose feature parameters match every V1 dimension contract", () => {
    expect(
      modelDocumentSchema.safeParse(featureParameterDocument()).success
    ).toBe(true);
  });

  it("enforces length/mm on assembly distance parameters", () => {
    const distanceDocument = createRotaryVanePumpTemplate();
    const distanceConstraint = distanceDocument.assemblyConstraints.find(
      (constraint) => constraint.constraintKind === "distance"
    )!;
    const count = distanceDocument.parameters.find(
      (parameter) => parameter.parameterType === "integer"
    )!;
    distanceConstraint.parameterRef = {
      id: count.id,
      semanticRef: count.semanticRef
    };

    const result = modelDocumentSchema.safeParse(distanceDocument);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["assemblyConstraints", 1, "parameterRef"],
        message: `Feature parameter ${count.semanticRef} must use length/mm.`
      })
    );
  });

  it.each([
    ["pump.feature.chamber-volume", "distanceParameterRef", "length/mm"],
    ["pump.feature.protocol-test-revolve", "angleParameterRef", "angle/deg"],
    ["pump.feature.vane-pattern", "countParameterRef", "integer/count"],
    ["pump.feature.inlet-port", "widthParameterRef", "length/mm"],
    ["pump.feature.inlet-port", "axialWidthParameterRef", "length/mm"],
    ["pump.feature.protocol-test-hole", "diameterParameterRef", "length/mm"],
    ["pump.feature.protocol-test-hole", "depthParameterRef", "length/mm"],
    ["pump.feature.protocol-test-fillet", "radiusParameterRef", "length/mm"],
    ["pump.feature.protocol-test-chamfer", "distanceParameterRef", "length/mm"],
    [
      "pump.feature.protocol-test-linear-pattern",
      "countParameterRef",
      "integer/count"
    ],
    [
      "pump.feature.protocol-test-linear-pattern",
      "spacingParameterRef",
      "length/mm"
    ]
  ] as const)(
    "rejects %s.%s when it does not reference a %s parameter",
    (featureSemanticRef, field, expectedContract) => {
      const document = featureParameterDocument();
      const badParameter =
        expectedContract === "integer/count"
          ? document.parameters.find(
              (parameter) => parameter.name === "vaneThickness"
            )!
          : expectedContract === "angle/deg"
            ? document.parameters.find(
                (parameter) => parameter.name === "vaneThickness"
              )!
            : document.parameters.find(
                (parameter) => parameter.name === "vaneCount"
              )!;
      const featureIndex = replaceFeatureParameterReference(
        document,
        featureSemanticRef,
        field,
        badParameter
      );

      const result = modelDocumentSchema.safeParse(document);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["features", featureIndex, field],
          message: `Feature parameter ${badParameter.semanticRef} must use ${expectedContract}.`
        })
      );
    }
  );

  it("checks the unit as well as the parameter type", () => {
    const document = featureParameterDocument();
    const length = document.parameters.find(
      (parameter) => parameter.name === "vaneThickness"
    )!;
    length.unit = "ratio";
    const featureIndex = document.features.findIndex(
      (feature) => feature.semanticRef === "pump.feature.protocol-test-fillet"
    );

    const result = modelDocumentSchema.safeParse(document);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["features", featureIndex, "radiusParameterRef"],
        message: `Feature parameter ${length.semanticRef} must use length/mm.`
      })
    );
  });

  it.each([
    ["pump.feature.chamber-volume", "distanceParameterRef"],
    ["pump.feature.inlet-port", "widthParameterRef"],
    ["pump.feature.inlet-port", "axialWidthParameterRef"],
    ["pump.feature.protocol-test-hole", "diameterParameterRef"],
    ["pump.feature.protocol-test-hole", "depthParameterRef"],
    ["pump.feature.protocol-test-fillet", "radiusParameterRef"],
    ["pump.feature.protocol-test-chamfer", "distanceParameterRef"],
    ["pump.feature.protocol-test-linear-pattern", "spacingParameterRef"]
  ] as const)(
    "rejects a non-positive length for %s.%s",
    (featureSemanticRef, field) => {
      const document = featureParameterDocument();
      const zeroLength: ModelParameter = {
        id: "76000000-0000-4000-8000-000000000001",
        semanticRef: "pump.parameter.protocol-test-zero-length",
        name: "protocolTestZeroLength",
        label: "Protocol test zero length",
        parameterType: "length",
        unit: "mm",
        value: 0,
        source: "user",
        editable: true
      };
      document.parameters.push(zeroLength);
      const featureIndex = replaceFeatureParameterReference(
        document,
        featureSemanticRef,
        field,
        zeroLength
      );

      const result = modelDocumentSchema.safeParse(document);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["features", featureIndex, field],
          message: `Feature parameter ${zeroLength.semanticRef} must be greater than zero.`
        })
      );
    }
  );

  it.each([
    ["pump.feature.vane-pattern", "countParameterRef"],
    ["pump.feature.protocol-test-linear-pattern", "countParameterRef"]
  ] as const)(
    "requires %s.%s to reference an integer/count value of at least one",
    (featureSemanticRef, field) => {
      const accepted = featureParameterDocument();
      const one: ModelParameter = {
        id: "77000000-0000-4000-8000-000000000001",
        semanticRef: "pump.parameter.protocol-test-one-count",
        name: "protocolTestOneCount",
        label: "Protocol test one count",
        parameterType: "integer",
        unit: "count",
        value: 1,
        source: "user",
        editable: true
      };
      accepted.parameters.push(one);
      replaceFeatureParameterReference(
        accepted,
        featureSemanticRef,
        field,
        one
      );
      expect(modelDocumentSchema.safeParse(accepted).success).toBe(true);

      const rejected = featureParameterDocument();
      const zero = { ...one, value: 0 };
      rejected.parameters.push(zero);
      const featureIndex = replaceFeatureParameterReference(
        rejected,
        featureSemanticRef,
        field,
        zero
      );
      const result = modelDocumentSchema.safeParse(rejected);
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["features", featureIndex, field],
          message: `Feature parameter ${zero.semanticRef} must be an integer greater than or equal to 1.`
        })
      );
    }
  );

  it("limits semantic hole faces to the selectors supported by the kernel", () => {
    for (const selector of ["top", "bottom", "front", "back"] as const) {
      expect(semanticFaceSelectorSchema.safeParse(selector).success).toBe(true);
    }
    for (const selector of ["all", "vertical", "parallel_x"] as const) {
      expect(semanticFaceSelectorSchema.safeParse(selector).success).toBe(
        false
      );
      expect(semanticTopologySelectorSchema.safeParse(selector).success).toBe(
        true
      );
    }

    const document = featureParameterDocument();
    const source = document.features[0]!;
    const length = document.parameters.find(
      (parameter) => parameter.name === "vaneThickness"
    )!;
    const hole = document.features.find(
      (feature) => feature.semanticRef === "pump.feature.protocol-test-hole"
    )!;
    const semanticFaceHole: Feature = {
      ...hole,
      featureKind: "hole",
      placement: {
        placementKind: "semantic_face",
        sourceFeatureRef: reference(source),
        faceSelector: "front"
      },
      diameterParameterRef: reference(length),
      termination: "through_all",
      depthParameterRef: undefined,
      operation: "cut"
    };
    expect(featureSchema.safeParse(semanticFaceHole).success).toBe(true);
    expect(
      featureSchema.safeParse({
        ...semanticFaceHole,
        placement: { ...semanticFaceHole.placement, faceSelector: "vertical" }
      }).success
    ).toBe(false);
  });

  it("rejects an ID/semantic-ref pair that does not identify the same object", () => {
    const document = structuredClone(createRotaryVanePumpTemplate());
    const circle = document.sketches[0]!.entities.find(
      (entity) => entity.entityKind === "circle"
    );
    const anotherParameter = document.parameters[1]!;
    if (circle?.entityKind !== "circle") {
      throw new Error("test template has no circle");
    }
    circle.diameterParameterRef = {
      id: anotherParameter.id,
      semanticRef: "pump.parameter.chamber-diameter"
    };

    expect(modelDocumentSchema.safeParse(document).success).toBe(false);
  });
});

describe("canonical modeling data", () => {
  it("uses a known SHA-256 vector without Node-only APIs", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("normalizes object keys, negative zero, and nested data", () => {
    const left = { z: -0, nested: { b: 2, a: 1 }, list: [3, 2, 1] };
    const right = { list: [3, 2, 1], nested: { a: 1, b: 2 }, z: 0 };

    expect(canonicalStringify(left)).toBe(canonicalStringify(right));
    expect(hashCanonicalSpec(left)).toBe(hashCanonicalSpec(right));
  });

  it("produces a stable document hash and excludes mutable plan status", () => {
    const document = createRotaryVanePumpTemplate();
    expect(hashModelDocument(document)).toBe(hashModelDocument(document));

    const basePlan = {
      version: MODELING_PROTOCOL_VERSION,
      id: "11111111-1111-4111-8111-111111111111",
      documentId: document.id,
      baseRevisionId: document.revisionId,
      title: "Need chamber diameter",
      summary: "The requested edit lacks a target diameter.",
      assumptions: [],
      warnings: [],
      missingInputs: ["Target chamber diameter in mm"],
      expectedChecks: [],
      planHash: "0".repeat(64)
    } as const;
    const needsInput = modelingPlanDraftSchema.parse({
      ...basePlan,
      status: "needs_input"
    });
    const rejected = modelingPlanDraftSchema.parse({
      ...basePlan,
      status: "rejected"
    });

    expect(hashModelingPlanDraft(needsInput)).toBe(
      hashModelingPlanDraft(rejected)
    );
  });

  it("rejects non-JSON and cyclic values", () => {
    expect(() => canonicalStringify({ value: undefined })).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalStringify(cyclic)).toThrow(TypeError);
  });
});

describe("applyOperationBatch", () => {
  it("applies add/update/delete/reorder/suppress immutably", () => {
    const original = createRotaryVanePumpTemplate();
    const snapshot = structuredClone(original);
    const eccentricity = original.parameters.find(
      (parameter) => parameter.semanticRef === "pump.parameter.eccentricity"
    )!;
    const feature = original.features[0]!;
    const temporaryParameter = {
      id: "22222222-2222-4222-8222-222222222222",
      semanticRef: "pump.parameter.temporary-check",
      name: "temporaryCheck",
      label: "Temporary check",
      parameterType: "scalar" as const,
      unit: "ratio" as const,
      value: 1,
      minimum: 0,
      maximum: 1,
      source: "user" as const,
      editable: true
    };
    const batch = modelOperationBatchSchema.parse({
      version: MODELING_PROTOCOL_VERSION,
      id: BATCH_ID,
      documentId: original.id,
      // Concurrency comparison belongs to the repository, not this function.
      baseRevisionId: "99999999-9999-4999-8999-999999999999",
      idempotencyKey: "immutable-batch-1",
      operations: [
        {
          operationId: "30000000-0000-4000-8000-000000000001",
          kind: "add",
          collection: "parameters",
          item: temporaryParameter
        },
        {
          operationId: "30000000-0000-4000-8000-000000000002",
          kind: "update",
          collection: "parameters",
          target: {
            id: eccentricity.id,
            semanticRef: eccentricity.semanticRef
          },
          changes: { value: 7, source: "user" }
        },
        {
          operationId: "30000000-0000-4000-8000-000000000003",
          kind: "suppress",
          collection: "features",
          target: { id: feature.id, semanticRef: feature.semanticRef },
          suppressed: true
        },
        {
          operationId: "30000000-0000-4000-8000-000000000004",
          kind: "reorder",
          collection: "features",
          orderedRefs: [...original.features]
            .reverse()
            .map(({ id, semanticRef }) => ({ id, semanticRef }))
        },
        {
          operationId: "30000000-0000-4000-8000-000000000005",
          kind: "delete",
          collection: "parameters",
          target: {
            id: temporaryParameter.id,
            semanticRef: temporaryParameter.semanticRef
          }
        }
      ]
    });

    const next = applyOperationBatch(original, batch);

    expect(original).toEqual(snapshot);
    expect(next).not.toBe(original);
    expect(next.revision).toBe(original.revision + 1);
    expect(next.revisionId).toBe(BATCH_ID);
    expect(
      next.parameters.find((parameter) => parameter.id === eccentricity.id)
    ).toMatchObject({ value: 7, source: "user" });
    expect(next.features.at(-1)).toMatchObject({
      id: feature.id,
      suppressed: true
    });
    expect(
      next.parameters.some(
        (parameter) => parameter.id === temporaryParameter.id
      )
    ).toBe(false);
  });

  it("leaves the source untouched when final semantic validation fails", () => {
    const original = createRotaryVanePumpTemplate();
    const snapshot = structuredClone(original);
    const chamberDiameter = original.parameters.find(
      (parameter) => parameter.semanticRef === "pump.parameter.chamber-diameter"
    )!;
    const batch = modelOperationBatchSchema.parse({
      version: MODELING_PROTOCOL_VERSION,
      id: BATCH_ID,
      documentId: original.id,
      baseRevisionId: original.revisionId,
      idempotencyKey: "invalid-delete-1",
      operations: [
        {
          operationId: "40000000-0000-4000-8000-000000000001",
          kind: "delete",
          collection: "parameters",
          target: {
            id: chamberDiameter.id,
            semanticRef: chamberDiameter.semanticRef
          }
        }
      ]
    });

    expect(() => applyOperationBatch(original, batch)).toThrow();
    expect(original).toEqual(snapshot);
  });

  it("rejects batches targeting another document", () => {
    const original = createRotaryVanePumpTemplate();
    const batch = modelOperationBatchSchema.parse({
      version: MODELING_PROTOCOL_VERSION,
      id: BATCH_ID,
      documentId: "55555555-5555-4555-8555-555555555555",
      baseRevisionId: original.revisionId,
      idempotencyKey: "wrong-document-1",
      operations: [
        {
          operationId: "60000000-0000-4000-8000-000000000001",
          kind: "reorder",
          collection: "components",
          orderedRefs: original.components.map(({ id, semanticRef }) => ({
            id,
            semanticRef
          }))
        }
      ]
    });

    expect(() => applyOperationBatch(original, batch)).toThrow(
      ModelingSemanticError
    );
  });

  it("validates a public build result with physical metrics and opaque artifacts", () => {
    const document = createRotaryVanePumpTemplate();
    const result = engineBuildResultSchema.parse({
      version: MODELING_PROTOCOL_VERSION,
      status: "succeeded",
      jobId: "70000000-0000-4000-8000-000000000001",
      documentId: document.id,
      revisionId: document.revisionId,
      specHash: "a".repeat(64),
      engine: { name: "CadQuery/OCP/OCCT", version: "7.8.1" },
      diagnostics: [],
      artifacts: [
        {
          artifactId: "70000000-0000-4000-8000-000000000002",
          kind: "glb",
          mediaType: "model/gltf-binary",
          byteLength: 1024,
          sha256: "b".repeat(64)
        }
      ],
      metrics: {
        bodyCount: 7,
        volumeMm3: 1234.5,
        surfaceAreaMm2: 678.9,
        boundingBoxMm: [120, 80, 70],
        centerOfMassMm: [1, 2, 3],
        massKg: null,
        massStatus: "unavailable_density_required"
      },
      durationMs: 1250
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") {
      throw new Error("expected a successful engine build result");
    }
    expect(result.metrics.volumeMm3).toBe(1234.5);
    expect(result.metrics.massKg).toBeNull();
    expect(() =>
      engineBuildResultSchema.parse({
        ...result,
        metrics: {
          ...result.metrics,
          massKg: 1.25,
          massStatus: "unavailable_density_required"
        }
      })
    ).toThrow();
    expect(() =>
      engineBuildResultSchema.parse({
        ...result,
        artifacts: [{ ...result.artifacts[0], storageKey: "private/key" }]
      })
    ).toThrow();
  });

  it("validates resumable job events as versioned public envelopes", () => {
    expect(
      jobEventSchema.parse({
        version: MODELING_PROTOCOL_VERSION,
        eventId: "70000000-0000-4000-8000-000000000003",
        jobId: "70000000-0000-4000-8000-000000000001",
        sequence: 8,
        occurredAt: "2026-08-01T00:00:08.000Z",
        type: "artifact_upload_started",
        data: { progress: 70 }
      })
    ).toMatchObject({ sequence: 8, data: { progress: 70 } });
  });
});
