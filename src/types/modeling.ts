import { z } from "zod";

export const MODELING_PROTOCOL_VERSION = "openvac.modeling.v1" as const;

const PROTOCOL_LIMITS = {
  shortText: 160,
  longText: 4_000,
  list: 1_000,
  sketchEntities: 100,
  sketchConstraints: 200,
  operations: 500
} as const;

export const modelingUuidSchema = z.uuid();

export const semanticRefSchema = z
  .string()
  .trim()
  .min(3)
  .max(PROTOCOL_LIMITS.shortText)
  .regex(
    /^[a-z][a-z0-9]*(?:[._:/-][a-z0-9]+)*$/u,
    "Semantic references must be stable lowercase paths, not array indices."
  );

export const modelReferenceSchema = z.strictObject({
  id: modelingUuidSchema,
  semanticRef: semanticRefSchema
});

const namedIdentityShape = {
  id: modelingUuidSchema,
  semanticRef: semanticRefSchema,
  name: z.string().trim().min(1).max(PROTOCOL_LIMITS.shortText)
} as const;

export const modelParameterSchema = z
  .strictObject({
    ...namedIdentityShape,
    label: z.string().trim().min(1).max(PROTOCOL_LIMITS.shortText),
    parameterType: z.enum(["length", "angle", "integer", "scalar"]),
    unit: z.enum(["mm", "deg", "count", "ratio"]),
    value: z.number().finite(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    source: z.enum(["template", "user", "derived"]),
    editable: z.boolean()
  })
  .superRefine((parameter, context) => {
    if (
      parameter.minimum !== undefined &&
      parameter.maximum !== undefined &&
      parameter.minimum > parameter.maximum
    ) {
      context.addIssue({
        code: "custom",
        path: ["minimum"],
        message: "Parameter minimum cannot exceed maximum."
      });
    }
    if (
      parameter.minimum !== undefined &&
      parameter.value < parameter.minimum
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Parameter value is below its minimum."
      });
    }
    if (
      parameter.maximum !== undefined &&
      parameter.value > parameter.maximum
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Parameter value is above its maximum."
      });
    }
    if (
      parameter.parameterType === "integer" &&
      !Number.isInteger(parameter.value)
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Integer parameters require an integer value."
      });
    }
  });

export const sketchConstraintStatusSchema = z.enum([
  "satisfied",
  "redundant",
  "conflicting",
  "unsolved",
  "suppressed"
]);

export const sketchSolveStatusSchema = z.enum([
  "fully_constrained",
  "under_constrained",
  "over_constrained",
  "conflicting",
  "unsolved"
]);

const sketchEntityIdentityShape = {
  id: modelingUuidSchema,
  semanticRef: semanticRefSchema,
  construction: z.boolean()
} as const;

export const sketchPointSchema = z.strictObject({
  ...sketchEntityIdentityShape,
  entityKind: z.literal("point"),
  x: z.number().finite(),
  y: z.number().finite()
});

export const sketchLineSchema = z.strictObject({
  ...sketchEntityIdentityShape,
  entityKind: z.literal("line"),
  startPointRef: modelReferenceSchema,
  endPointRef: modelReferenceSchema
});

export const sketchCircleSchema = z.strictObject({
  ...sketchEntityIdentityShape,
  entityKind: z.literal("circle"),
  centerPointRef: modelReferenceSchema,
  diameterParameterRef: modelReferenceSchema
});

export const sketchArcSchema = z.strictObject({
  ...sketchEntityIdentityShape,
  entityKind: z.literal("arc"),
  centerPointRef: modelReferenceSchema,
  startPointRef: modelReferenceSchema,
  endPointRef: modelReferenceSchema,
  clockwise: z.boolean()
});

export const sketchRectangleSchema = z.strictObject({
  ...sketchEntityIdentityShape,
  entityKind: z.literal("rectangle"),
  centerPointRef: modelReferenceSchema,
  widthParameterRef: modelReferenceSchema,
  heightParameterRef: modelReferenceSchema,
  rotationDegrees: z.number().finite().min(-360).max(360)
});

export const sketchPolylineSchema = z.strictObject({
  ...sketchEntityIdentityShape,
  entityKind: z.literal("polyline"),
  pointRefs: z.array(modelReferenceSchema).min(2).max(PROTOCOL_LIMITS.list),
  closed: z.boolean()
});

export const sketchSlotSchema = z.strictObject({
  ...sketchEntityIdentityShape,
  entityKind: z.literal("slot"),
  startPointRef: modelReferenceSchema,
  endPointRef: modelReferenceSchema,
  widthParameterRef: modelReferenceSchema
});

export const sketchEntitySchema = z.discriminatedUnion("entityKind", [
  sketchPointSchema,
  sketchLineSchema,
  sketchCircleSchema,
  sketchArcSchema,
  sketchRectangleSchema,
  sketchPolylineSchema,
  sketchSlotSchema
]);

export const sketchConstraintSchema = z.strictObject({
  ...namedIdentityShape,
  constraintKind: z.enum([
    "coincident",
    "horizontal",
    "vertical",
    "parallel",
    "perpendicular",
    "tangent",
    "equal",
    "midpoint",
    "distance",
    "radius",
    "diameter",
    "angle",
    "fixed",
    "concentric",
    "symmetric"
  ]),
  targetRefs: z.array(modelReferenceSchema).min(1).max(4),
  parameterRef: modelReferenceSchema.optional(),
  status: sketchConstraintStatusSchema
});

export const sketchSchema = z.strictObject({
  ...namedIdentityShape,
  plane: z.enum(["xy", "xz", "yz"]),
  entities: z.array(sketchEntitySchema).max(PROTOCOL_LIMITS.sketchEntities),
  constraints: z
    .array(sketchConstraintSchema)
    .max(PROTOCOL_LIMITS.sketchConstraints),
  solveStatus: sketchSolveStatusSchema,
  suppressed: z.boolean()
});

