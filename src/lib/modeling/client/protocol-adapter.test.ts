import { describe, expect, it } from "vitest";
import { applyOperationBatch } from "@/lib/modeling/operations";
import { createRotaryVanePumpTemplate } from "@/server/modeling/domain";
import type { ManualOperation } from "@/lib/modeling/client/workspace-state";
import type {
  Component,
  Feature,
  ModelDocument,
  Sketch,
  SketchEntity
} from "@/types/modeling";
import {
  createBlankPartDocument,
  createOperationBatchFromManualState,
  ManualModelingError
} from "./protocol-adapter";

describe("manual modeling protocol adapter", () => {
  it("maps an editable generic parameter change to the shared versioned DSL", () => {
    const blank = createBlankPartDocument("参数编辑测试");
    const parameter = {
      id: "10000000-0000-4000-8000-000000000001",
      semanticRef: "manual.parameter.width",
      name: "Width",
      label: "宽度",
      parameterType: "length" as const,
      unit: "mm" as const,
      value: 20,
      minimum: 1,
      maximum: 100,
      source: "user" as const,
      editable: true
    };
    const document: ModelDocument = {
      ...blank,
      parameters: [parameter]
    };
    const batch = createOperationBatchFromManualState(
      document,
      [
        {
          id: "set-width",
          type: "set_model_parameter",
          parameterId: parameter.id,
          semanticRef: parameter.semanticRef,
          parameterLabel: parameter.label,
          value: 24,
          previousValue: 20
        }
      ],
      "manual-parameter-update-1"
    )!;

    expect(batch.operations).toContainEqual(
      expect.objectContaining({
        kind: "update",
        collection: "parameters",
        target: { id: parameter.id, semanticRef: parameter.semanticRef },
        changes: { value: 24, source: "user" }
      })
    );
    expect(applyOperationBatch(document, batch).parameters[0]?.value).toBe(24);
  });

  it("creates a valid basic sketch and extruded body batch for a blank part", () => {
    const blank = createBlankPartDocument("测试通用零件");
    const batch = createOperationBatchFromManualState(
      blank,
      [sketchCommand(), extrudeCommand()],
      "manual-sketch-extrude-1"
    );

    expect(batch).toBeDefined();
    const next = applyOperationBatch(blank, batch!);
    expect(next.sketches).toHaveLength(1);
    expect(next.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          featureKind: "extrude",
          operation: "new_body"
        })
      ])
    );
    expect(next.components[0]?.featureRefs[0]?.semanticRef).toContain(
      ".extrude"
    );
  });

  it("adds point, line, polyline, and arc primitives to one saved sketch", () => {
    const blank = createBlankPartDocument("草图图元测试");
    const initial = applyOperationBatch(
      blank,
      createOperationBatchFromManualState(
        blank,
        [
          toolCommand("op-primitive-base", "sketch", "", {
            action: "primitive",
            plane: "xy",
            shape: "line",
            startX: -10,
            startY: 0,
            endX: 10,
            endY: 0,
            construction: false
          })
        ],
        "manual-primitive-base-1"
      )!
    );
    const sketch = initial.sketches[0]!;
    const batch = createOperationBatchFromManualState(
      initial,
      [
        sketchPrimitiveCommand("op-primitive-point", sketch, "point", {
          x: -4,
          y: 6
        }),
        sketchPrimitiveCommand("op-primitive-line", sketch, "line", {
          startX: 0,
          startY: -8,
          endX: 0,
          endY: 8
        }),
        sketchPrimitiveCommand("op-primitive-polyline", sketch, "polyline", {
          polylinePoints: "0,0;12,0;12,8;0,8",
          closed: true
        }),
        sketchPrimitiveCommand("op-primitive-arc", sketch, "arc", {
          centerX: 0,
          centerY: 0,
          startX: 10,
          startY: 0,
          endX: 0,
          endY: 10,
          clockwise: true
        })
      ],
      "manual-primitives-1"
    )!;
    const next = applyOperationBatch(initial, batch);
    const nextSketch = next.sketches[0]!;

    expect(nextSketch.entities.map((entity) => entity.entityKind)).toEqual(
      expect.arrayContaining(["point", "line", "polyline", "arc"])
    );
    expect(
      nextSketch.entities.find(
        (entity) =>
          entity.entityKind === "arc" &&
          entity.semanticRef.includes("op-primitive-arc")
      )
    ).toMatchObject({ entityKind: "arc", clockwise: true });
    expect(new Set(nextSketch.entities.map((entity) => entity.id)).size).toBe(
      nextSketch.entities.length
    );
    expect(
      new Set(nextSketch.entities.map((entity) => entity.semanticRef)).size
    ).toBe(nextSketch.entities.length);
    expect(
      nextSketch.entities.every((entity) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          entity.id
        )
      )
    ).toBe(true);
  });

  it("adds all V1 sketch constraints with exact entity references and dimensions", () => {
    const document = sketchConstraintFixtureDocument();
    const sketch = document.sketches[0]!;
    const lines = sketch.entities.filter(entityOfKind("line"));
    const points = sketch.entities.filter(entityOfKind("point"));
    const circle = sketch.entities.find(entityOfKind("circle"))!;
    const arc = sketch.entities.find(entityOfKind("arc"))!;
    const operations: ManualOperation[] = [
      sketchConstraintCommand("op-constraint-fixed", sketch, "fixed", [
        lines[0]!
      ]),
      sketchConstraintCommand(
        "op-constraint-coincident",
        sketch,
        "coincident",
        [points[0]!, points[1]!]
      ),
      sketchConstraintCommand(
        "op-constraint-horizontal",
        sketch,
        "horizontal",
        [lines[0]!]
      ),
      sketchConstraintCommand("op-constraint-vertical", sketch, "vertical", [
        lines[1]!
      ]),
      sketchConstraintCommand("op-constraint-parallel", sketch, "parallel", [
        lines[0]!,
        lines[1]!
      ]),
      sketchConstraintCommand(
        "op-constraint-perpendicular",
        sketch,
        "perpendicular",
        [lines[0]!, lines[1]!]
      ),
      sketchConstraintCommand("op-constraint-tangent", sketch, "tangent", [
        lines[0]!,
        arc
      ]),
      sketchConstraintCommand("op-constraint-equal-length", sketch, "equal", [
        lines[0]!,
        lines[1]!
      ]),
      sketchConstraintCommand("op-constraint-equal-radius", sketch, "equal", [
        circle,
        arc
      ]),
      sketchConstraintCommand("op-constraint-midpoint", sketch, "midpoint", [
        points[0]!,
        lines[0]!
      ]),
      sketchConstraintCommand("op-constraint-symmetric", sketch, "symmetric", [
        points[0]!,
        points[1]!,
        lines[0]!
      ]),
      sketchConstraintCommand(
        "op-constraint-distance",
        sketch,
        "distance",
        [points[0]!, points[1]!],
        12
      ),
      sketchConstraintCommand(
        "op-constraint-angle",
        sketch,
        "angle",
        [lines[0]!, lines[1]!],
        90
      ),
      sketchConstraintCommand(
        "op-constraint-radius",
        sketch,
        "radius",
        [arc],
        10
      ),
      sketchConstraintCommand(
        "op-constraint-diameter",
        sketch,
        "diameter",
        [circle],
        20
      )
    ];
    const batch = createOperationBatchFromManualState(
      document,
      operations,
      "manual-sketch-constraints-1"
    )!;
    const next = applyOperationBatch(document, batch);
    const constraints = next.sketches[0]!.constraints;

    expect(constraints.map((constraint) => constraint.constraintKind)).toEqual([
      "fixed",
      "coincident",
      "horizontal",
      "vertical",
      "parallel",
      "perpendicular",
      "tangent",
      "equal",
      "equal",
      "midpoint",
      "symmetric",
      "distance",
      "angle",
      "radius",
      "diameter"
    ]);
    for (const constraint of constraints) {
      expect(
        constraint.targetRefs.every((target) =>
          sketch.entities.some(
            (entity) =>
              entity.id === target.id &&
              entity.semanticRef === target.semanticRef
          )
        )
      ).toBe(true);
    }
    for (const kind of ["distance", "radius", "diameter"] as const) {
      const constraint = constraints.find(
        (candidate) => candidate.constraintKind === kind
      )!;
      expect(
        next.parameters.find(
          (parameter) => parameter.id === constraint.parameterRef?.id
        )
      ).toMatchObject({ parameterType: "length", unit: "mm" });
    }
    const angle = constraints.find(
      (constraint) => constraint.constraintKind === "angle"
    )!;
    expect(
      next.parameters.find(
        (parameter) => parameter.id === angle.parameterRef?.id
      )
    ).toMatchObject({ parameterType: "angle", unit: "deg", value: 90 });
  });

  it("rejects stale sketch/entity identity pairs and incompatible constraints", () => {
    const document = sketchConstraintFixtureDocument();
    const sketch = document.sketches[0]!;
    const line = sketch.entities.find(entityOfKind("line"))!;

    expect(() =>
      createOperationBatchFromManualState(
        document,
        [
          toolCommand("op-stale-sketch", "sketch", "", {
            action: "constraint",
            targetSketchId: sketch.id,
            targetSketchRef: `${sketch.semanticRef}.stale`,
            constraintKind: "fixed",
            target0Id: line.id,
            target0Ref: line.semanticRef
          })
        ],
        "manual-stale-sketch-1"
      )
    ).toThrow(/目标草图已变化/u);

    expect(() =>
      createOperationBatchFromManualState(
        document,
        [
          sketchConstraintCommand(
            "op-invalid-coincident",
            sketch,
            "coincident",
            [line, sketch.entities.filter(entityOfKind("line"))[1]!]
          )
        ],
        "manual-invalid-constraint-1"
      )
    ).toThrow(/求解器契约/u);
  });

  it("builds real selected-feature operations for cut and finishing tools", () => {
    const blank = createBlankPartDocument("高级特征测试");
    const firstBatch = createOperationBatchFromManualState(
      blank,
      [sketchCommand(), extrudeCommand()],
      "manual-base-feature-1"
    );
    const base = applyOperationBatch(blank, firstBatch!);
    const extrude = base.features.find(
      (feature) => feature.featureKind === "extrude"
    )!;
    const selected = `feature:${extrude.semanticRef}`;
    const commands: ManualOperation[] = [
      toolCommand("op-slot-1", "slot", selected, {
        plane: "xy",
        length: 20,
        width: 5
      }),
      toolCommand("op-cut-1", "cut", selected, {
        distance: 8,
        direction: "normal"
      }),
      toolCommand("op-hole-1", "hole", selected, {
        diameter: 4,
        termination: "through_all",
        depth: 6,
        faceSelector: "front"
      }),
      toolCommand("op-fillet-1", "fillet", selected, {
        radius: 1,
        edgeSelector: "vertical"
      }),
      toolCommand("op-chamfer-1", "chamfer", selected, {
        distance: 0.8,
        edgeSelector: "top"
      }),
      toolCommand("op-mirror-1", "mirror", selected, { plane: "yz" }),
      toolCommand("op-linear-1", "linear-pattern", selected, {
        count: 3,
        spacing: 16,
        axis: "x"
      }),
      toolCommand("op-circular-1", "circular-pattern", selected, {
        count: 4,
        totalAngle: 360,
        axis: "z"
      }),
      toolCommand("op-reorder-1", "reorder", selected, {
        direction: "earlier"
      })
    ];

    const batch = createOperationBatchFromManualState(
      base,
      commands,
      "manual-finishing-tools-1"
    )!;
    const addedFeatureKinds = batch.operations.flatMap((operation) =>
      operation.kind === "add" &&
      operation.collection === "features" &&
      "featureKind" in operation.item
        ? [operation.item.featureKind]
        : []
    );

    expect(addedFeatureKinds).toEqual(
      expect.arrayContaining([
        "boolean",
        "hole",
        "fillet",
        "chamfer",
        "mirror",
        "linear_pattern",
        "circular_pattern"
      ])
    );
    expect(
      batch.operations.some((operation) => operation.kind === "reorder")
    ).toBe(true);
    expect(
      batch.operations.find(
        (operation) =>
          operation.kind === "add" &&
          operation.collection === "features" &&
          "featureKind" in operation.item &&
          operation.item.featureKind === "hole"
      )
    ).toMatchObject({
      item: {
        placement: {
          placementKind: "semantic_face",
          faceSelector: "front"
        }
      }
    });
  });

  it("submits explicit suppress operations for a selected general feature", () => {
    const blank = createBlankPartDocument("抑制测试");
    const firstBatch = createOperationBatchFromManualState(
      blank,
      [sketchCommand(), extrudeCommand()],
      "manual-suppress-base-1"
    )!;
    const base = applyOperationBatch(blank, firstBatch);
    const feature = base.features[0]!;

    const batch = createOperationBatchFromManualState(
      base,
      [
        {
          id: "op-suppress-1",
          type: "set_feature_suppressed",
          featureId: feature.id,
          semanticRef: feature.semanticRef,
          featureName: feature.name,
          suppressed: true
        }
      ],
      "manual-suppress-feature-1"
    )!;

    expect(batch.operations).toContainEqual(
      expect.objectContaining({
        kind: "suppress",
        collection: "features",
        target: {
          id: feature.id,
          semanticRef: feature.semanticRef
        },
        suppressed: true
      })
    );
  });

  it("blocks generic feature commands on the rotary-vane template", () => {
    const pump = createRotaryVanePumpTemplate({
      documentId: "11111111-1111-4111-8111-111111111111",
      revisionId: "22222222-2222-4222-8222-222222222222",
      name: "旋片泵模板"
    });

    expect(() =>
      createOperationBatchFromManualState(
        pump,
        [sketchCommand()],
        "pump-generic-feature-1"
      )
    ).toThrow(ManualModelingError);
  });

  it("updates every eccentricity-derived pump field in the same batch", () => {
    const pump = createRotaryVanePumpTemplate({
      documentId: "11111111-1111-4111-8111-111111111111",
      revisionId: "22222222-2222-4222-8222-222222222222",
      name: "旋片泵模板"
    });
    const eccentricity = 7.5;

    const batch = createOperationBatchFromManualState(
      pump,
      [
        {
          id: "op-pump-eccentricity",
          type: "set_parameter",
          parameterId: "eccentricity",
          value: eccentricity
        }
      ],
      "pump-eccentricity-1"
    )!;

    expect(batch.operations).toHaveLength(6);
    expect(batch.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "update",
          collection: "parameters",
          target: expect.objectContaining({
            semanticRef: "pump.parameter.eccentricity"
          }),
          changes: expect.objectContaining({ value: eccentricity })
        }),
        expect.objectContaining({
          kind: "update",
          collection: "sketches",
          changes: expect.objectContaining({
            entities: expect.arrayContaining([
              expect.objectContaining({
                semanticRef: "pump.sketch.cross-section.rotor-center",
                entityKind: "point",
                x: eccentricity
              })
            ])
          })
        }),
        expect.objectContaining({
          kind: "update",
          collection: "sketches",
          target: expect.objectContaining({
            semanticRef: "pump.sketch.front-cover-profile"
          }),
          changes: expect.objectContaining({
            entities: expect.arrayContaining([
              expect.objectContaining({
                semanticRef: "pump.sketch.front-cover-profile.bore-center",
                entityKind: "point",
                x: eccentricity
              })
            ])
          })
        }),
        expect.objectContaining({
          kind: "update",
          collection: "sketches",
          target: expect.objectContaining({
            semanticRef: "pump.sketch.rear-cover-profile"
          }),
          changes: expect.objectContaining({
            entities: expect.arrayContaining([
              expect.objectContaining({
                semanticRef: "pump.sketch.rear-cover-profile.bore-center",
                entityKind: "point",
                x: eccentricity
              })
            ])
          })
        }),
        expect.objectContaining({
          kind: "update",
          collection: "features",
          target: expect.objectContaining({
            semanticRef: "pump.feature.vane-pattern"
          }),
          changes: { axisOrigin: [eccentricity, 0, 0] }
        }),
        expect.objectContaining({
          kind: "update",
          collection: "components",
          target: expect.objectContaining({
            semanticRef: "pump.component.rotating-group"
          }),
          changes: expect.objectContaining({
            transform: expect.objectContaining({
              translationMm: [eccentricity, 0, 0]
            })
          })
        })
      ])
    );

    const next = applyOperationBatch(pump, batch);
    expect(
      next.parameters.find(
        (parameter) => parameter.semanticRef === "pump.parameter.eccentricity"
      )?.value
    ).toBe(eccentricity);
    expect(
      next.sketches
        .flatMap((sketch) => sketch.entities)
        .find(
          (entity) =>
            entity.semanticRef === "pump.sketch.cross-section.rotor-center"
        )
    ).toEqual(expect.objectContaining({ x: eccentricity, y: 0 }));
    expect(
      next.features.find(
        (feature) => feature.semanticRef === "pump.feature.vane-pattern"
      )
    ).toEqual(expect.objectContaining({ axisOrigin: [eccentricity, 0, 0] }));
    expect(
      next.components.find(
        (component) => component.semanticRef === "pump.component.rotating-group"
      )?.transform.translationMm
    ).toEqual([eccentricity, 0, 0]);
    expect(
      next.sketches
        .flatMap((sketch) => sketch.entities)
        .filter((entity) => entity.semanticRef.endsWith("bore-center"))
    ).toEqual([
      expect.objectContaining({ x: eccentricity, y: 0 }),
      expect.objectContaining({ x: eccentricity, y: 0 })
    ]);
    expect(
      next.parameters.find(
        (parameter) => parameter.semanticRef === "pump.parameter.vane-count"
      )?.value
    ).toBe(2);
  });

  it("recomputes cover dimensions and placement from driving parameters", () => {
    const pump = createRotaryVanePumpTemplate({
      documentId: "11111111-1111-4111-8111-111111111111",
      revisionId: "22222222-2222-4222-8222-222222222222",
      name: "旋片泵模板"
    });
    const batch = createOperationBatchFromManualState(
      pump,
      [
        {
          id: "op-pump-chamber",
          type: "set_parameter",
          parameterId: "cavityDiameter",
          value: 120
        },
        {
          id: "op-pump-shaft",
          type: "set_parameter",
          parameterId: "shaftDiameter",
          value: 24
        },
        {
          id: "op-pump-width",
          type: "set_parameter",
          parameterId: "axialWidth",
          value: 72
        }
      ],
      "pump-cover-derived-1"
    )!;
    const next = applyOperationBatch(pump, batch);
    const value = (semanticRef: string) =>
      next.parameters.find((parameter) => parameter.semanticRef === semanticRef)
        ?.value;

    expect(value("pump.parameter.cover-outer-diameter")).toBeCloseTo(141.6);
    expect(value("pump.parameter.cover-thickness")).toBeCloseTo(8.1);
    expect(value("pump.parameter.cover-bore-diameter")).toBe(26);
    expect(
      next.components.find(
        (component) => component.semanticRef === "pump.component.rear-cover"
      )?.transform.translationMm
    ).toEqual([0, 0, 72]);
    expect(
      batch.operations.filter(
        (operation) =>
          operation.kind === "update" &&
          operation.collection === "parameters" &&
          "source" in operation.changes &&
          operation.changes.source === "derived"
      )
    ).toHaveLength(3);
  });

  it("rejects an eccentricity update when a derived pump reference is missing", () => {
    const pump = createRotaryVanePumpTemplate({
      documentId: "11111111-1111-4111-8111-111111111111",
      revisionId: "22222222-2222-4222-8222-222222222222",
      name: "旋片泵模板"
    });
    const inconsistentPump = {
      ...pump,
      components: pump.components.filter(
        (component) => component.semanticRef !== "pump.component.rotating-group"
      )
    };

    expect(() =>
      createOperationBatchFromManualState(
        inconsistentPump,
        [
          {
            id: "op-pump-eccentricity-invalid-template",
            type: "set_parameter",
            parameterId: "eccentricity",
            value: 7
          }
        ],
        "pump-eccentricity-invalid-template-1"
      )
    ).toThrow(/避免参数、几何和装配状态漂移/u);
  });

  it("rejects pump part suppression because the dedicated builder ignores it", () => {
    const pump = createRotaryVanePumpTemplate({
      documentId: "11111111-1111-4111-8111-111111111111",
      revisionId: "22222222-2222-4222-8222-222222222222",
      name: "旋片泵模板"
    });

    expect(() =>
      createOperationBatchFromManualState(
        pump,
        [
          {
            id: "op-pump-suppress",
            type: "set_part_suppressed",
            partId: "vane-1",
            suppressed: true
          }
        ],
        "pump-suppress-1"
      )
    ).toThrow(/不消费部件抑制/u);
  });

  it.each(["union", "subtract", "intersect"] as const)(
    "creates a real %s boolean and consumes the tool component",
    (operation) => {
      const base = twoBodyDocument();
      const [target, tool] = base.features;
      const batch = createOperationBatchFromManualState(
        base,
        [
          {
            id: `op-boolean-${operation}`,
            type: "add_boolean_feature",
            operation,
            targets: [featureSelection(target!), featureSelection(tool!)]
          }
        ],
        `manual-boolean-${operation}-1`
      )!;
      const next = applyOperationBatch(base, batch);
      const result = next.features.find(
        (feature) =>
          feature.featureKind === "boolean" && feature.operation === operation
      );

      expect(result).toBeDefined();
      expect(
        next.components.find((component) =>
          component.featureRefs.some(
            (reference) => reference.semanticRef === result?.semanticRef
          )
        )
      ).toBeDefined();
      expect(next.components.some((component) => component.suppressed)).toBe(
        true
      );
    }
  );

  it("rejects boolean operations on transformed component instances", () => {
    const base = twoBodyDocument();
    const transformed: ModelDocument = {
      ...base,
      components: base.components.map((component, index) =>
        index === 1
          ? {
              ...component,
              transform: {
                ...component.transform,
                translationMm: [10, 0, 0]
              }
            }
          : component
      )
    };

    expect(() =>
      createOperationBatchFromManualState(
        transformed,
        [
          {
            id: "op-boolean-transformed",
            type: "add_boolean_feature",
            operation: "union",
            targets: transformed.features.map(featureSelection)
          }
        ],
        "manual-boolean-transformed-1"
      )
    ).toThrow(/原始坐标系/u);
  });

  it("creates component instances and the four supported assembly constraints", () => {
    const blank = createBlankPartDocument("装配测试");
    const base = applyOperationBatch(
      blank,
      createOperationBatchFromManualState(
        blank,
        [sketchCommand(), extrudeCommand()],
        "manual-assembly-base-1"
      )!
    );
    const source = base.components[0]!;
    const instancesBatch = createOperationBatchFromManualState(
      base,
      [
        componentInstance("op-instance-zero", source, [0, 0, 0]),
        componentInstance("op-instance-z", source, [0, 0, 20])
      ],
      "manual-assembly-instances-1"
    )!;
    const withInstances = applyOperationBatch(base, instancesBatch);
    const [fixed, coincident, distance] = withInstances.components;
    const constraintsBatch = createOperationBatchFromManualState(
      withInstances,
      [
        assemblyConstraint("op-fixed", "fixed", [fixed!]),
        assemblyConstraint("op-coincident", "coincident", [
          fixed!,
          coincident!
        ]),
        assemblyConstraint("op-concentric", "concentric", [fixed!, distance!]),
        {
          ...assemblyConstraint("op-distance", "distance", [fixed!, distance!]),
          distanceMm: 20
        }
      ],
      "manual-assembly-constraints-1"
    )!;
    const next = applyOperationBatch(withInstances, constraintsBatch);

    expect(next.components).toHaveLength(3);
    expect(next.components[2]?.transform.translationMm).toEqual([0, 0, 20]);
    expect(next.assemblyConstraints.map((item) => item.constraintKind)).toEqual(
      ["fixed", "coincident", "concentric", "distance"]
    );
    const distanceConstraint = next.assemblyConstraints.find(
      (item) => item.constraintKind === "distance"
    );
    expect(distanceConstraint?.parameterRef?.semanticRef).toContain(
      "assembly-distance"
    );
  });
});

