import { applyOperationBatch } from "@/lib/modeling/operations";
import { expandRotaryVanePumpDerivedOperations } from "@/lib/modeling/pump-derived";
import {
  createGenericPumpDocument,
  V1_VANE_COUNT,
  type ManualOperation,
  type ModelingDocumentKind,
  type ModelingSelection,
  type PumpDocument,
  type PumpParameterId
} from "@/lib/modeling/client/workspace-state";
import {
  modelOperationBatchSchema,
  type AssemblyConstraint,
  type Component,
  type Feature,
  type ModelDocument,
  type ModelOperation,
  type ModelOperationBatch,
  type ModelParameter,
  type ModelReference,
  type Sketch,
  type SketchEntity
} from "@/types/modeling";

const PARAMETER_REFS: Record<PumpParameterId, string> = {
  cavityDiameter: "pump.parameter.chamber-diameter",
  rotorDiameter: "pump.parameter.rotor-diameter",
  eccentricity: "pump.parameter.eccentricity",
  axialWidth: "pump.parameter.axial-width",
  vaneCount: "pump.parameter.vane-count",
  vaneThickness: "pump.parameter.vane-thickness",
  vaneHeight: "pump.parameter.vane-height",
  shaftDiameter: "pump.parameter.shaft-diameter",
  inletWidth: "pump.parameter.inlet-width",
  outletWidth: "pump.parameter.outlet-width"
};

const PART_FEATURE_REFS: Record<string, string | undefined> = {
  "pump-body": "pump.feature.chamber-volume",
  "eccentric-rotor": "pump.feature.rotor",
  "vane-1": "pump.feature.vane-pattern",
  "vane-2": "pump.feature.vane-pattern",
  "main-shaft": "pump.feature.shaft",
  inlet: "pump.feature.inlet-port",
  outlet: "pump.feature.outlet-port"
};

const PART_NAMES: Record<string, string | undefined> = {
  "pump-body": "泵体",
  "eccentric-rotor": "偏心转子",
  "vane-1": "旋片 1",
  "vane-2": "旋片 2",
  "main-shaft": "主轴",
  "front-cover": "前端盖",
  "back-cover": "后端盖",
  inlet: "进气口",
  outlet: "排气口",
  "mounting-base": "安装底座"
};

const GENERAL_FEATURE_PREFIX = "feature:";

export class ManualModelingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManualModelingError";
  }
}

export type ManualToolContext = {
  documentKind: ModelingDocumentKind;
  manualFeaturesEnabled: boolean;
  selectedEntityName: string;
  selectedFeatureName?: string;
  profileName?: string;
  revolveProfileName?: string;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
  selectionCount: number;
  selectedFeatures: Array<{ id: string; semanticRef: string; name: string }>;
  selectedComponents: Array<{
    id: string;
    semanticRef: string;
    name: string;
  }>;
  sketches: Array<{
    id: string;
    semanticRef: string;
    name: string;
    plane: Sketch["plane"];
    entities: Array<{
      id: string;
      semanticRef: string;
      entityKind: SketchEntity["entityKind"];
      label: string;
      construction: boolean;
    }>;
  }>;
  suggestedDistanceMm?: number;
  disabledReason?: string;
};

type BatchBuilder = {
  operations: ModelOperation[];
  parameters: ModelParameter[];
  sketches: Sketch[];
  features: Feature[];
  components: Component[];
};

type ProfileSelection = {
  sketch: Sketch;
  profile: SketchEntity;
  axis?: Extract<SketchEntity, { entityKind: "line" }>;
};

export function modelingDocumentKind(
  document: ModelDocument
): ModelingDocumentKind {
  return document.metadata?.template ? "pump-template" : "general-part";
}

export function createBlankPartDocument(name: string): ModelDocument {
  return {
    version: "openvac.modeling.v1",
    id: uuid(),
    revision: 0,
    revisionId: uuid(),
    name: name.trim() || "未命名通用零件",
    unitSystem: "mm-deg",
    parameters: [],
    sketches: [],
    features: [],
    components: [],
    assemblyConstraints: [],
    metadata: {
      description: "OpenVac 手工工作台创建的非模板通用零件。",
      tags: ["manual-modeling"]
    }
  };
}

export function getManualToolContext(
  document: ModelDocument,
  selectedPartId: string,
  manualOperations: ManualOperation[],
  semanticSelections: ModelingSelection[] = []
): ManualToolContext {
  const documentKind = modelingDocumentKind(document);
  const selected = selectedFeature(document.features, selectedPartId);
  const profile = latestProfile(document.sketches);
  const revolveProfile = latestRevolveProfile(document.sketches);
  const pendingProfile = [...manualOperations]
    .reverse()
    .find(
      (
        operation
      ): operation is Extract<ManualOperation, { type: "tool_command" }> =>
        operation.type === "tool_command" &&
        (operation.tool === "sketch" || operation.tool === "slot")
    );
  const selectedIndex = selected
    ? document.features.findIndex((feature) => feature.id === selected.id)
    : -1;
  const selectedFeatures = semanticSelections.flatMap((selection) => {
    if (selection.collection !== "features") return [];
    const feature = document.features.find(
      (candidate) =>
        candidate.id === selection.id &&
        candidate.semanticRef === selection.semanticRef
    );
    return feature
      ? [
          {
            id: feature.id,
            semanticRef: feature.semanticRef,
            name: feature.name
          }
        ]
      : [];
  });
  const selectedComponents = semanticSelections.flatMap((selection) => {
    if (selection.collection !== "components") return [];
    const component = document.components.find(
      (candidate) =>
        candidate.id === selection.id &&
        candidate.semanticRef === selection.semanticRef
    );
    return component
      ? [
          {
            id: component.id,
            semanticRef: component.semanticRef,
            name: component.name
          }
        ]
      : [];
  });
  const firstSelectedComponent = document.components.find(
    (component) => component.id === selectedComponents[0]?.id
  );
  const secondSelectedComponent = document.components.find(
    (component) => component.id === selectedComponents[1]?.id
  );
  const suggestedDistanceMm =
    firstSelectedComponent && secondSelectedComponent
      ? componentDistance(firstSelectedComponent, secondSelectedComponent)
      : undefined;

  return {
    documentKind,
    manualFeaturesEnabled: documentKind === "general-part",
    selectedEntityName:
      selected?.name ??
      PART_NAMES[selectedPartId] ??
      (selectedPartId ? "当前选择" : "未选择实体"),
    selectedFeatureName: selected?.name,
    profileName: pendingProfile
      ? pendingProfile.tool === "slot"
        ? "待保存的开槽草图"
        : "待保存的基础草图"
      : profile?.sketch.name,
    revolveProfileName:
      pendingProfile?.tool === "sketch"
        ? "待保存的基础草图"
        : revolveProfile?.sketch.name,
    canMoveEarlier: selectedIndex > 0,
    canMoveLater:
      selectedIndex >= 0 && selectedIndex < document.features.length - 1,
    selectionCount: semanticSelections.length,
    selectedFeatures,
    selectedComponents,
    sketches: document.sketches
      .filter((sketch) => !sketch.suppressed)
      .map((sketch) => ({
        id: sketch.id,
        semanticRef: sketch.semanticRef,
        name: sketch.name,
        plane: sketch.plane,
        entities: sketch.entities.map((entity, index) => ({
          id: entity.id,
          semanticRef: entity.semanticRef,
          entityKind: entity.entityKind,
          label: `${index + 1}. ${sketchEntityLabel(entity)}${entity.construction ? " · 构造" : ""}`,
          construction: entity.construction
        }))
      })),
    suggestedDistanceMm,
    disabledReason:
      documentKind === "pump-template"
        ? "旋片泵模板由专用参数化内核构建；通用特征不会作用于该模板。请新建“空白通用零件”。"
        : undefined
  };
}