const featureIdentityShape = {
  ...namedIdentityShape,
  suppressed: z.boolean()
} as const;

export const extrudeFeatureSchema = z.strictObject({
  ...featureIdentityShape,
  featureKind: z.literal("extrude"),
  profileRefs: z.array(modelReferenceSchema).min(1).max(100),
  distanceParameterRef: modelReferenceSchema,
  direction: z.enum(["normal", "reverse", "symmetric"]),
  operation: z.enum(["new_body", "add", "cut", "intersect"])
});

export const revolveFeatureSchema = z.strictObject({
  ...featureIdentityShape,
  featureKind: z.literal("revolve"),
  profileRefs: z.array(modelReferenceSchema).min(1).max(100),
  axisRef: modelReferenceSchema,
  angleParameterRef: modelReferenceSchema,
  operation: z.enum(["new_body", "add", "cut", "intersect"])
});

export const booleanFeatureSchema = z.strictObject({
  ...featureIdentityShape,
  featureKind: z.literal("boolean"),
  targetFeatureRef: modelReferenceSchema,
  toolFeatureRefs: z.array(modelReferenceSchema).min(1).max(100),
  operation: z.enum(["union", "subtract", "intersect"])
});

export const circularPatternFeatureSchema = z.strictObject({
  ...featureIdentityShape,
  featureKind: z.literal("circular_pattern"),
  sourceFeatureRef: modelReferenceSchema,
  axisOrigin: z.tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite()
  ]),
  axisDirection: z.tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite()
  ]),
  countParameterRef: modelReferenceSchema,
  totalAngleDegrees: z.number().finite().positive().max(360)
});

export const portFeatureSchema = z.strictObject({
  ...featureIdentityShape,
  featureKind: z.literal("port"),
  role: z.enum(["inlet", "outlet"]),
  chamberProfileRef: modelReferenceSchema,
  widthParameterRef: modelReferenceSchema,
  axialWidthParameterRef: modelReferenceSchema,
  centerAngleDegrees: z.number().finite().min(0).lt(360),
  operation: z.literal("cut")
});

export const semanticTopologySelectorSchema = z.enum([
  "all",
  "vertical",
  "top",
  "bottom",
  "parallel_x",
  "parallel_y",
  "parallel_z"
]);

export const semanticFaceSelectorSchema = z.enum([
  "top",
  "bottom",
  "front",
  "back"
]);

export const holePlacementSchema = z.discriminatedUnion("placementKind", [
  z.strictObject({
    placementKind: z.literal("profile"),
    profileRef: modelReferenceSchema
  }),
  z.strictObject({
    placementKind: z.literal("point"),
    pointRef: modelReferenceSchema
  }),
  z.strictObject({
    placementKind: z.literal("semantic_face"),
    sourceFeatureRef: modelReferenceSchema,
    faceSelector: semanticFaceSelectorSchema
  })
]);

export const holeFeatureSchema = z.strictObject({
  ...featureIdentityShape,
  featureKind: z.literal("hole"),
  placement: holePlacementSchema,
  diameterParameterRef: modelReferenceSchema,
  termination: z.enum(["blind", "through_all"]),
  depthParameterRef: modelReferenceSchema.optional(),
  operation: z.literal("cut")
});

export const filletFeatureSchema = z.strictObject({
  ...featureIdentityShape,
  featureKind: z.literal("fillet"),
  sourceFeatureRefs: z.array(modelReferenceSchema).min(1).max(100),
  edgeSelector: semanticTopologySelectorSchema,
  radiusParameterRef: modelReferenceSchema
});

export const chamferFeatureSchema = z.strictObject({
  ...featureIdentityShape,
  featureKind: z.literal("chamfer"),
  sourceFeatureRefs: z.array(modelReferenceSchema).min(1).max(100),
  edgeSelector: semanticTopologySelectorSchema,
  distanceParameterRef: modelReferenceSchema
});

export const mirrorFeatureSchema = z.strictObject({
  ...featureIdentityShape,
  featureKind: z.literal("mirror"),
  sourceFeatureRefs: z.array(modelReferenceSchema).min(1).max(100),
  mirrorPlane: z.enum(["xy", "xz", "yz"])
});

export const linearPatternFeatureSchema = z.strictObject({
  ...featureIdentityShape,
  featureKind: z.literal("linear_pattern"),
  sourceFeatureRef: modelReferenceSchema,
  directionVector: z.tuple([
    z.number().finite(),
    z.number().finite(),
    z.number().finite()
  ]),
  countParameterRef: modelReferenceSchema,
  spacingParameterRef: modelReferenceSchema
});

export const importedStepFeatureSchema = z.strictObject({
  ...featureIdentityShape,
  featureKind: z.literal("imported_step"),
  artifactId: modelingUuidSchema,
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceName: z.string().trim().min(1).max(255),
  bodySemanticRefs: z.array(semanticRefSchema).min(1).max(1_000)
});

export const featureSchema = z.discriminatedUnion("featureKind", [
  extrudeFeatureSchema,
  revolveFeatureSchema,
  booleanFeatureSchema,
  circularPatternFeatureSchema,
  portFeatureSchema,
  holeFeatureSchema,
  filletFeatureSchema,
  chamferFeatureSchema,
  mirrorFeatureSchema,
  linearPatternFeatureSchema,
  importedStepFeatureSchema
]);

export const componentSchema = z.strictObject({
  ...namedIdentityShape,
  featureRefs: z.array(modelReferenceSchema).min(1).max(PROTOCOL_LIMITS.list),
  transform: z.strictObject({
    translationMm: z.tuple([
      z.number().finite(),
      z.number().finite(),
      z.number().finite()
    ]),
    rotationDegrees: z.tuple([
      z.number().finite(),
      z.number().finite(),
      z.number().finite()
    ])
  }),
  suppressed: z.boolean()
});