function sketchCommand(): ManualOperation {
  return toolCommand("op-sketch-1", "sketch", "", {
    plane: "xy",
    shape: "rectangle",
    width: 40,
    height: 30,
    diameter: 30
  });
}

function extrudeCommand(): ManualOperation {
  return toolCommand("op-extrude-1", "extrude", "", {
    distance: 20,
    direction: "normal"
  });
}

function toolCommand(
  id: string,
  tool: Extract<ManualOperation, { type: "tool_command" }>["tool"],
  targetPartId: string,
  settings: Record<string, number | string | boolean>
): ManualOperation {
  return { id, type: "tool_command", tool, targetPartId, settings };
}

function sketchPrimitiveCommand(
  id: string,
  sketch: Sketch,
  shape: "point" | "line" | "polyline" | "rectangle" | "circle" | "arc",
  settings: Record<string, number | string | boolean>
): ManualOperation {
  return toolCommand(id, "sketch", "", {
    action: "primitive",
    targetSketchId: sketch.id,
    targetSketchRef: sketch.semanticRef,
    shape,
    construction: false,
    ...settings
  });
}

function sketchConstraintCommand(
  id: string,
  sketch: Sketch,
  constraintKind:
    | "fixed"
    | "coincident"
    | "horizontal"
    | "vertical"
    | "parallel"
    | "perpendicular"
    | "tangent"
    | "equal"
    | "midpoint"
    | "symmetric"
    | "distance"
    | "angle"
    | "radius"
    | "diameter",
  targets: SketchEntity[],
  value?: number
): ManualOperation {
  const targetSettings = Object.fromEntries(
    targets.flatMap((target, index) => [
      [`target${index}Id`, target.id],
      [`target${index}Ref`, target.semanticRef]
    ])
  );
  return toolCommand(id, "sketch", "", {
    action: "constraint",
    targetSketchId: sketch.id,
    targetSketchRef: sketch.semanticRef,
    constraintKind,
    ...targetSettings,
    ...(value === undefined ? {} : { value })
  });
}