export function selectedModelSemanticRefs(
  document: ModelDocument,
  selectedPartId: string,
  semanticSelections: ModelingSelection[] = []
): string[] {
  if (semanticSelections.length) {
    return [
      ...new Set(
        semanticSelections.flatMap((selection) => {
          const collection =
            selection.collection === "features"
              ? document.features
              : document.components;
          return collection.some(
            (item) =>
              item.id === selection.id &&
              item.semanticRef === selection.semanticRef
          )
            ? [selection.semanticRef]
            : [];
        })
      )
    ];
  }
  if (selectedPartId.startsWith(GENERAL_FEATURE_PREFIX)) {
    const semanticRef = selectedPartId.slice(GENERAL_FEATURE_PREFIX.length);
    return document.features.some(
      (feature) => feature.semanticRef === semanticRef
    )
      ? [semanticRef]
      : [];
  }
  const feature = selectedFeature(document.features, selectedPartId);
  return feature ? [feature.semanticRef] : [];
}

export function pumpDocumentFromModelDocument(
  document: ModelDocument
): PumpDocument {
  const pump = createGenericPumpDocument();
  const parameterByRef = new Map(
    document.parameters.map((parameter) => [parameter.semanticRef, parameter])
  );

  for (const [parameterId, semanticRef] of Object.entries(PARAMETER_REFS) as [
    PumpParameterId,
    string
  ][]) {
    const parameter = parameterByRef.get(semanticRef);
    if (parameterId === "vaneCount") {
      pump.parameters.vaneCount = V1_VANE_COUNT;
    } else if (parameter) {
      pump.parameters[parameterId] = parameter.value;
    }
  }

  return pump;
}

export function mergePumpStateIntoModelDocument(
  document: ModelDocument,
  pump: PumpDocument
): ModelDocument {
  const parameterIdByRef = new Map(
    Object.entries(PARAMETER_REFS).map(([parameterId, semanticRef]) => [
      semanticRef,
      parameterId as PumpParameterId
    ])
  );
  return {
    ...document,
    parameters: document.parameters.map((parameter) => {
      const parameterId = parameterIdByRef.get(parameter.semanticRef);
      return parameterId
        ? {
            ...parameter,
            value:
              parameterId === "vaneCount"
                ? V1_VANE_COUNT
                : pump.parameters[parameterId],
            source: "user" as const
          }
        : parameter;
    })
  };
}

export function isModelDocument(value: unknown): value is ModelDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ModelDocument>;
  return (
    candidate.version === "openvac.modeling.v1" &&
    typeof candidate.id === "string" &&
    typeof candidate.revisionId === "string" &&
    Array.isArray(candidate.parameters) &&
    Array.isArray(candidate.features) &&
    Array.isArray(candidate.components)
  );
}

export function createOperationBatchFromManualState(
  document: ModelDocument,
  manualOperations: ManualOperation[],
  idempotencyKey: string
): ModelOperationBatch | undefined {
  const builder: BatchBuilder = {
    operations: [],
    parameters: [...document.parameters],
    sketches: [...document.sketches],
    features: [...document.features],
    components: [...document.components]
  };
  for (const operation of manualOperations) {
    if (operation.type === "set_model_parameter") {
      const parameter = builder.parameters.find(
        (candidate) =>
          candidate.id === operation.parameterId &&
          candidate.semanticRef === operation.semanticRef
      );
      if (!parameter) {
        throw new ManualModelingError(
          `无法更新“${operation.parameterLabel}”：参数已不在当前基础修订中。`
        );
      }
      if (!parameter.editable) {
        throw new ManualModelingError(
          `参数“${operation.parameterLabel}”不可手工编辑。`
        );
      }
      builder.operations.push({
        operationId: uuid(),
        kind: "update",
        collection: "parameters",
        target: reference(parameter),
        changes: { value: operation.value, source: "user" }
      });
      builder.parameters = builder.parameters.map((candidate) =>
        candidate.id === parameter.id
          ? { ...candidate, value: operation.value, source: "user" as const }
          : candidate
      );
      continue;
    }

    if (operation.type === "set_parameter") {
      if (
        operation.parameterId === "vaneCount" &&
        operation.value !== V1_VANE_COUNT
      ) {
        throw new ManualModelingError("V1 旋片数量固定为 2，不能写入其他值。");
      }
      const parameter = builder.parameters.find(
        (candidate) =>
          candidate.semanticRef === PARAMETER_REFS[operation.parameterId]
      );
      if (!parameter) {
        throw new ManualModelingError(
          `旋片泵模板缺少参数 ${PARAMETER_REFS[operation.parameterId]}。`
        );
      }
      builder.operations.push({
        operationId: uuid(),
        kind: "update",
        collection: "parameters",
        target: reference(parameter),
        changes: { value: operation.value, source: "user" }
      });
      builder.parameters = builder.parameters.map((candidate) =>
        candidate.id === parameter.id
          ? { ...candidate, value: operation.value, source: "user" as const }
          : candidate
      );
      continue;
    }

    if (operation.type === "set_part_suppressed") {
      throw new ManualModelingError(
        "V1 旋片泵专用构建器不消费部件抑制；只能使用本地显示/隐藏，不能伪装为求解操作。"
      );
    }

    if (operation.type === "set_feature_suppressed") {
      const feature = builder.features.find(
        (candidate) =>
          candidate.id === operation.featureId &&
          candidate.semanticRef === operation.semanticRef
      );
      if (!feature) {
        throw new ManualModelingError(
          `无法抑制“${operation.featureName}”：目标特征已不在当前基础修订中。`
        );
      }
      stageSuppressFeature(builder, feature, operation.suppressed);
      continue;
    }

    if (operation.type === "add_boolean_feature") {
      if (modelingDocumentKind(document) !== "general-part") {
        throw new ManualModelingError(
          "旋片泵模板使用专用构建器，不能追加通用布尔历史。"
        );
      }
      stageBooleanFeature(
        builder,
        semanticToken(operation.id),
        operation.operation,
        operation.targets
      );
      continue;
    }

    if (operation.type === "add_component_instance") {
      if (modelingDocumentKind(document) !== "general-part") {
        throw new ManualModelingError(
          "旋片泵模板使用专用构建器，不能追加通用组件实例。"
        );
      }
      stageComponentInstance(builder, semanticToken(operation.id), operation);
      continue;
    }

    if (operation.type === "add_assembly_constraint") {
      if (modelingDocumentKind(document) !== "general-part") {
        throw new ManualModelingError(
          "旋片泵模板使用专用构建器，不能追加通用装配约束。"
        );
      }
      stageAssemblyConstraint(builder, semanticToken(operation.id), operation);
      continue;
    }

    if (operation.type === "tool_command") {
      if (modelingDocumentKind(document) !== "general-part") {
        throw new ManualModelingError(
          "旋片泵模板使用专用构建器，不能追加通用 CAD 特征。请新建空白通用零件。"
        );
      }
      stageToolCommand(builder, operation);
    }
  }

  if (!builder.operations.length) return undefined;
  const batch = modelOperationBatchSchema.parse({
    version: "openvac.modeling.v1",
    id: uuid(),
    documentId: document.id,
    baseRevisionId: document.revisionId,
    idempotencyKey,
    operations: builder.operations
  });

  // Match the server's pure application step before any network write. A
  // malformed reference graph never leaves the browser, and the authoritative
  // base document remains untouched because applyOperationBatch is immutable.
  const expanded = expandRotaryVanePumpDerivedOperations(document, batch);
  applyOperationBatch(document, expanded);
  return expanded;
}

export function cloneModelDocumentWithFreshIds(
  source: ModelDocument,
  name: string
): ModelDocument {
  const idMap = new Map<string, string>();
  collectIdentityIds(source, idMap);
  const cloned = replaceIds(source, idMap) as ModelDocument;
  return {
    ...cloned,
    name,
    revision: 0,
    metadata: {
      ...cloned.metadata,
      description: "OpenVac 手动工作区创建的原创单级旋片泵草稿。"
    }
  };
}