export const assemblyConstraintSchema = z
  .strictObject({
    ...namedIdentityShape,
    constraintKind: z.enum(["fixed", "coincident", "concentric", "distance"]),
    componentRefs: z.array(modelReferenceSchema).min(1).max(2),
    parameterRef: modelReferenceSchema.optional(),
    status: z.enum(["satisfied", "conflicting", "unsolved", "suppressed"])
  })
  .superRefine((constraint, context) => {
    const expectedRefs = constraint.constraintKind === "fixed" ? 1 : 2;
    if (constraint.componentRefs.length !== expectedRefs) {
      context.addIssue({
        code: "custom",
        path: ["componentRefs"],
        message: `${constraint.constraintKind} requires exactly ${expectedRefs} component reference${expectedRefs === 1 ? "" : "s"}.`
      });
    }
    if (
      constraint.componentRefs.length === 2 &&
      constraint.componentRefs[0]?.id === constraint.componentRefs[1]?.id &&
      constraint.componentRefs[0]?.semanticRef ===
        constraint.componentRefs[1]?.semanticRef
    ) {
      context.addIssue({
        code: "custom",
        path: ["componentRefs", 1],
        message:
          "A binary assembly constraint requires two distinct components."
      });
    }
    const requiresParameter = constraint.constraintKind === "distance";
    if (requiresParameter && !constraint.parameterRef) {
      context.addIssue({
        code: "custom",
        path: ["parameterRef"],
        message: `${constraint.constraintKind} requires a parameter reference.`
      });
    }
    if (!requiresParameter && constraint.parameterRef) {
      context.addIssue({
        code: "custom",
        path: ["parameterRef"],
        message: `${constraint.constraintKind} does not accept a parameter reference.`
      });
    }
  });

const modelDocumentObjectSchema = z.strictObject({
  version: z.literal(MODELING_PROTOCOL_VERSION),
  id: modelingUuidSchema,
  revision: z.number().int().nonnegative(),
  revisionId: modelingUuidSchema,
  name: z.string().trim().min(1).max(PROTOCOL_LIMITS.shortText),
  unitSystem: z.literal("mm-deg"),
  parameters: z.array(modelParameterSchema).max(PROTOCOL_LIMITS.list),
  sketches: z.array(sketchSchema).max(PROTOCOL_LIMITS.list),
  features: z.array(featureSchema).max(PROTOCOL_LIMITS.list),
  components: z.array(componentSchema).max(PROTOCOL_LIMITS.list),
  assemblyConstraints: z
    .array(assemblyConstraintSchema)
    .max(PROTOCOL_LIMITS.list),
  metadata: z
    .strictObject({
      description: z.string().trim().max(PROTOCOL_LIMITS.longText).optional(),
      template: z
        .strictObject({
          templateId: semanticRefSchema,
          templateVersion: z
            .string()
            .regex(/^\d+\.\d+\.\d+$/u)
            .max(40)
        })
        .optional(),
      material: z
        .strictObject({
          name: z
            .string()
            .trim()
            .min(1)
            .max(PROTOCOL_LIMITS.shortText)
            .optional(),
          densityKgM3: z.number().finite().positive().max(100_000),
          densitySource: z.literal("user")
        })
        .optional(),
      tags: z.array(semanticRefSchema).max(50).optional()
    })
    .optional()
});

type ReferenceCandidate = {
  id: string;
  semanticRef: string;
};

function referenceKey(reference: ReferenceCandidate): string {
  return `${reference.id}\u0000${reference.semanticRef}`;
}

function addSemanticIssue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string
): void {
  context.addIssue({ code: "custom", path, message });
}

function validateReference(
  reference: ReferenceCandidate,
  knownReferences: Map<string, string>,
  context: z.RefinementCtx,
  path: PropertyKey[],
  expectedCategory?: string
): void {
  const category = knownReferences.get(referenceKey(reference));
  if (!category) {
    addSemanticIssue(
      context,
      path,
      `Unknown or mismatched stable reference ${reference.semanticRef}.`
    );
    return;
  }
  if (expectedCategory && category !== expectedCategory) {
    addSemanticIssue(
      context,
      path,
      `Reference ${reference.semanticRef} must target ${expectedCategory}, not ${category}.`
    );
  }
}

type FeatureParameterRequirement = {
  parameterType: "length" | "angle" | "integer" | "scalar";
  unit: "mm" | "deg" | "count" | "ratio";
  positive?: boolean;
  integerMinimum?: number;
};

function validateFeatureParameterReference(
  reference: ReferenceCandidate,
  knownReferences: Map<string, string>,
  parametersByReference: Map<string, z.infer<typeof modelParameterSchema>>,
  context: z.RefinementCtx,
  path: PropertyKey[],
  requirement: FeatureParameterRequirement
): void {
  validateReference(reference, knownReferences, context, path, "parameter");

  const parameter = parametersByReference.get(referenceKey(reference));
  if (!parameter) return;

  if (
    parameter.parameterType !== requirement.parameterType ||
    parameter.unit !== requirement.unit
  ) {
    addSemanticIssue(
      context,
      path,
      `Feature parameter ${reference.semanticRef} must use ${requirement.parameterType}/${requirement.unit}.`
    );
  }
  if (requirement.positive && parameter.value <= 0) {
    addSemanticIssue(
      context,
      path,
      `Feature parameter ${reference.semanticRef} must be greater than zero.`
    );
  }
  if (
    requirement.integerMinimum !== undefined &&
    (!Number.isInteger(parameter.value) ||
      parameter.value < requirement.integerMinimum)
  ) {
    addSemanticIssue(
      context,
      path,
      `Feature parameter ${reference.semanticRef} must be an integer greater than or equal to ${requirement.integerMinimum}.`
    );
  }
}