function sketchConstraintFixtureDocument() {
  const blank = createBlankPartDocument("草图约束测试");
  const initial = applyOperationBatch(
    blank,
    createOperationBatchFromManualState(
      blank,
      [
        toolCommand("op-fixture-line-a", "sketch", "", {
          action: "primitive",
          plane: "xy",
          shape: "line",
          startX: -10,
          startY: 0,
          endX: 10,
          endY: 0,
          construction: false
        })
      ],
      "manual-sketch-fixture-base-1"
    )!
  );
  const sketch = initial.sketches[0]!;
  return applyOperationBatch(
    initial,
    createOperationBatchFromManualState(
      initial,
      [
        sketchPrimitiveCommand("op-fixture-line-b", sketch, "line", {
          startX: 0,
          startY: -10,
          endX: 0,
          endY: 10
        }),
        sketchPrimitiveCommand("op-fixture-circle", sketch, "circle", {
          diameter: 20
        }),
        sketchPrimitiveCommand("op-fixture-arc", sketch, "arc", {
          centerX: 0,
          centerY: 0,
          startX: 10,
          startY: 0,
          endX: 0,
          endY: 10,
          clockwise: false
        })
      ],
      "manual-sketch-fixture-primitives-1"
    )!
  );
}

function entityOfKind<Kind extends SketchEntity["entityKind"]>(kind: Kind) {
  return (
    entity: SketchEntity
  ): entity is Extract<SketchEntity, { entityKind: Kind }> =>
    entity.entityKind === kind;
}