function stageToolCommand(
  builder: BatchBuilder,
  command: Extract<ManualOperation, { type: "tool_command" }>
) {
  const token = semanticToken(command.id);
  switch (command.tool) {
    case "sketch":
      stageBasicSketch(builder, token, command.settings);
      return;
    case "slot":
      stageSlotSketch(builder, token, command.settings);
      return;
    case "extrude":
      stageExtrude(builder, token, command.settings);
      return;
    case "cut":
      stageCut(builder, token, command.targetPartId, command.settings);
      return;
    case "rotate":
      stageRevolve(builder, token, command.settings);
      return;
    case "hole":
      stageHole(builder, token, command.targetPartId, command.settings);
      return;
    case "fillet":
      stageFillet(builder, token, command.targetPartId, command.settings);
      return;
    case "chamfer":
      stageChamfer(builder, token, command.targetPartId, command.settings);
      return;
    case "mirror":
      stageMirror(builder, token, command.targetPartId, command.settings);
      return;
    case "linear-pattern":
      stageLinearPattern(
        builder,
        token,
        command.targetPartId,
        command.settings
      );
      return;
    case "circular-pattern":
      stageCircularPattern(
        builder,
        token,
        command.targetPartId,
        command.settings
      );
      return;
    case "reorder":
      stageReorder(builder, command.targetPartId, command.settings);
      return;
    default:
      throw new ManualModelingError("当前工具不能生成手工建模操作批次。");
  }
}

function stageBooleanFeature(
  builder: BatchBuilder,
  token: string,
  operation: "union" | "subtract" | "intersect",
  selections: ModelingSelection[]
) {
  const features = selectedFeaturesForOperation(builder.features, selections);
  if (features.length < 2) {
    throw new ManualModelingError(
      "布尔运算至少需要两个未抑制的协议特征；第一个是目标，其余是工具体。"
    );
  }
  const seen = new Set<string>();
  for (const feature of features) {
    if (seen.has(feature.id)) {
      throw new ManualModelingError("布尔目标与工具体不能重复选择同一特征。");
    }
    seen.add(feature.id);
    if (feature.suppressed) {
      throw new ManualModelingError(
        `“${feature.name}”已抑制，不能参与布尔运算。`
      );
    }
    const owners = componentsReferencing(builder.components, feature).filter(
      (component) => !component.suppressed
    );
    if (owners.some((component) => !isIdentityTransform(component))) {
      throw new ManualModelingError(
        `“${feature.name}”属于已位移或旋转的组件实例；布尔只能在 Feature 原始坐标系中执行。`
      );
    }
  }

  const target = features[0]!;
  const tools = features.slice(1);
  const targetOwners = new Set(
    componentsReferencing(builder.components, target).map(
      (component) => component.id
    )
  );
  for (const component of builder.components) {
    const selectedCount = features.filter((feature) =>
      component.featureRefs.some((item) => sameReference(item, feature))
    ).length;
    if (selectedCount > 1) {
      throw new ManualModelingError(
        `组件“${component.name}”同时引用多个所选特征，无法确定布尔后的实例路由。`
      );
    }
  }

  const result = addFeature(builder, {
    ...identity(`manual.feature.${token}.boolean`),
    name: `${booleanLabel(operation)} · ${target.name}`,
    featureKind: "boolean",
    targetFeatureRef: reference(target),
    toolFeatureRefs: tools.map(reference),
    operation,
    suppressed: false
  });
  routeResultToComponent(builder, target, result);

  const toolComponentIds = new Set(
    tools.flatMap((tool) =>
      componentsReferencing(builder.components, tool).map(
        (component) => component.id
      )
    )
  );
  builder.components = builder.components.map((component) => {
    if (
      !toolComponentIds.has(component.id) ||
      targetOwners.has(component.id) ||
      component.suppressed
    ) {
      return component;
    }
    builder.operations.push({
      operationId: uuid(),
      kind: "suppress",
      collection: "components",
      target: reference(component),
      suppressed: true
    });
    return { ...component, suppressed: true };
  });
}

function stageComponentInstance(
  builder: BatchBuilder,
  token: string,
  operation: Extract<ManualOperation, { type: "add_component_instance" }>
) {
  if (operation.source.collection !== "components") {
    throw new ManualModelingError("创建实例前请只选择一个已保存组件。 ");
  }
  const source = builder.components.find(
    (component) =>
      component.id === operation.source.id &&
      component.semanticRef === operation.source.semanticRef
  );
  if (!source || source.suppressed) {
    throw new ManualModelingError("所选源组件不存在或已抑制，无法创建实例。");
  }
  if (!source.featureRefs.length) {
    throw new ManualModelingError(
      "源组件没有真实 Feature 引用，不能创建空实例。"
    );
  }
  for (const featureRef of source.featureRefs) {
    const feature = builder.features.find((candidate) =>
      sameReference(featureRef, candidate)
    );
    if (!feature || feature.suppressed) {
      throw new ManualModelingError(
        "源组件引用了不存在或已抑制的 Feature，不能创建实例。"
      );
    }
  }
  const component: Component = {
    ...identity(`manual.component.${token}.instance`),
    name: operation.name.trim() || `${source.name} 实例`,
    featureRefs: source.featureRefs.map((item) => ({ ...item })),
    transform: {
      translationMm: finiteVector(operation.translationMm, "组件平移"),
      rotationDegrees: finiteVector(operation.rotationDegrees, "组件旋转")
    },
    suppressed: false
  };
  builder.operations.push({
    operationId: uuid(),
    kind: "add",
    collection: "components",
    item: component
  });
  builder.components.push(component);
}

function stageAssemblyConstraint(
  builder: BatchBuilder,
  token: string,
  operation: Extract<ManualOperation, { type: "add_assembly_constraint" }>
) {
  const components = selectedComponentsForOperation(
    builder.components,
    operation.targets
  );
  const expectedCount = operation.constraintKind === "fixed" ? 1 : 2;
  if (components.length !== expectedCount) {
    throw new ManualModelingError(
      operation.constraintKind === "fixed"
        ? "固定约束必须且只能选择一个组件。"
        : "贴合、同轴或距离约束必须选择两个不同组件。"
    );
  }
  if (
    new Set(components.map((component) => component.id)).size !== expectedCount
  ) {
    throw new ManualModelingError("装配约束不能重复引用同一个组件。");
  }
  if (components.some((component) => component.suppressed)) {
    throw new ManualModelingError("已抑制组件不能参与装配约束。");
  }

  const distanceParameter =
    operation.constraintKind === "distance"
      ? addParameter(builder, {
          semanticRef: `manual.parameter.${token}.assembly-distance`,
          name: "assembly-origin-distance",
          label: "组件原点距离",
          parameterType: "length",
          unit: "mm",
          value: positiveFinite(operation.distanceMm, "组件原点距离"),
          minimum: 0.1,
          maximum: 100_000
        })
      : undefined;
  const constraint: AssemblyConstraint = {
    ...identity(`manual.assembly-constraint.${token}`),
    name: assemblyConstraintLabel(operation.constraintKind),
    constraintKind: operation.constraintKind,
    componentRefs: components.map(reference),
    ...(distanceParameter
      ? { parameterRef: reference(distanceParameter) }
      : {}),
    status: "unsolved"
  };
  builder.operations.push({
    operationId: uuid(),
    kind: "add",
    collection: "assemblyConstraints",
    item: constraint
  });
}

function stageBasicSketch(
  builder: BatchBuilder,
  token: string,
  settings: Record<string, number | string | boolean>
) {
  const action = choice(
    settings,
    "action",
    ["primitive", "constraint"] as const,
    "primitive"
  );
  if (action === "constraint") {
    stageSketchConstraint(builder, token, settings);
    return;
  }

  stageSketchPrimitive(builder, token, settings);
}