export const modelDocumentSchema = modelDocumentObjectSchema.superRefine(
  (document, context) => {
    const identities: Array<{
      value: ReferenceCandidate;
      category: string;
      path: PropertyKey[];
    }> = [
      ...document.parameters.map((value, index) => ({
        value,
        category: "parameter",
        path: ["parameters", index]
      })),
      ...document.sketches.flatMap((sketch, sketchIndex) => [
        {
          value: sketch,
          category: "sketch",
          path: ["sketches", sketchIndex]
        },
        ...sketch.entities.map((value, entityIndex) => ({
          value,
          category: "sketch_entity",
          path: ["sketches", sketchIndex, "entities", entityIndex]
        })),
        ...sketch.constraints.map((value, constraintIndex) => ({
          value,
          category: "sketch_constraint",
          path: ["sketches", sketchIndex, "constraints", constraintIndex]
        }))
      ]),
      ...document.features.map((value, index) => ({
        value,
        category: "feature",
        path: ["features", index]
      })),
      ...document.components.map((value, index) => ({
        value,
        category: "component",
        path: ["components", index]
      })),
      ...document.assemblyConstraints.map((value, index) => ({
        value,
        category: "assembly_constraint",
        path: ["assemblyConstraints", index]
      }))
    ];

    const ids = new Map<string, PropertyKey[]>();
    const semanticRefs = new Map<string, PropertyKey[]>();
    const knownReferences = new Map<string, string>();
    for (const identity of identities) {
      const priorIdPath = ids.get(identity.value.id);
      if (priorIdPath) {
        addSemanticIssue(
          context,
          [...identity.path, "id"],
          `Duplicate UUID also used at ${priorIdPath.join(".")}.`
        );
      } else {
        ids.set(identity.value.id, identity.path);
      }

      const priorRefPath = semanticRefs.get(identity.value.semanticRef);
      if (priorRefPath) {
        addSemanticIssue(
          context,
          [...identity.path, "semanticRef"],
          `Duplicate semantic reference also used at ${priorRefPath.join(".")}.`
        );
      } else {
        semanticRefs.set(identity.value.semanticRef, identity.path);
      }
      knownReferences.set(referenceKey(identity.value), identity.category);
    }
    const sketchEntityKinds = new Map(
      document.sketches.flatMap((sketch) =>
        sketch.entities.map(
          (entity) => [referenceKey(entity), entity.entityKind] as const
        )
      )
    );
    const parametersByReference = new Map(
      document.parameters.map(
        (parameter) => [referenceKey(parameter), parameter] as const
      )
    );

    document.sketches.forEach((sketch, sketchIndex) => {
      const localEntityRefs = new Set(
        sketch.entities.map((entity) => referenceKey(entity))
      );
      const checkLocalEntity = (
        reference: ReferenceCandidate,
        path: PropertyKey[]
      ) => {
        if (!localEntityRefs.has(referenceKey(reference))) {
          addSemanticIssue(
            context,
            path,
            "Sketch geometry may only reference an entity in the same sketch."
          );
        }
      };
      const checkLocalPoint = (
        reference: ReferenceCandidate,
        path: PropertyKey[]
      ) => {
        checkLocalEntity(reference, path);
        validateReference(
          reference,
          knownReferences,
          context,
          path,
          "sketch_entity"
        );
        if (sketchEntityKinds.get(referenceKey(reference)) !== "point") {
          addSemanticIssue(
            context,
            path,
            "This sketch reference must identify a point entity."
          );
        }
      };

      sketch.entities.forEach((entity, entityIndex) => {
        const basePath = ["sketches", sketchIndex, "entities", entityIndex];
        if (entity.entityKind === "line") {
          checkLocalPoint(entity.startPointRef, [...basePath, "startPointRef"]);
          checkLocalPoint(entity.endPointRef, [...basePath, "endPointRef"]);
        }
        if (
          entity.entityKind === "circle" ||
          entity.entityKind === "rectangle"
        ) {
          checkLocalPoint(entity.centerPointRef, [
            ...basePath,
            "centerPointRef"
          ]);
        }
        if (entity.entityKind === "circle") {
          validateReference(
            entity.diameterParameterRef,
            knownReferences,
            context,
            [...basePath, "diameterParameterRef"],
            "parameter"
          );
        }
        if (entity.entityKind === "rectangle") {
          validateReference(
            entity.widthParameterRef,
            knownReferences,
            context,
            [...basePath, "widthParameterRef"],
            "parameter"
          );
          validateReference(
            entity.heightParameterRef,
            knownReferences,
            context,
            [...basePath, "heightParameterRef"],
            "parameter"
          );
        }
        if (entity.entityKind === "arc") {
          for (const [field, reference] of [
            ["centerPointRef", entity.centerPointRef],
            ["startPointRef", entity.startPointRef],
            ["endPointRef", entity.endPointRef]
          ] as const) {
            checkLocalPoint(reference, [...basePath, field]);
          }
        }
        if (entity.entityKind === "polyline") {
          if (entity.closed && entity.pointRefs.length < 3) {
            addSemanticIssue(
              context,
              [...basePath, "pointRefs"],
              "A closed polyline requires at least three ordered points."
            );
          }
          entity.pointRefs.forEach((reference, referenceIndex) =>
            checkLocalPoint(reference, [
              ...basePath,
              "pointRefs",
              referenceIndex
            ])
          );
        }
        if (entity.entityKind === "slot") {
          checkLocalPoint(entity.startPointRef, [...basePath, "startPointRef"]);
          checkLocalPoint(entity.endPointRef, [...basePath, "endPointRef"]);
          if (
            referenceKey(entity.startPointRef) ===
            referenceKey(entity.endPointRef)
          ) {
            addSemanticIssue(
              context,
              [...basePath, "endPointRef"],
              "Slot centerline endpoints must be distinct."
            );
          }
          validateReference(
            entity.widthParameterRef,
            knownReferences,
            context,
            [...basePath, "widthParameterRef"],
            "parameter"
          );
        }
      });

      sketch.constraints.forEach((constraint, constraintIndex) => {
        const basePath = [
          "sketches",
          sketchIndex,
          "constraints",
          constraintIndex
        ];
        constraint.targetRefs.forEach((reference, referenceIndex) => {
          checkLocalEntity(reference, [
            ...basePath,
            "targetRefs",
            referenceIndex
          ]);
          validateReference(
            reference,
            knownReferences,
            context,
            [...basePath, "targetRefs", referenceIndex],
            "sketch_entity"
          );
        });
        if (constraint.parameterRef) {
          validateReference(
            constraint.parameterRef,
            knownReferences,
            context,
            [...basePath, "parameterRef"],
            "parameter"
          );
        }
      });
    });

    document.features.forEach((feature, featureIndex) => {
      const basePath = ["features", featureIndex];
      if (feature.featureKind === "extrude") {
        feature.profileRefs.forEach((reference, index) =>
          validateReference(
            reference,
            knownReferences,
            context,
            [...basePath, "profileRefs", index],
            "sketch_entity"
          )
        );
        validateFeatureParameterReference(
          feature.distanceParameterRef,
          knownReferences,
          parametersByReference,
          context,
          [...basePath, "distanceParameterRef"],
          { parameterType: "length", unit: "mm", positive: true }
        );
      }
      if (feature.featureKind === "revolve") {
        feature.profileRefs.forEach((reference, index) =>
          validateReference(
            reference,
            knownReferences,
            context,
            [...basePath, "profileRefs", index],
            "sketch_entity"
          )
        );
        validateReference(
          feature.axisRef,
          knownReferences,
          context,
          [...basePath, "axisRef"],
          "sketch_entity"
        );
        validateFeatureParameterReference(
          feature.angleParameterRef,
          knownReferences,
          parametersByReference,
          context,
          [...basePath, "angleParameterRef"],
          { parameterType: "angle", unit: "deg" }
        );
      }
      if (feature.featureKind === "boolean") {
        validateReference(
          feature.targetFeatureRef,
          knownReferences,
          context,
          [...basePath, "targetFeatureRef"],
          "feature"
        );
        feature.toolFeatureRefs.forEach((reference, index) =>
          validateReference(
            reference,
            knownReferences,
            context,
            [...basePath, "toolFeatureRefs", index],
            "feature"
          )
        );
      }
      if (feature.featureKind === "circular_pattern") {
        validateReference(
          feature.sourceFeatureRef,
          knownReferences,
          context,
          [...basePath, "sourceFeatureRef"],
          "feature"
        );
        validateFeatureParameterReference(
          feature.countParameterRef,
          knownReferences,
          parametersByReference,
          context,
          [...basePath, "countParameterRef"],
          {
            parameterType: "integer",
            unit: "count",
            integerMinimum: 1
          }
        );
        if (feature.axisDirection.every((coordinate) => coordinate === 0)) {
          addSemanticIssue(
            context,
            [...basePath, "axisDirection"],
            "Pattern axis direction cannot be the zero vector."
          );
        }
      }
      if (feature.featureKind === "port") {
        validateReference(
          feature.chamberProfileRef,
          knownReferences,
          context,
          [...basePath, "chamberProfileRef"],
          "sketch_entity"
        );
        validateFeatureParameterReference(
          feature.widthParameterRef,
          knownReferences,
          parametersByReference,
          context,
          [...basePath, "widthParameterRef"],
          { parameterType: "length", unit: "mm", positive: true }
        );
        validateFeatureParameterReference(
          feature.axialWidthParameterRef,
          knownReferences,
          parametersByReference,
          context,
          [...basePath, "axialWidthParameterRef"],
          { parameterType: "length", unit: "mm", positive: true }
        );
      }
      if (feature.featureKind === "hole") {
        if (feature.placement.placementKind === "profile") {
          validateReference(
            feature.placement.profileRef,
            knownReferences,
            context,
            [...basePath, "placement", "profileRef"],
            "sketch_entity"
          );
          if (
            sketchEntityKinds.get(
              referenceKey(feature.placement.profileRef)
            ) === "point"
          ) {
            addSemanticIssue(
              context,
              [...basePath, "placement", "profileRef"],
              "Hole profile placement cannot target a lone sketch point."
            );
          }
        }
        if (feature.placement.placementKind === "point") {
          validateReference(
            feature.placement.pointRef,
            knownReferences,
            context,
            [...basePath, "placement", "pointRef"],
            "sketch_entity"
          );
          if (
            sketchEntityKinds.get(referenceKey(feature.placement.pointRef)) !==
            "point"
          ) {
            addSemanticIssue(
              context,
              [...basePath, "placement", "pointRef"],
              "Hole point placement must target a sketch point."
            );
          }
        }
        if (feature.placement.placementKind === "semantic_face") {
          validateReference(
            feature.placement.sourceFeatureRef,
            knownReferences,
            context,
            [...basePath, "placement", "sourceFeatureRef"],
            "feature"
          );
        }
        validateFeatureParameterReference(
          feature.diameterParameterRef,
          knownReferences,
          parametersByReference,
          context,
          [...basePath, "diameterParameterRef"],
          { parameterType: "length", unit: "mm", positive: true }
        );
        if (feature.termination === "blind" && !feature.depthParameterRef) {
          addSemanticIssue(
            context,
            [...basePath, "depthParameterRef"],
            "Blind holes require a depth parameter."
          );
        }
        if (
          feature.termination === "through_all" &&
          feature.depthParameterRef
        ) {
          addSemanticIssue(
            context,
            [...basePath, "depthParameterRef"],
            "Through-all holes cannot carry an unused depth parameter."
          );
        }
        if (feature.depthParameterRef) {
          validateFeatureParameterReference(
            feature.depthParameterRef,
            knownReferences,
            parametersByReference,
            context,
            [...basePath, "depthParameterRef"],
            { parameterType: "length", unit: "mm", positive: true }
          );
        }
      }
      if (
        feature.featureKind === "fillet" ||
        feature.featureKind === "chamfer" ||
        feature.featureKind === "mirror"
      ) {
        feature.sourceFeatureRefs.forEach((reference, index) =>
          validateReference(
            reference,
            knownReferences,
            context,
            [...basePath, "sourceFeatureRefs", index],
            "feature"
          )
        );
      }
      if (feature.featureKind === "fillet") {
        validateFeatureParameterReference(
          feature.radiusParameterRef,
          knownReferences,
          parametersByReference,
          context,
          [...basePath, "radiusParameterRef"],
          { parameterType: "length", unit: "mm", positive: true }
        );
      }
      if (feature.featureKind === "chamfer") {
        validateFeatureParameterReference(
          feature.distanceParameterRef,
          knownReferences,
          parametersByReference,
          context,
          [...basePath, "distanceParameterRef"],
          { parameterType: "length", unit: "mm", positive: true }
        );
      }
      if (feature.featureKind === "linear_pattern") {
        validateReference(
          feature.sourceFeatureRef,
          knownReferences,
          context,
          [...basePath, "sourceFeatureRef"],
          "feature"
        );
        validateFeatureParameterReference(
          feature.countParameterRef,
          knownReferences,
          parametersByReference,
          context,
          [...basePath, "countParameterRef"],
          {
            parameterType: "integer",
            unit: "count",
            integerMinimum: 1
          }
        );
        validateFeatureParameterReference(
          feature.spacingParameterRef,
          knownReferences,
          parametersByReference,
          context,
          [...basePath, "spacingParameterRef"],
          { parameterType: "length", unit: "mm", positive: true }
        );
        if (feature.directionVector.every((coordinate) => coordinate === 0)) {
          addSemanticIssue(
            context,
            [...basePath, "directionVector"],
            "Linear pattern direction cannot be the zero vector."
          );
        }
      }
      if (feature.featureKind === "imported_step") {
        if (
          new Set(feature.bodySemanticRefs).size !==
          feature.bodySemanticRefs.length
        ) {
          addSemanticIssue(
            context,
            [...basePath, "bodySemanticRefs"],
            "Imported STEP body semantic references must be unique."
          );
        }
      }
    });

    document.components.forEach((component, componentIndex) => {
      component.featureRefs.forEach((reference, referenceIndex) =>
        validateReference(
          reference,
          knownReferences,
          context,
          ["components", componentIndex, "featureRefs", referenceIndex],
          "feature"
        )
      );
    });

    document.assemblyConstraints.forEach((constraint, constraintIndex) => {
      constraint.componentRefs.forEach((reference, referenceIndex) =>
        validateReference(
          reference,
          knownReferences,
          context,
          [
            "assemblyConstraints",
            constraintIndex,
            "componentRefs",
            referenceIndex
          ],
          "component"
        )
      );
      if (constraint.parameterRef) {
        validateFeatureParameterReference(
          constraint.parameterRef,
          knownReferences,
          parametersByReference,
          context,
          ["assemblyConstraints", constraintIndex, "parameterRef"],
          { parameterType: "length", unit: "mm" }
        );
      }
    });
  }
);

const parameterPatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(PROTOCOL_LIMITS.shortText).optional(),
    label: z.string().trim().min(1).max(PROTOCOL_LIMITS.shortText).optional(),
    parameterType: z.enum(["length", "angle", "integer", "scalar"]).optional(),
    unit: z.enum(["mm", "deg", "count", "ratio"]).optional(),
    value: z.number().finite().optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    source: z.enum(["template", "user", "derived"]).optional(),
    editable: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "An update must contain at least one allowed change."
  });

const sketchPatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(PROTOCOL_LIMITS.shortText).optional(),
    plane: z.enum(["xy", "xz", "yz"]).optional(),
    entities: z
      .array(sketchEntitySchema)
      .max(PROTOCOL_LIMITS.sketchEntities)
      .optional(),
    constraints: z
      .array(sketchConstraintSchema)
      .max(PROTOCOL_LIMITS.sketchConstraints)
      .optional(),
    solveStatus: sketchSolveStatusSchema.optional(),
    suppressed: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "An update must contain at least one allowed change."
  });

const featurePatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(PROTOCOL_LIMITS.shortText).optional(),
    suppressed: z.boolean().optional(),
    profileRefs: z.array(modelReferenceSchema).min(1).max(100).optional(),
    distanceParameterRef: modelReferenceSchema.optional(),
    direction: z.enum(["normal", "reverse", "symmetric"]).optional(),
    operation: z
      .enum(["new_body", "add", "cut", "intersect", "union", "subtract"])
      .optional(),
    axisRef: modelReferenceSchema.optional(),
    angleParameterRef: modelReferenceSchema.optional(),
    targetFeatureRef: modelReferenceSchema.optional(),
    toolFeatureRefs: z.array(modelReferenceSchema).min(1).max(100).optional(),
    sourceFeatureRef: modelReferenceSchema.optional(),
    axisOrigin: z
      .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
      .optional(),
    axisDirection: z
      .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
      .optional(),
    countParameterRef: modelReferenceSchema.optional(),
    totalAngleDegrees: z.number().finite().positive().max(360).optional(),
    role: z.enum(["inlet", "outlet"]).optional(),
    chamberProfileRef: modelReferenceSchema.optional(),
    widthParameterRef: modelReferenceSchema.optional(),
    axialWidthParameterRef: modelReferenceSchema.optional(),
    centerAngleDegrees: z.number().finite().min(0).lt(360).optional(),
    placement: holePlacementSchema.optional(),
    diameterParameterRef: modelReferenceSchema.optional(),
    termination: z.enum(["blind", "through_all"]).optional(),
    depthParameterRef: modelReferenceSchema.optional(),
    sourceFeatureRefs: z.array(modelReferenceSchema).min(1).max(100).optional(),
    edgeSelector: semanticTopologySelectorSchema.optional(),
    radiusParameterRef: modelReferenceSchema.optional(),
    mirrorPlane: z.enum(["xy", "xz", "yz"]).optional(),
    directionVector: z
      .tuple([z.number().finite(), z.number().finite(), z.number().finite()])
      .optional(),
    spacingParameterRef: modelReferenceSchema.optional(),
    artifactId: modelingUuidSchema.optional(),
    artifactSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    sourceName: z.string().trim().min(1).max(255).optional(),
    bodySemanticRefs: z.array(semanticRefSchema).min(1).max(1_000).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "An update must contain at least one allowed change."
  });

const componentPatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(PROTOCOL_LIMITS.shortText).optional(),
    featureRefs: z
      .array(modelReferenceSchema)
      .max(PROTOCOL_LIMITS.list)
      .optional(),
    transform: componentSchema.shape.transform.optional(),
    suppressed: z.boolean().optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "An update must contain at least one allowed change."
  });

const assemblyConstraintPatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(PROTOCOL_LIMITS.shortText).optional(),
    constraintKind: z
      .enum([
        "fixed",
        "coincident",
        "concentric",
        "parallel",
        "perpendicular",
        "distance",
        "angle"
      ])
      .optional(),
    componentRefs: z.array(modelReferenceSchema).min(1).max(2).optional(),
    parameterRef: modelReferenceSchema.optional(),
    status: z
      .enum(["satisfied", "conflicting", "unsolved", "suppressed"])
      .optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "An update must contain at least one allowed change."
  });

export const modelCollectionSchema = z.enum([
  "parameters",
  "sketches",
  "features",
  "components",
  "assemblyConstraints"
]);

const operationIdentityShape = {
  operationId: modelingUuidSchema
} as const;

const addOperationSchema = z.strictObject({
  ...operationIdentityShape,
  kind: z.literal("add"),
  collection: modelCollectionSchema,
  item: z.union([
    modelParameterSchema,
    sketchSchema,
    featureSchema,
    componentSchema,
    assemblyConstraintSchema
  ])
});