function twoBodyDocument() {
  const blank = createBlankPartDocument("双实体布尔测试");
  return applyOperationBatch(
    blank,
    createOperationBatchFromManualState(
      blank,
      [
        toolCommand("op-sketch-a", "sketch", "", {
          plane: "xy",
          shape: "rectangle",
          width: 40,
          height: 30,
          diameter: 30
        }),
        toolCommand("op-extrude-a", "extrude", "", {
          distance: 20,
          direction: "normal"
        }),
        toolCommand("op-sketch-b", "sketch", "", {
          plane: "xy",
          shape: "circle",
          width: 20,
          height: 20,
          diameter: 12
        }),
        toolCommand("op-extrude-b", "extrude", "", {
          distance: 20,
          direction: "normal"
        })
      ],
      "manual-two-body-base-1"
    )!
  );
}

function featureSelection(feature: Feature) {
  return {
    collection: "features" as const,
    id: feature.id,
    semanticRef: feature.semanticRef,
    name: feature.name
  };
}

function componentSelection(component: Component) {
  return {
    collection: "components" as const,
    id: component.id,
    semanticRef: component.semanticRef,
    name: component.name
  };
}

function componentInstance(
  id: string,
  source: Component,
  translationMm: [number, number, number]
): ManualOperation {
  return {
    id,
    type: "add_component_instance",
    source: componentSelection(source),
    name: `${source.name} ${id}`,
    translationMm,
    rotationDegrees: [0, 0, 0]
  };
}

function assemblyConstraint(
  id: string,
  constraintKind: Extract<
    ManualOperation,
    { type: "add_assembly_constraint" }
  >["constraintKind"],
  targets: Component[]
): Extract<ManualOperation, { type: "add_assembly_constraint" }> {
  return {
    id,
    type: "add_assembly_constraint",
    constraintKind,
    targets: targets.map(componentSelection)
  };
}