function stageSketchPrimitive(
  builder: BatchBuilder,
  token: string,
  settings: Record<string, number | string | boolean>
) {
  const plane = choice(settings, "plane", ["xy", "xz", "yz"] as const, "xy");
  const shape = choice(
    settings,
    "shape",
    ["point", "line", "polyline", "rectangle", "circle", "arc"] as const,
    "rectangle"
  );
  const construction = settings.construction === true;
  const targetSketch = optionalTargetSketch(builder.sketches, settings);
  const width = positiveNumber(settings, "width", 40, "草图宽度");
  const height = positiveNumber(settings, "height", 30, "草图高度");
  const diameter = positiveNumber(settings, "diameter", 30, "圆直径");
  const span = Math.max(width, height, diameter, 20);
  const sketchRef = targetSketch?.semanticRef ?? `manual.sketch.${token}`;
  const entityRef = `${sketchRef}.entity.${token}`;
  const entities: SketchEntity[] = [];

  if (shape === "point") {
    entities.push(
      entityPoint(
        `${entityRef}.point`,
        finiteSettingNumber(settings, "x", 0, "点 X 坐标"),
        finiteSettingNumber(settings, "y", 0, "点 Y 坐标"),
        construction
      )
    );
  }

  if (shape === "line") {
    const start = entityPoint(
      `${entityRef}.start`,
      finiteSettingNumber(settings, "startX", 0, "直线起点 X"),
      finiteSettingNumber(settings, "startY", 0, "直线起点 Y"),
      construction
    );
    const end = entityPoint(
      `${entityRef}.end`,
      finiteSettingNumber(settings, "endX", 20, "直线终点 X"),
      finiteSettingNumber(settings, "endY", 0, "直线终点 Y"),
      construction
    );
    assertDistinctPoints(start, end, "直线起点和终点不能重合");
    entities.push(start, end, {
      ...identity(`${entityRef}.line`),
      entityKind: "line",
      construction,
      startPointRef: reference(start),
      endPointRef: reference(end)
    });
  }

  if (shape === "polyline") {
    const points = parsePolylinePoints(settings.polylinePoints);
    const closed = settings.closed === true;
    if (closed && points.length < 3) {
      throw new ManualModelingError("闭合折线至少需要三个点。");
    }
    const pointEntities = points.map(([x, y], index) =>
      entityPoint(`${entityRef}.point-${index + 1}`, x, y, construction)
    );
    entities.push(...pointEntities, {
      ...identity(`${entityRef}.polyline`),
      entityKind: "polyline",
      construction,
      pointRefs: pointEntities.map(reference),
      closed
    });
  }

  if (shape === "arc") {
    const center = entityPoint(
      `${entityRef}.center`,
      finiteSettingNumber(settings, "centerX", 0, "圆弧圆心 X"),
      finiteSettingNumber(settings, "centerY", 0, "圆弧圆心 Y"),
      construction
    );
    const start = entityPoint(
      `${entityRef}.start`,
      finiteSettingNumber(settings, "startX", 10, "圆弧起点 X"),
      finiteSettingNumber(settings, "startY", 0, "圆弧起点 Y"),
      construction
    );
    const end = entityPoint(
      `${entityRef}.end`,
      finiteSettingNumber(settings, "endX", 0, "圆弧终点 X"),
      finiteSettingNumber(settings, "endY", 10, "圆弧终点 Y"),
      construction
    );
    assertDistinctPoints(center, start, "圆弧圆心不能与起点重合");
    assertDistinctPoints(center, end, "圆弧圆心不能与终点重合");
    assertDistinctPoints(start, end, "圆弧起点和终点不能重合");
    const startRadius = Math.hypot(start.x - center.x, start.y - center.y);
    const endRadius = Math.hypot(end.x - center.x, end.y - center.y);
    if (Math.abs(startRadius - endRadius) > 1e-6) {
      throw new ManualModelingError("圆弧起点和终点到圆心的距离必须相等。");
    }
    entities.push(center, start, end, {
      ...identity(`${entityRef}.arc`),
      entityKind: "arc",
      construction,
      centerPointRef: reference(center),
      startPointRef: reference(start),
      endPointRef: reference(end),
      clockwise: settings.clockwise === true
    });
  }

  if (shape === "circle") {
    const centerX = diameter / 2 + 2;
    const center = entityPoint(`${entityRef}.center`, centerX, 0, true);
    const diameterParameter = addParameter(builder, {
      semanticRef: `manual.parameter.${token}.diameter`,
      name: "profile-diameter",
      label: "草图圆直径",
      parameterType: "length",
      unit: "mm",
      value: diameter,
      minimum: 0.1,
      maximum: 10_000
    });
    entities.push(center, {
      ...identity(`${entityRef}.circle`),
      entityKind: "circle",
      construction,
      centerPointRef: reference(center),
      diameterParameterRef: reference(diameterParameter)
    });
  }

  if (shape === "rectangle") {
    const centerX = width / 2 + 2;
    const center = entityPoint(`${entityRef}.center`, centerX, 0, true);
    const widthParameter = addParameter(builder, {
      semanticRef: `manual.parameter.${token}.width`,
      name: "profile-width",
      label: "草图宽度",
      parameterType: "length",
      unit: "mm",
      value: width,
      minimum: 0.1,
      maximum: 10_000
    });
    const heightParameter = addParameter(builder, {
      semanticRef: `manual.parameter.${token}.height`,
      name: "profile-height",
      label: "草图高度",
      parameterType: "length",
      unit: "mm",
      value: height,
      minimum: 0.1,
      maximum: 10_000
    });
    entities.push(center, {
      ...identity(`${entityRef}.rectangle`),
      entityKind: "rectangle",
      construction,
      centerPointRef: reference(center),
      widthParameterRef: reference(widthParameter),
      heightParameterRef: reference(heightParameter),
      rotationDegrees: 0
    });
  }

  if (targetSketch) {
    updateSketch(builder, targetSketch, {
      entities: [...targetSketch.entities, ...entities],
      solveStatus: "unsolved"
    });
    return;
  }

  if (shape === "rectangle" || shape === "circle") {
    const axisStart = entityPoint(`${entityRef}.axis-start`, 0, -span, true);
    const axisEnd = entityPoint(`${entityRef}.axis-end`, 0, span, true);
    entities.unshift(axisStart, axisEnd, {
      ...identity(`${entityRef}.axis`),
      entityKind: "line",
      construction: true,
      startPointRef: reference(axisStart),
      endPointRef: reference(axisEnd)
    });
  }
  addSketch(builder, {
    ...identity(sketchRef),
    name: `手工${sketchShapeLabel(shape)}草图`,
    plane,
    entities,
    constraints: [],
    solveStatus: "under_constrained",
    suppressed: false
  });
}

function stageSketchConstraint(
  builder: BatchBuilder,
  token: string,
  settings: Record<string, number | string | boolean>
) {
  const sketch = requireTargetSketch(builder.sketches, settings);
  const kind = choice(
    settings,
    "constraintKind",
    [
      "fixed",
      "coincident",
      "horizontal",
      "vertical",
      "parallel",
      "perpendicular",
      "tangent",
      "equal",
      "midpoint",
      "symmetric",
      "distance",
      "angle",
      "radius",
      "diameter"
    ] as const,
    "fixed"
  );
  const targets = Array.from({ length: 4 }, (_, index) => {
    const id = settings[`target${index}Id`];
    const semanticRef = settings[`target${index}Ref`];
    if (id === undefined && semanticRef === undefined) return undefined;
    if (typeof id !== "string" || typeof semanticRef !== "string") {
      throw new ManualModelingError(
        `草图约束目标 ${index + 1} 必须同时包含 UUID 和语义引用。`
      );
    }
    const entity = sketch.entities.find(
      (entity) => entity.id === id && entity.semanticRef === semanticRef
    );
    if (!entity) {
      throw new ManualModelingError(
        `草图约束目标 ${index + 1} 已变化或不在所选草图中。`
      );
    }
    return entity;
  }).filter((entity): entity is SketchEntity => Boolean(entity));
  if (new Set(targets.map((entity) => entity.id)).size !== targets.length) {
    throw new ManualModelingError("草图约束不能重复选择同一个实体。");
  }
  validateSketchConstraintTargets(kind, targets);

  const parameter = ["distance", "radius", "diameter", "angle"].includes(kind)
    ? addParameter(builder, {
        semanticRef: `manual.parameter.${token}.${kind}`,
        name: `sketch-${kind}`,
        label: sketchConstraintParameterLabel(kind),
        parameterType: kind === "angle" ? "angle" : "length",
        unit: kind === "angle" ? "deg" : "mm",
        value:
          kind === "angle"
            ? rangedNumber(settings, "value", 90, "约束角度", 0.1, 360)
            : positiveNumber(settings, "value", 10, "约束尺寸"),
        minimum: 0.1,
        maximum: kind === "angle" ? 360 : 10_000
      })
    : undefined;
  const constraint: Sketch["constraints"][number] = {
    ...identity(`manual.sketch-constraint.${token}.${kind}`),
    name: sketchConstraintLabel(kind),
    constraintKind: kind,
    targetRefs: targets.map(reference),
    ...(parameter ? { parameterRef: reference(parameter) } : {}),
    status: "unsolved"
  };
  updateSketch(builder, sketch, {
    constraints: [...sketch.constraints, constraint],
    solveStatus: "unsolved"
  });
}