const updateOperationSchema = z.strictObject({
  ...operationIdentityShape,
  kind: z.literal("update"),
  collection: modelCollectionSchema,
  target: modelReferenceSchema,
  changes: z.union([
    parameterPatchSchema,
    sketchPatchSchema,
    featurePatchSchema,
    componentPatchSchema,
    assemblyConstraintPatchSchema
  ])
});

const deleteOperationSchema = z.strictObject({
  ...operationIdentityShape,
  kind: z.literal("delete"),
  collection: modelCollectionSchema,
  target: modelReferenceSchema
});

const reorderOperationSchema = z.strictObject({
  ...operationIdentityShape,
  kind: z.literal("reorder"),
  collection: modelCollectionSchema,
  orderedRefs: z.array(modelReferenceSchema).max(PROTOCOL_LIMITS.list)
});

const suppressOperationSchema = z.strictObject({
  ...operationIdentityShape,
  kind: z.literal("suppress"),
  collection: z.enum(["features", "components"]),
  target: modelReferenceSchema,
  suppressed: z.boolean()
});

export const modelOperationSchema = z.discriminatedUnion("kind", [
  addOperationSchema,
  updateOperationSchema,
  deleteOperationSchema,
  reorderOperationSchema,
  suppressOperationSchema
]);

const operationItemSchemas = {
  parameters: modelParameterSchema,
  sketches: sketchSchema,
  features: featureSchema,
  components: componentSchema,
  assemblyConstraints: assemblyConstraintSchema
} as const;

const operationPatchSchemas = {
  parameters: parameterPatchSchema,
  sketches: sketchPatchSchema,
  features: featurePatchSchema,
  components: componentPatchSchema,
  assemblyConstraints: assemblyConstraintPatchSchema
} as const;

export const modelOperationBatchSchema = z
  .strictObject({
    version: z.literal(MODELING_PROTOCOL_VERSION),
    id: modelingUuidSchema,
    documentId: modelingUuidSchema,
    baseRevisionId: modelingUuidSchema,
    idempotencyKey: z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    operations: z
      .array(modelOperationSchema)
      .min(1)
      .max(PROTOCOL_LIMITS.operations)
  })
  .superRefine((batch, context) => {
    const operationIds = new Set<string>();
    batch.operations.forEach((operation, index) => {
      if (operationIds.has(operation.operationId)) {
        addSemanticIssue(
          context,
          ["operations", index, "operationId"],
          "Operation UUIDs must be unique within a batch."
        );
      }
      operationIds.add(operation.operationId);

      if (operation.kind === "add") {
        const parsed = operationItemSchemas[operation.collection].safeParse(
          operation.item
        );
        if (!parsed.success) {
          addSemanticIssue(
            context,
            ["operations", index, "item"],
            `Added item does not belong to ${operation.collection}.`
          );
        }
      }
      if (operation.kind === "update") {
        const parsed = operationPatchSchemas[operation.collection].safeParse(
          operation.changes
        );
        if (!parsed.success) {
          addSemanticIssue(
            context,
            ["operations", index, "changes"],
            `Update fields do not belong to ${operation.collection}.`
          );
        }
      }
    });
  });

export const modelingPlanDraftSchema = z
  .strictObject({
    version: z.literal(MODELING_PROTOCOL_VERSION),
    id: modelingUuidSchema,
    documentId: modelingUuidSchema,
    baseRevisionId: modelingUuidSchema,
    title: z.string().trim().min(1).max(PROTOCOL_LIMITS.shortText),
    summary: z.string().trim().min(1).max(PROTOCOL_LIMITS.longText),
    status: z.enum([
      "needs_input",
      "validated",
      "confirmed",
      "rejected",
      "stale"
    ]),
    assumptions: z.array(z.string().trim().min(1).max(500)).max(100),
    warnings: z.array(z.string().trim().min(1).max(500)).max(100),
    missingInputs: z.array(z.string().trim().min(1).max(500)).max(100),
    expectedChecks: z.array(z.string().trim().min(1).max(500)).max(100),
    planHash: z.string().regex(/^[a-f0-9]{64}$/u),
    operationBatch: modelOperationBatchSchema.optional()
  })
  .superRefine((plan, context) => {
    if (
      (plan.status === "validated" || plan.status === "confirmed") &&
      !plan.operationBatch
    ) {
      addSemanticIssue(
        context,
        ["operationBatch"],
        `${plan.status} plans require an operation batch.`
      );
    }
    if (plan.status === "needs_input" && plan.missingInputs.length === 0) {
      addSemanticIssue(
        context,
        ["missingInputs"],
        "needs_input plans must identify at least one missing input."
      );
    }
    if (
      plan.status === "validated" &&
      (plan.missingInputs.length > 0 || plan.expectedChecks.length === 0)
    ) {
      addSemanticIssue(
        context,
        ["status"],
        "validated plans require checks and cannot retain missing inputs."
      );
    }
    if (
      plan.operationBatch &&
      plan.operationBatch.documentId !== plan.documentId
    ) {
      addSemanticIssue(
        context,
        ["operationBatch", "documentId"],
        "Plan and operation batch must target the same document."
      );
    }
    if (
      plan.operationBatch &&
      plan.operationBatch.baseRevisionId !== plan.baseRevisionId
    ) {
      addSemanticIssue(
        context,
        ["operationBatch", "baseRevisionId"],
        "Plan and operation batch must share the same base revision."
      );
    }
  });

export const engineDiagnosticSchema = z.strictObject({
  level: z.enum(["info", "warning", "error"]),
  diagnosticId: semanticRefSchema,
  message: z.string().trim().min(1).max(2_000),
  references: z.array(modelReferenceSchema).max(50)
});

export const engineArtifactSchema = z.strictObject({
  artifactId: modelingUuidSchema,
  kind: z.enum(["step", "stl", "gltf", "glb", "preview_png"]),
  mediaType: z.string().trim().min(1).max(120),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u)
});

const engineBuildCommonShape = {
  version: z.literal(MODELING_PROTOCOL_VERSION),
  jobId: modelingUuidSchema,
  documentId: modelingUuidSchema,
  revisionId: modelingUuidSchema,
  specHash: z.string().regex(/^[a-f0-9]{64}$/u),
  engine: z.strictObject({
    name: z.string().trim().min(1).max(120),
    version: z.string().trim().min(1).max(80)
  }),
  diagnostics: z.array(engineDiagnosticSchema).max(PROTOCOL_LIMITS.list),
  durationMs: z.number().int().nonnegative()
} as const;

export const engineBuildResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...engineBuildCommonShape,
    status: z.literal("succeeded"),
    artifacts: z.array(engineArtifactSchema).min(1).max(50),
    metrics: z
      .strictObject({
        bodyCount: z.number().int().nonnegative(),
        volumeMm3: z.number().finite().nonnegative(),
        surfaceAreaMm2: z.number().finite().nonnegative(),
        boundingBoxMm: z.tuple([
          z.number().finite().nonnegative(),
          z.number().finite().nonnegative(),
          z.number().finite().nonnegative()
        ]),
        centerOfMassMm: z.tuple([
          z.number().finite(),
          z.number().finite(),
          z.number().finite()
        ]),
        massKg: z.number().finite().nonnegative().nullable(),
        massStatus: z.enum([
          "computed_from_user_density",
          "unavailable_density_required"
        ]),
        triangleCount: z.number().int().nonnegative().optional()
      })
      .superRefine((metrics, context) => {
        if (
          (metrics.massStatus === "computed_from_user_density") !==
          (metrics.massKg !== null)
        ) {
          context.addIssue({
            code: "custom",
            path: ["massKg"],
            message:
              "Mass is available only when it was computed from an explicit user density."
          });
        }
      })
  }),
  z.strictObject({
    ...engineBuildCommonShape,
    status: z.literal("failed"),
    artifacts: z.array(engineArtifactSchema).max(50),
    failure: z.strictObject({
      failureKind: z.enum([
        "invalid_spec",
        "unsupported_feature",
        "engine_error",
        "resource_limit",
        "cancelled"
      ]),
      message: z.string().trim().min(1).max(2_000),
      retryable: z.boolean()
    })
  })
]);

export const jobEventSchema = z.strictObject({
  version: z.literal(MODELING_PROTOCOL_VERSION),
  eventId: modelingUuidSchema,
  jobId: modelingUuidSchema,
  sequence: z.number().int().positive(),
  occurredAt: z.iso.datetime({ offset: true }),
  type: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9_]*$/u),
  data: z.record(z.string(), z.unknown())
});

export type ModelReference = z.infer<typeof modelReferenceSchema>;
export type ModelParameter = z.infer<typeof modelParameterSchema>;
export type SketchConstraintStatus = z.infer<
  typeof sketchConstraintStatusSchema
>;
export type SketchSolveStatus = z.infer<typeof sketchSolveStatusSchema>;
export type SketchEntity = z.infer<typeof sketchEntitySchema>;
export type SketchConstraint = z.infer<typeof sketchConstraintSchema>;
export type Sketch = z.infer<typeof sketchSchema>;
export type Feature = z.infer<typeof featureSchema>;
export type Component = z.infer<typeof componentSchema>;
export type AssemblyConstraint = z.infer<typeof assemblyConstraintSchema>;
export type ModelDocument = z.infer<typeof modelDocumentSchema>;
export type ModelCollection = z.infer<typeof modelCollectionSchema>;
export type ModelOperation = z.infer<typeof modelOperationSchema>;
export type ModelOperationBatch = z.infer<typeof modelOperationBatchSchema>;
export type ModelingPlanDraft = z.infer<typeof modelingPlanDraftSchema>;
export type EngineDiagnostic = z.infer<typeof engineDiagnosticSchema>;
export type EngineArtifact = z.infer<typeof engineArtifactSchema>;
export type EngineBuildResult = z.infer<typeof engineBuildResultSchema>;
export type JobEvent = z.infer<typeof jobEventSchema>;