function optionalTargetSketch(
  sketches: readonly Sketch[],
  settings: Record<string, number | string | boolean>
): Sketch | undefined {
  const id = settings.targetSketchId;
  const semanticRef = settings.targetSketchRef;
  if (id === undefined && semanticRef === undefined) return undefined;
  if (typeof id !== "string" || typeof semanticRef !== "string") {
    throw new ManualModelingError("目标草图必须同时包含 UUID 和语义引用。");
  }
  const sketch = sketches.find(
    (candidate) => candidate.id === id && candidate.semanticRef === semanticRef
  );
  if (!sketch || sketch.suppressed) {
    throw new ManualModelingError("目标草图已变化、已抑制或不在基础修订中。");
  }
  return sketch;
}

function requireTargetSketch(
  sketches: readonly Sketch[],
  settings: Record<string, number | string | boolean>
): Sketch {
  const sketch = optionalTargetSketch(sketches, settings);
  if (!sketch) {
    throw new ManualModelingError("新增草图约束前必须选择一个已保存草图。");
  }
  return sketch;
}

function updateSketch(
  builder: BatchBuilder,
  sketch: Sketch,
  changes:
    | Pick<Sketch, "entities" | "solveStatus">
    | Pick<Sketch, "constraints" | "solveStatus">
) {
  builder.operations.push({
    operationId: uuid(),
    kind: "update",
    collection: "sketches",
    target: reference(sketch),
    changes
  });
  builder.sketches = builder.sketches.map((candidate) =>
    sameReference(reference(candidate), sketch)
      ? { ...candidate, ...changes }
      : candidate
  );
}

function parsePolylinePoints(value: number | string | boolean | undefined) {
  const source = typeof value === "string" ? value : "0,0;20,0;20,15";
  const coordinates = source
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const parts = entry.split(",").map((part) => part.trim());
      if (parts.length !== 2) {
        throw new ManualModelingError(
          `折线第 ${index + 1} 个点必须使用“X,Y”格式。`
        );
      }
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new ManualModelingError(
          `折线第 ${index + 1} 个点必须是有限数字。`
        );
      }
      return [x, y] as [number, number];
    });
  if (coordinates.length < 2 || coordinates.length > 50) {
    throw new ManualModelingError("折线需要 2 到 50 个有序点。");
  }
  coordinates.forEach((point, index) => {
    const previous = coordinates[index - 1];
    if (previous && point[0] === previous[0] && point[1] === previous[1]) {
      throw new ManualModelingError("折线相邻点不能重合。");
    }
  });
  return coordinates;
}

function finiteSettingNumber(
  settings: Record<string, number | string | boolean>,
  key: string,
  fallback: number,
  label: string
) {
  const value = settings[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ManualModelingError(`${label}必须是有效数字。`);
  }
  if (Math.abs(value) > 1_000_000) {
    throw new ManualModelingError(`${label}超出 V1 坐标范围。`);
  }
  return value;
}

function assertDistinctPoints(
  first: Extract<SketchEntity, { entityKind: "point" }>,
  second: Extract<SketchEntity, { entityKind: "point" }>,
  message: string
) {
  if (first.x === second.x && first.y === second.y) {
    throw new ManualModelingError(message);
  }
}

type SketchConstraintKind = Sketch["constraints"][number]["constraintKind"];

function validateSketchConstraintTargets(
  kind: SketchConstraintKind,
  targets: SketchEntity[]
) {
  const kinds = targets.map((target) => target.entityKind);
  const exactly = (count: number, allowed?: SketchEntity["entityKind"][]) =>
    targets.length === count &&
    (!allowed || kinds.every((targetKind) => allowed.includes(targetKind)));
  if (kind === "fixed" && targets.length === 1) return;
  if (kind === "coincident" && exactly(2, ["point"])) return;
  if ((kind === "horizontal" || kind === "vertical") && exactly(1, ["line"])) {
    return;
  }
  if (
    (kind === "parallel" || kind === "perpendicular" || kind === "angle") &&
    exactly(2, ["line"])
  ) {
    return;
  }
  if (kind === "tangent" && exactly(2, ["line", "circle", "arc"])) {
    return;
  }
  if (
    kind === "equal" &&
    (exactly(2, ["line"]) || exactly(2, ["circle", "arc"]))
  ) {
    return;
  }
  if (
    kind === "midpoint" &&
    targets.length === 2 &&
    kinds.filter((targetKind) => targetKind === "point").length === 1 &&
    kinds.filter((targetKind) => targetKind === "line").length === 1
  ) {
    return;
  }
  if (
    kind === "symmetric" &&
    targets.length === 3 &&
    kinds.filter((targetKind) => targetKind === "point").length === 2 &&
    kinds.filter((targetKind) => targetKind === "line").length === 1
  ) {
    return;
  }
  if (kind === "distance" && (exactly(1, ["line"]) || exactly(2, ["point"]))) {
    return;
  }
  if (
    (kind === "radius" || kind === "diameter") &&
    exactly(1, ["circle", "arc"])
  ) {
    return;
  }
  throw new ManualModelingError(
    `${sketchConstraintLabel(kind)}的目标实体数量或类型不符合 V1 求解器契约。`
  );
}

function sketchConstraintLabel(kind: SketchConstraintKind) {
  const labels: Record<SketchConstraintKind, string> = {
    fixed: "固定",
    coincident: "重合",
    horizontal: "水平",
    vertical: "垂直",
    parallel: "平行",
    perpendicular: "正交",
    tangent: "相切",
    equal: "等长或等半径",
    midpoint: "中点",
    symmetric: "对称",
    distance: "距离",
    angle: "角度",
    radius: "半径",
    diameter: "直径",
    concentric: "同心"
  };
  return `草图约束 · ${labels[kind]}`;
}

function sketchConstraintParameterLabel(kind: SketchConstraintKind) {
  if (kind === "angle") return "草图约束角度";
  if (kind === "radius") return "草图约束半径";
  if (kind === "diameter") return "草图约束直径";
  return "草图约束距离";
}

function sketchShapeLabel(kind: SketchEntity["entityKind"]) {
  const labels: Record<SketchEntity["entityKind"], string> = {
    point: "点",
    line: "直线",
    polyline: "折线",
    rectangle: "矩形",
    circle: "圆形",
    arc: "圆弧",
    slot: "长圆槽"
  };
  return labels[kind];
}

function sketchEntityLabel(entity: SketchEntity) {
  return `${sketchShapeLabel(entity.entityKind)} · ${entity.semanticRef.split(".").at(-1) ?? entity.semanticRef}`;
}

function stageSlotSketch(
  builder: BatchBuilder,
  token: string,
  settings: Record<string, number | string | boolean>
) {
  const plane = choice(settings, "plane", ["xy", "xz", "yz"] as const, "xy");
  const length = positiveNumber(settings, "length", 30, "槽中心距");
  const width = positiveNumber(settings, "width", 8, "槽宽");
  const sketchRef = `manual.sketch.${token}`;
  const start = entityPoint(`${sketchRef}.start`, -length / 2, 0, true);
  const end = entityPoint(`${sketchRef}.end`, length / 2, 0, true);
  const widthParameter = addParameter(builder, {
    semanticRef: `manual.parameter.${token}.slot-width`,
    name: "slot-width",
    label: "槽宽",
    parameterType: "length",
    unit: "mm",
    value: width,
    minimum: 0.1,
    maximum: 10_000
  });
  const axis: Extract<SketchEntity, { entityKind: "line" }> = {
    ...identity(`${sketchRef}.axis`),
    entityKind: "line",
    construction: true,
    startPointRef: reference(start),
    endPointRef: reference(end)
  };
  const slot: Extract<SketchEntity, { entityKind: "slot" }> = {
    ...identity(`${sketchRef}.profile`),
    entityKind: "slot",
    construction: false,
    startPointRef: reference(start),
    endPointRef: reference(end),
    widthParameterRef: reference(widthParameter)
  };
  addSketch(builder, {
    ...identity(sketchRef),
    name: "手工长圆槽草图",
    plane,
    entities: [start, end, axis, slot],
    constraints: [],
    solveStatus: "under_constrained",
    suppressed: false
  });
}

function stageExtrude(
  builder: BatchBuilder,
  token: string,
  settings: Record<string, number | string | boolean>
) {
  const profile = requireProfile(
    builder.sketches,
    "请先创建基础草图或开槽草图。若两步均待保存，可一起提交。"
  );
  const distance = positiveNumber(settings, "distance", 20, "拉伸距离");
  const direction = choice(
    settings,
    "direction",
    ["normal", "reverse", "symmetric"] as const,
    "normal"
  );
  const distanceParameter = addParameter(builder, {
    semanticRef: `manual.parameter.${token}.extrude-distance`,
    name: "extrude-distance",
    label: "拉伸距离",
    parameterType: "length",
    unit: "mm",
    value: distance,
    minimum: 0.1,
    maximum: 10_000
  });
  const feature = addFeature(builder, {
    ...identity(`manual.feature.${token}.extrude`),
    name: `拉伸 · ${profile.sketch.name}`,
    featureKind: "extrude",
    profileRefs: [reference(profile.profile)],
    distanceParameterRef: reference(distanceParameter),
    direction,
    operation: "new_body",
    suppressed: false
  });
  addResultComponent(builder, feature);
}

function stageCut(
  builder: BatchBuilder,
  token: string,
  targetPartId: string,
  settings: Record<string, number | string | boolean>
) {
  const target = requireSelectedFeature(builder.features, targetPartId);
  const profile = requireProfile(
    builder.sketches,
    "切除前请先创建一个闭合基础草图或开槽草图。"
  );
  const distance = positiveNumber(settings, "distance", 12, "切除深度");
  const direction = choice(
    settings,
    "direction",
    ["normal", "reverse", "symmetric"] as const,
    "normal"
  );
  const distanceParameter = addParameter(builder, {
    semanticRef: `manual.parameter.${token}.cut-distance`,
    name: "cut-distance",
    label: "切除深度",
    parameterType: "length",
    unit: "mm",
    value: distance,
    minimum: 0.1,
    maximum: 10_000
  });
  const cutter = addFeature(builder, {
    ...identity(`manual.feature.${token}.cutter`),
    name: `切除工具体 · ${profile.sketch.name}`,
    featureKind: "extrude",
    profileRefs: [reference(profile.profile)],
    distanceParameterRef: reference(distanceParameter),
    direction,
    operation: "new_body",
    suppressed: false
  });
  const result = addFeature(builder, {
    ...identity(`manual.feature.${token}.cut-result`),
    name: `切除 · ${target.name}`,
    featureKind: "boolean",
    targetFeatureRef: reference(target),
    toolFeatureRefs: [reference(cutter)],
    operation: "subtract",
    suppressed: false
  });
  routeResultToComponent(builder, target, result);
}

function stageRevolve(
  builder: BatchBuilder,
  token: string,
  settings: Record<string, number | string | boolean>
) {
  const profile = latestRevolveProfile(builder.sketches);
  if (!profile?.axis) {
    throw new ManualModelingError(
      "旋转实体需要基础矩形或圆形草图及其构造轴；开槽草图不能直接旋转。"
    );
  }
  const angle = rangedNumber(settings, "angle", 360, "旋转角度", 1, 360);
  const angleParameter = addParameter(builder, {
    semanticRef: `manual.parameter.${token}.revolve-angle`,
    name: "revolve-angle",
    label: "旋转角度",
    parameterType: "angle",
    unit: "deg",
    value: angle,
    minimum: 1,
    maximum: 360
  });
  const feature = addFeature(builder, {
    ...identity(`manual.feature.${token}.revolve`),
    name: `旋转 · ${profile.sketch.name}`,
    featureKind: "revolve",
    profileRefs: [reference(profile.profile)],
    axisRef: reference(profile.axis),
    angleParameterRef: reference(angleParameter),
    operation: "new_body",
    suppressed: false
  });
  addResultComponent(builder, feature);
}

function stageHole(
  builder: BatchBuilder,
  token: string,
  targetPartId: string,
  settings: Record<string, number | string | boolean>
) {
  const target = requireSelectedFeature(builder.features, targetPartId);
  const diameter = positiveNumber(settings, "diameter", 8, "孔直径");
  const termination = choice(
    settings,
    "termination",
    ["through_all", "blind"] as const,
    "through_all"
  );
  const faceSelector = choice(
    settings,
    "faceSelector",
    ["top", "bottom", "front", "back"] as const,
    "top"
  );
  const diameterParameter = addParameter(builder, {
    semanticRef: `manual.parameter.${token}.hole-diameter`,
    name: "hole-diameter",
    label: "孔直径",
    parameterType: "length",
    unit: "mm",
    value: diameter,
    minimum: 0.1,
    maximum: 10_000
  });
  const depthParameter =
    termination === "blind"
      ? addParameter(builder, {
          semanticRef: `manual.parameter.${token}.hole-depth`,
          name: "hole-depth",
          label: "盲孔深度",
          parameterType: "length",
          unit: "mm",
          value: positiveNumber(settings, "depth", 12, "盲孔深度"),
          minimum: 0.1,
          maximum: 10_000
        })
      : undefined;
  const feature = addFeature(builder, {
    ...identity(`manual.feature.${token}.hole`),
    name: `孔 · ${target.name}`,
    featureKind: "hole",
    placement: {
      placementKind: "semantic_face",
      sourceFeatureRef: reference(target),
      faceSelector
    },
    diameterParameterRef: reference(diameterParameter),
    termination,
    ...(depthParameter ? { depthParameterRef: reference(depthParameter) } : {}),
    operation: "cut",
    suppressed: false
  });
  routeResultToComponent(builder, target, feature);
}

function stageFillet(
  builder: BatchBuilder,
  token: string,
  targetPartId: string,
  settings: Record<string, number | string | boolean>
) {
  const target = requireSelectedFeature(builder.features, targetPartId);
  const radius = positiveNumber(settings, "radius", 3, "圆角半径");
  const radiusParameter = addParameter(builder, {
    semanticRef: `manual.parameter.${token}.fillet-radius`,
    name: "fillet-radius",
    label: "圆角半径",
    parameterType: "length",
    unit: "mm",
    value: radius,
    minimum: 0.1,
    maximum: 10_000
  });
  const feature = addFeature(builder, {
    ...identity(`manual.feature.${token}.fillet`),
    name: `圆角 · ${target.name}`,
    featureKind: "fillet",
    sourceFeatureRefs: [reference(target)],
    edgeSelector: edgeSelector(settings),
    radiusParameterRef: reference(radiusParameter),
    suppressed: false
  });
  routeResultToComponent(builder, target, feature);
}

function stageChamfer(
  builder: BatchBuilder,
  token: string,
  targetPartId: string,
  settings: Record<string, number | string | boolean>
) {
  const target = requireSelectedFeature(builder.features, targetPartId);
  const distance = positiveNumber(settings, "distance", 2, "倒角距离");
  const distanceParameter = addParameter(builder, {
    semanticRef: `manual.parameter.${token}.chamfer-distance`,
    name: "chamfer-distance",
    label: "倒角距离",
    parameterType: "length",
    unit: "mm",
    value: distance,
    minimum: 0.1,
    maximum: 10_000
  });
  const feature = addFeature(builder, {
    ...identity(`manual.feature.${token}.chamfer`),
    name: `倒角 · ${target.name}`,
    featureKind: "chamfer",
    sourceFeatureRefs: [reference(target)],
    edgeSelector: edgeSelector(settings),
    distanceParameterRef: reference(distanceParameter),
    suppressed: false
  });
  routeResultToComponent(builder, target, feature);
}

function stageMirror(
  builder: BatchBuilder,
  token: string,
  targetPartId: string,
  settings: Record<string, number | string | boolean>
) {
  const target = requireSelectedFeature(builder.features, targetPartId);
  const mirrorPlane = choice(
    settings,
    "plane",
    ["xy", "xz", "yz"] as const,
    "yz"
  );
  const feature = addFeature(builder, {
    ...identity(`manual.feature.${token}.mirror`),
    name: `镜像 · ${target.name}`,
    featureKind: "mirror",
    sourceFeatureRefs: [reference(target)],
    mirrorPlane,
    suppressed: false
  });
  routeResultToComponent(builder, target, feature);
}

function stageLinearPattern(
  builder: BatchBuilder,
  token: string,
  targetPartId: string,
  settings: Record<string, number | string | boolean>
) {
  const target = requireSelectedFeature(builder.features, targetPartId);
  const count = integerInRange(settings, "count", 3, "阵列数量", 2, 100);
  const spacing = positiveNumber(settings, "spacing", 20, "阵列间距");
  const countParameter = addParameter(builder, {
    semanticRef: `manual.parameter.${token}.linear-count`,
    name: "linear-count",
    label: "线性阵列数量",
    parameterType: "integer",
    unit: "count",
    value: count,
    minimum: 2,
    maximum: 100
  });
  const spacingParameter = addParameter(builder, {
    semanticRef: `manual.parameter.${token}.linear-spacing`,
    name: "linear-spacing",
    label: "线性阵列间距",
    parameterType: "length",
    unit: "mm",
    value: spacing,
    minimum: 0.1,
    maximum: 10_000
  });
  const feature = addFeature(builder, {
    ...identity(`manual.feature.${token}.linear-pattern`),
    name: `线性阵列 · ${target.name}`,
    featureKind: "linear_pattern",
    sourceFeatureRef: reference(target),
    directionVector: axisVector(settings),
    countParameterRef: reference(countParameter),
    spacingParameterRef: reference(spacingParameter),
    suppressed: false
  });
  routeResultToComponent(builder, target, feature);
}

function stageCircularPattern(
  builder: BatchBuilder,
  token: string,
  targetPartId: string,
  settings: Record<string, number | string | boolean>
) {
  const target = requireSelectedFeature(builder.features, targetPartId);
  const count = integerInRange(settings, "count", 4, "阵列数量", 2, 100);
  const totalAngle = rangedNumber(
    settings,
    "totalAngle",
    360,
    "阵列总角度",
    1,
    360
  );
  const countParameter = addParameter(builder, {
    semanticRef: `manual.parameter.${token}.circular-count`,
    name: "circular-count",
    label: "圆周阵列数量",
    parameterType: "integer",
    unit: "count",
    value: count,
    minimum: 2,
    maximum: 100
  });
  const feature = addFeature(builder, {
    ...identity(`manual.feature.${token}.circular-pattern`),
    name: `圆周阵列 · ${target.name}`,
    featureKind: "circular_pattern",
    sourceFeatureRef: reference(target),
    axisOrigin: [0, 0, 0],
    axisDirection: axisVector(settings),
    countParameterRef: reference(countParameter),
    totalAngleDegrees: totalAngle,
    suppressed: false
  });
  routeResultToComponent(builder, target, feature);
}

function stageReorder(
  builder: BatchBuilder,
  targetPartId: string,
  settings: Record<string, number | string | boolean>
) {
  const target = requireSelectedFeature(builder.features, targetPartId);
  const direction = choice(
    settings,
    "direction",
    ["earlier", "later"] as const,
    "earlier"
  );
  const index = builder.features.findIndex(
    (feature) => feature.id === target.id
  );
  const nextIndex = direction === "earlier" ? index - 1 : index + 1;
  if (index < 0 || nextIndex < 0 || nextIndex >= builder.features.length) {
    throw new ManualModelingError(
      direction === "earlier"
        ? "所选特征已经位于特征树顶部。"
        : "所选特征已经位于特征树底部。"
    );
  }
  const ordered = [...builder.features];
  [ordered[index], ordered[nextIndex]] = [ordered[nextIndex]!, ordered[index]!];
  builder.operations.push({
    operationId: uuid(),
    kind: "reorder",
    collection: "features",
    orderedRefs: ordered.map(reference)
  });
  builder.features = ordered;
}

function stageSuppressFeature(
  builder: BatchBuilder,
  feature: Feature,
  suppressed: boolean
) {
  builder.operations.push({
    operationId: uuid(),
    kind: "suppress",
    collection: "features",
    target: reference(feature),
    suppressed
  });
  const index = builder.features.findIndex(
    (candidate) => candidate.id === feature.id
  );
  builder.features[index] = { ...feature, suppressed };
}

function addParameter(
  builder: BatchBuilder,
  input: Omit<ModelParameter, "id" | "source" | "editable">
): ModelParameter {
  const item: ModelParameter = {
    id: uuid(),
    ...input,
    source: "user",
    editable: true
  };
  builder.operations.push({
    operationId: uuid(),
    kind: "add",
    collection: "parameters",
    item
  });
  builder.parameters.push(item);
  return item;
}

function addSketch(builder: BatchBuilder, item: Sketch): Sketch {
  builder.operations.push({
    operationId: uuid(),
    kind: "add",
    collection: "sketches",
    item
  });
  builder.sketches.push(item);
  return item;
}

function addFeature(builder: BatchBuilder, item: Feature): Feature {
  builder.operations.push({
    operationId: uuid(),
    kind: "add",
    collection: "features",
    item
  });
  builder.features.push(item);
  return item;
}

function addResultComponent(builder: BatchBuilder, feature: Feature) {
  const component: Component = {
    ...identity(`${feature.semanticRef}.component`),
    name: `${feature.name}实体`,
    featureRefs: [reference(feature)],
    transform: {
      translationMm: [0, 0, 0],
      rotationDegrees: [0, 0, 0]
    },
    suppressed: false
  };
  builder.operations.push({
    operationId: uuid(),
    kind: "add",
    collection: "components",
    item: component
  });
  builder.components.push(component);
}

function routeResultToComponent(
  builder: BatchBuilder,
  source: Feature,
  result: Feature
) {
  let routed = false;
  builder.components = builder.components.map((component) => {
    if (!component.featureRefs.some((item) => sameReference(item, source))) {
      return component;
    }
    routed = true;
    const next = {
      ...component,
      featureRefs: component.featureRefs.map((item) =>
        sameReference(item, source) ? reference(result) : item
      )
    };
    builder.operations.push({
      operationId: uuid(),
      kind: "update",
      collection: "components",
      target: reference(component),
      changes: { featureRefs: next.featureRefs }
    });
    return next;
  });
  if (!routed) addResultComponent(builder, result);
}

function latestProfile(
  sketches: readonly Sketch[]
): ProfileSelection | undefined {
  for (let index = sketches.length - 1; index >= 0; index -= 1) {
    const sketch = sketches[index];
    if (!sketch || sketch.suppressed) continue;
    const profile = [...sketch.entities]
      .reverse()
      .find(
        (entity) =>
          !entity.construction &&
          ["circle", "rectangle", "polyline", "slot"].includes(
            entity.entityKind
          )
      );
    if (profile) return { sketch, profile };
  }
}

function latestRevolveProfile(
  sketches: readonly Sketch[]
): ProfileSelection | undefined {
  for (let index = sketches.length - 1; index >= 0; index -= 1) {
    const sketch = sketches[index];
    if (!sketch || sketch.suppressed) continue;
    const profile = [...sketch.entities]
      .reverse()
      .find(
        (entity) =>
          !entity.construction &&
          ["circle", "rectangle", "polyline"].includes(entity.entityKind)
      );
    const axis = sketch.entities.find(
      (entity): entity is Extract<SketchEntity, { entityKind: "line" }> =>
        entity.entityKind === "line" && entity.construction
    );
    if (profile && axis) return { sketch, profile, axis };
  }
}

function requireProfile(
  sketches: readonly Sketch[],
  message: string
): ProfileSelection {
  const profile = latestProfile(sketches);
  if (!profile) throw new ManualModelingError(message);
  return profile;
}

function requireSelectedFeature(
  features: readonly Feature[],
  selectedPartId: string
): Feature {
  const feature = selectedFeature(features, selectedPartId);
  if (!feature) {
    throw new ManualModelingError(
      "当前选择没有可编辑的协议特征。请在通用零件特征树中选择一个实体特征。"
    );
  }
  return feature;
}

function selectedFeature(
  features: readonly Feature[],
  selectedPartId: string
): Feature | undefined {
  const explicitRef = selectedPartId.startsWith(GENERAL_FEATURE_PREFIX)
    ? selectedPartId.slice(GENERAL_FEATURE_PREFIX.length)
    : PART_FEATURE_REFS[selectedPartId];
  if (!explicitRef) return undefined;
  const original = features.find(
    (feature) =>
      feature.semanticRef === explicitRef || feature.id === explicitRef
  );
  if (!original) return undefined;
  let current = original;
  for (const feature of features) {
    if (feature.id === current.id) continue;
    if (featureConsumes(feature, current)) current = feature;
  }
  return current;
}

function featureConsumes(feature: Feature, source: Feature): boolean {
  if (feature.featureKind === "boolean") {
    return (
      sameReference(feature.targetFeatureRef, source) ||
      feature.toolFeatureRefs.some((item) => sameReference(item, source))
    );
  }
  if (
    feature.featureKind === "circular_pattern" ||
    feature.featureKind === "linear_pattern"
  ) {
    return sameReference(feature.sourceFeatureRef, source);
  }
  if (
    feature.featureKind === "fillet" ||
    feature.featureKind === "chamfer" ||
    feature.featureKind === "mirror"
  ) {
    return feature.sourceFeatureRefs.some((item) =>
      sameReference(item, source)
    );
  }
  return (
    feature.featureKind === "hole" &&
    feature.placement.placementKind === "semantic_face" &&
    sameReference(feature.placement.sourceFeatureRef, source)
  );
}

function selectedFeaturesForOperation(
  features: readonly Feature[],
  selections: readonly ModelingSelection[]
) {
  return selections.map((selection) => {
    if (selection.collection !== "features") {
      throw new ManualModelingError(
        "布尔运算只能选择 Feature 语义对象，不能混入组件实例。"
      );
    }
    const feature = features.find(
      (candidate) =>
        candidate.id === selection.id &&
        candidate.semanticRef === selection.semanticRef
    );
    if (!feature) {
      throw new ManualModelingError(
        `布尔目标“${selection.name}”已不在当前基础修订中。`
      );
    }
    return feature;
  });
}

function selectedComponentsForOperation(
  components: readonly Component[],
  selections: readonly ModelingSelection[]
) {
  return selections.map((selection) => {
    if (selection.collection !== "components") {
      throw new ManualModelingError(
        "装配操作只能选择 Component 语义对象，不能混入 Feature。"
      );
    }
    const component = components.find(
      (candidate) =>
        candidate.id === selection.id &&
        candidate.semanticRef === selection.semanticRef
    );
    if (!component) {
      throw new ManualModelingError(
        `装配目标“${selection.name}”已不在当前基础修订中。`
      );
    }
    return component;
  });
}

function componentsReferencing(
  components: readonly Component[],
  feature: Feature
) {
  return components.filter((component) =>
    component.featureRefs.some((item) => sameReference(item, feature))
  );
}

function isIdentityTransform(component: Component) {
  return (
    component.transform.translationMm.every((value) => value === 0) &&
    component.transform.rotationDegrees.every((value) => value === 0)
  );
}

function finiteVector(
  vector: readonly number[],
  label: string
): [number, number, number] {
  if (vector.length !== 3 || vector.some((value) => !Number.isFinite(value))) {
    throw new ManualModelingError(`${label}必须是三个有限数字。`);
  }
  return [vector[0]!, vector[1]!, vector[2]!];
}

function positiveFinite(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ManualModelingError(`${label}必须是大于 0 的有效数字。`);
  }
  return value;
}

function componentDistance(first: Component, second: Component) {
  return Math.hypot(
    second.transform.translationMm[0] - first.transform.translationMm[0],
    second.transform.translationMm[1] - first.transform.translationMm[1],
    second.transform.translationMm[2] - first.transform.translationMm[2]
  );
}

function booleanLabel(operation: "union" | "subtract" | "intersect") {
  return operation === "union"
    ? "布尔并集"
    : operation === "subtract"
      ? "布尔差集"
      : "布尔交集";
}

function assemblyConstraintLabel(
  kind: "fixed" | "coincident" | "concentric" | "distance"
) {
  if (kind === "fixed") return "固定组件基准";
  if (kind === "coincident") return "组件原点贴合";
  if (kind === "concentric") return "组件局部 Z 轴同轴";
  return "组件原点距离";
}

function edgeSelector(
  settings: Record<string, number | string | boolean>
):
  | "all"
  | "vertical"
  | "top"
  | "bottom"
  | "parallel_x"
  | "parallel_y"
  | "parallel_z" {
  return choice(
    settings,
    "edgeSelector",
    [
      "all",
      "vertical",
      "top",
      "bottom",
      "parallel_x",
      "parallel_y",
      "parallel_z"
    ] as const,
    "all"
  );
}

function axisVector(
  settings: Record<string, number | string | boolean>
): [number, number, number] {
  const axis = choice(settings, "axis", ["x", "y", "z"] as const, "z");
  return axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
}

function positiveNumber(
  settings: Record<string, number | string | boolean>,
  key: string,
  fallback: number,
  label: string
) {
  return rangedNumber(settings, key, fallback, label, 0.1, 10_000);
}

function rangedNumber(
  settings: Record<string, number | string | boolean>,
  key: string,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number
) {
  const raw = settings[key] ?? fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new ManualModelingError(`${label}必须是有效数字。`);
  }
  if (raw < minimum || raw > maximum) {
    throw new ManualModelingError(
      `${label}必须在 ${minimum} 到 ${maximum} 之间。`
    );
  }
  return raw;
}

function integerInRange(
  settings: Record<string, number | string | boolean>,
  key: string,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number
) {
  const value = rangedNumber(settings, key, fallback, label, minimum, maximum);
  if (!Number.isInteger(value)) {
    throw new ManualModelingError(`${label}必须是整数。`);
  }
  return value;
}

function choice<const T extends readonly string[]>(
  settings: Record<string, number | string | boolean>,
  key: string,
  choices: T,
  fallback: T[number]
): T[number] {
  const value = settings[key] ?? fallback;
  if (typeof value !== "string" || !choices.includes(value)) return fallback;
  return value as T[number];
}

function entityPoint(
  semanticRef: string,
  x: number,
  y: number,
  construction: boolean
): Extract<SketchEntity, { entityKind: "point" }> {
  return {
    ...identity(semanticRef),
    entityKind: "point",
    construction,
    x,
    y
  };
}

function identity(semanticRef: string) {
  return { id: uuid(), semanticRef };
}

function reference(value: { id: string; semanticRef: string }): ModelReference {
  return { id: value.id, semanticRef: value.semanticRef };
}

function sameReference(
  left: ModelReference,
  right: { id: string; semanticRef: string }
) {
  return left.id === right.id && left.semanticRef === right.semanticRef;
}

function semanticToken(value: string) {
  const token = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 56);
  return token.startsWith("op-") ? token : `op-${token || uuid().slice(0, 8)}`;
}

function collectIdentityIds(value: unknown, ids: Map<string, string>) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectIdentityIds(item, ids));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((key === "id" || key === "revisionId") && typeof child === "string") {
      if (!ids.has(child)) ids.set(child, uuid());
    }
    collectIdentityIds(child, ids);
  }
}

function replaceIds(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceIds(item, ids));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, replaceIds(child, ids)])
  );
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const random = () =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, "0");
  return `${random()}${random()}-${random()}-4${random().slice(1)}-a${random().slice(1)}-${random()}${random()}${random()}`;
}
