export const V1_VANE_COUNT = 2;

export const PARAMETER_DEFINITIONS = [
  {
    id: "cavityDiameter",
    label: "泵腔直径",
    symbol: "Dᶜ",
    unit: "mm",
    min: 60,
    max: 180,
    step: 0.5,
    defaultValue: 100
  },
  {
    id: "rotorDiameter",
    label: "转子直径",
    symbol: "Dʳ",
    unit: "mm",
    min: 40,
    max: 150,
    step: 0.5,
    defaultValue: 80
  },
  {
    id: "eccentricity",
    label: "偏心量",
    symbol: "e",
    unit: "mm",
    min: 0,
    max: 24,
    step: 0.5,
    defaultValue: 6
  },
  {
    id: "axialWidth",
    label: "轴向宽度",
    symbol: "B",
    unit: "mm",
    min: 20,
    max: 120,
    step: 0.5,
    defaultValue: 60
  },
  {
    id: "vaneCount",
    label: "旋片数量",
    symbol: "Z",
    unit: "",
    min: 2,
    max: 8,
    step: 1,
    defaultValue: V1_VANE_COUNT
  },
  {
    id: "vaneThickness",
    label: "旋片厚度",
    symbol: "tᵛ",
    unit: "mm",
    min: 2,
    max: 16,
    step: 0.5,
    defaultValue: 4
  },
  {
    id: "vaneHeight",
    label: "旋片高度",
    symbol: "hᵛ",
    unit: "mm",
    min: 12,
    max: 80,
    step: 0.5,
    defaultValue: 26
  },
  {
    id: "shaftDiameter",
    label: "主轴直径",
    symbol: "dˢ",
    unit: "mm",
    min: 8,
    max: 42,
    step: 0.5,
    defaultValue: 20
  },
  {
    id: "inletWidth",
    label: "进气口宽度",
    symbol: "Wᵢₙ",
    unit: "mm",
    min: 8,
    max: 52,
    step: 0.5,
    defaultValue: 18
  },
  {
    id: "outletWidth",
    label: "排气口宽度",
    symbol: "Wₒᵤₜ",
    unit: "mm",
    min: 8,
    max: 52,
    step: 0.5,
    defaultValue: 16
  }
] as const;

export type PumpParameterId = (typeof PARAMETER_DEFINITIONS)[number]["id"];

export type PumpPart = {
  id: string;
  name: string;
  kind: "body" | "rotor" | "vane" | "shaft" | "cover" | "port" | "base";
  visible: boolean;
};

export type PumpDocument = {
  schemaVersion: 1;
  pumpType: "rotary-vane";
  parameters: Record<PumpParameterId, number>;
  parts: PumpPart[];
  sectionEnabled: boolean;
};

export type ModelingSelection = {
  collection: "features" | "components";
  id: string;
  semanticRef: string;
  name: string;
};

export type ManualOperation =
  | {
      id: string;
      type: "set_parameter";
      parameterId: PumpParameterId;
      value: number;
    }
  | {
      id: string;
      type: "set_model_parameter";
      parameterId: string;
      semanticRef: string;
      parameterLabel: string;
      value: number;
      previousValue: number;
    }
  | {
      id: string;
      type: "set_part_visibility";
      partId: string;
      visible: boolean;
    }
  | {
      id: string;
      type: "set_part_suppressed";
      partId: string;
      suppressed: boolean;
    }
  | {
      id: string;
      type: "set_feature_suppressed";
      featureId: string;
      semanticRef: string;
      featureName: string;
      suppressed: boolean;
    }
  | {
      id: string;
      type: "set_section";
      enabled: boolean;
    }
  | {
      id: string;
      type: "tool_command";
      tool: ModelingTool;
      targetPartId: string;
      settings: Record<string, number | string | boolean>;
    }
  | {
      id: string;
      type: "add_boolean_feature";
      operation: "union" | "subtract" | "intersect";
      targets: ModelingSelection[];
    }
  | {
      id: string;
      type: "add_component_instance";
      source: ModelingSelection;
      name: string;
      translationMm: [number, number, number];
      rotationDegrees: [number, number, number];
    }
  | {
      id: string;
      type: "add_assembly_constraint";
      constraintKind: "fixed" | "coincident" | "concentric" | "distance";
      targets: ModelingSelection[];
      distanceMm?: number;
    };

export type ModelingTool =
  | "select"
  | "sketch"
  | "extrude"
  | "cut"
  | "rotate"
  | "slot"
  | "hole"
  | "boolean"
  | "fillet"
  | "chamfer"
  | "mirror"
  | "linear-pattern"
  | "circular-pattern"
  | "reorder"
  | "assembly"
  | "measure"
  | "section"
  | "interference";

export type InspectorTab =
  "properties" | "parameters" | "validation" | "material";

export type ModelingDocumentKind = "pump-template" | "general-part";

export type SyncState =
  "local-draft" | "dirty" | "saving" | "saved" | "offline" | "error";

export type TaskRecord = {
  id: string;
  time: string;
  label: string;
  detail: string;
  tone: "success" | "warning" | "neutral";
};

export type AiPlanFieldDiff = {
  field: string;
  label: string;
  before: string;
  after: string;
};

export type AiPlanOperationReference = {
  id?: string;
  semanticRef?: string;
};

export type AiPlanOperation = {
  id: string;
  kind?: string;
  collection?: string;
  target?: AiPlanOperationReference;
  item?: Record<string, unknown>;
  changes?: Record<string, unknown>;
  orderedRefs?: AiPlanOperationReference[];
  suppressed?: boolean;
  label: string;
  summary: string;
  diffs: AiPlanFieldDiff[];
};

export type AiPlanState =
  | { status: "idle" }
  | { status: "pending"; prompt: string; jobId?: string }
  | { status: "needs_input"; prompt: string; question: string; planId?: string }
  | {
      status: "preview";
      prompt: string;
      planId: string;
      planHash?: string;
      operations: AiPlanOperation[];
      summary?: string;
      assumptions: string[];
      warnings: string[];
      expectedChecks: string[];
      diagnostics: Array<{ code: string; severity: string; message: string }>;
      metrics?: Record<string, number>;
      rejecting: boolean;
      decisionError?: string;
    }
  | { status: "confirming"; prompt: string; planId: string }
  | { status: "confirmed"; message: string }
  | { status: "rejected"; message: string }
  | { status: "error"; message: string };

export type ModelingWorkspaceState = {
  projectId?: string;
  revisionId?: string;
  projectName: string;
  documentKind: ModelingDocumentKind;
  document: PumpDocument;
  past: PumpDocument[];
  future: PumpDocument[];
  pendingOperations: ManualOperation[];
  undoneManualOperations: ManualOperation[];
  selectedPartId: string;
  semanticSelections: ModelingSelection[];
  activeTool: ModelingTool;
  inspectorTab: InspectorTab;
  sync: SyncState;
  syncMessage?: string;
  projectPanelOpen: boolean;
  inspectorOpen: boolean;
  commandPanelOpen: boolean;
  toolPanelOpen: boolean;
  aiPlan: AiPlanState;
  tasks: TaskRecord[];
};

export type ModelingWorkspaceAction =
  | { type: "parameter/change"; id: PumpParameterId; value: number }
  | {
      type: "model-parameter/change";
      parameterId: string;
      semanticRef: string;
      parameterLabel: string;
      value: number;
      previousValue: number;
    }
  | { type: "part/select"; id: string }
  | {
      type: "semantic/select";
      selection: ModelingSelection;
      additive?: boolean;
    }
  | { type: "semantic/clear" }
  | { type: "part/visibility"; id: string }
  | {
      type: "feature/suppressed";
      featureId: string;
      semanticRef: string;
      featureName: string;
      suppressed: boolean;
    }
  | { type: "history/undo" }
  | { type: "history/redo" }
  | { type: "tool/activate"; tool: ModelingTool }
  | {
      type: "tool/commit";
      tool: ModelingTool;
      settings: Record<string, number | string | boolean>;
    }
  | { type: "inspector/tab"; tab: InspectorTab }
  | { type: "panel/project"; open?: boolean }
  | { type: "panel/inspector"; open?: boolean }
  | { type: "panel/command"; open?: boolean }
  | { type: "panel/tool"; open?: boolean }
  | {
      type: "project/new";
      name?: string;
      documentKind: ModelingDocumentKind;
    }
  | {
      type: "project/hydrate";
      projectId: string;
      revisionId: string;
      name: string;
      documentKind: ModelingDocumentKind;
      selectedPartId?: string;
      semanticSelections?: ModelingSelection[];
      document?: PumpDocument;
    }
  | { type: "sync/saving" }
  | {
      type: "sync/saved";
      projectId: string;
      revisionId: string;
      message?: string;
    }
  | { type: "sync/offline"; message: string }
  | { type: "sync/error"; message: string }
  | { type: "ai/pending"; prompt: string; jobId?: string }
  | {
      type: "ai/needs-input";
      prompt: string;
      question: string;
      planId?: string;
    }
  | {
      type: "ai/preview";
      prompt: string;
      planId: string;
      planHash?: string;
      operations: AiPlanOperation[];
      summary?: string;
      assumptions?: string[];
      warnings?: string[];
      expectedChecks?: string[];
      diagnostics?: Array<{ code: string; severity: string; message: string }>;
      metrics?: Record<string, number>;
    }
  | { type: "ai/confirming"; prompt: string; planId: string }
  | { type: "ai/confirmed"; message: string }
  | { type: "ai/rejecting" }
  | { type: "ai/reject-failed"; message: string }
  | { type: "ai/rejected"; message: string }
  | { type: "ai/error"; message: string };

const DEFAULT_PARTS: PumpPart[] = [
  {
    id: "pump-body",
    name: "泵体",
    kind: "body",
    visible: true
  },
  {
    id: "eccentric-rotor",
    name: "偏心转子",
    kind: "rotor",
    visible: true
  },
  {
    id: "vane-1",
    name: "旋片 1",
    kind: "vane",
    visible: true
  },
  {
    id: "vane-2",
    name: "旋片 2",
    kind: "vane",
    visible: true
  },
  {
    id: "main-shaft",
    name: "主轴",
    kind: "shaft",
    visible: true
  },
  {
    id: "front-cover",
    name: "前端盖",
    kind: "cover",
    visible: false
  },
  {
    id: "back-cover",
    name: "后端盖",
    kind: "cover",
    visible: true
  },
  {
    id: "inlet",
    name: "进气口",
    kind: "port",
    visible: true
  },
  {
    id: "outlet",
    name: "排气口",
    kind: "port",
    visible: true
  },
  {
    id: "mounting-base",
    name: "安装底座",
    kind: "base",
    visible: true
  }
];

function operationId() {
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function timeLabel() {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date());
}

export function createGenericPumpDocument(): PumpDocument {
  const parameters = Object.fromEntries(
    PARAMETER_DEFINITIONS.map((parameter) => [
      parameter.id,
      parameter.defaultValue
    ])
  ) as Record<PumpParameterId, number>;

  return {
    schemaVersion: 1,
    pumpType: "rotary-vane",
    parameters,
    parts: DEFAULT_PARTS.map((part) => ({ ...part })),
    sectionEnabled: true
  };
}

export function createInitialWorkspaceState(
  documentKind: ModelingDocumentKind = "pump-template"
): ModelingWorkspaceState {
  return {
    projectName: "原创单级旋片泵",
    documentKind,
    document: createGenericPumpDocument(),
    past: [],
    future: [],
    pendingOperations: [],
    undoneManualOperations: [],
    selectedPartId: documentKind === "pump-template" ? "vane-1" : "",
    semanticSelections: [],
    activeTool: "select",
    inspectorTab: "parameters",
    sync: "local-draft",
    projectPanelOpen: false,
    inspectorOpen: false,
    commandPanelOpen: true,
    toolPanelOpen: false,
    aiPlan: { status: "idle" },
    tasks: [
      {
        id: "seed-validate",
        time: "10:24",
        label: "客户端参数检查",
        detail: "仅完成径向参数公式预检，等待首次 OCCT 重建",
        tone: "neutral"
      },
      {
        id: "seed-draft",
        time: "10:23",
        label: "通用旋片泵草稿",
        detail: "等待首次保存到项目",
        tone: "neutral"
      }
    ]
  };
}

function pushDocumentChange(
  state: ModelingWorkspaceState,
  nextDocument: PumpDocument,
  operation: ManualOperation,
  task: Omit<TaskRecord, "id" | "time">
): ModelingWorkspaceState {
  return {
    ...state,
    document: nextDocument,
    past: [...state.past, state.document].slice(-50),
    future: [],
    pendingOperations: [...state.pendingOperations, operation],
    sync: "dirty",
    syncMessage: undefined,
    tasks: [
      {
        ...task,
        id: operation.id,
        time: timeLabel()
      },
      ...state.tasks
    ].slice(0, 8)
  };
}

function operationForDocumentDiff(
  previous: PumpDocument,
  next: PumpDocument
): ManualOperation | undefined {
  for (const definition of PARAMETER_DEFINITIONS) {
    if (previous.parameters[definition.id] !== next.parameters[definition.id]) {
      return {
        id: operationId(),
        type: "set_parameter",
        parameterId: definition.id,
        value: next.parameters[definition.id]
      };
    }
  }

  if (previous.sectionEnabled !== next.sectionEnabled) {
    return {
      id: operationId(),
      type: "set_section",
      enabled: next.sectionEnabled
    };
  }
}

export function modelingWorkspaceReducer(
  state: ModelingWorkspaceState,
  action: ModelingWorkspaceAction
): ModelingWorkspaceState {
  switch (action.type) {
    case "parameter/change": {
      if (!Number.isFinite(action.value)) return state;
      if (action.id === "vaneCount") return state;
      const definition = PARAMETER_DEFINITIONS.find(
        (item) => item.id === action.id
      );
      if (!definition) return state;
      const value = Math.min(
        definition.max,
        Math.max(definition.min, action.value)
      );
      if (state.document.parameters[action.id] === value) return state;
      const operation: ManualOperation = {
        id: operationId(),
        type: "set_parameter",
        parameterId: action.id,
        value
      };
      return pushDocumentChange(
        { ...state, undoneManualOperations: [] },
        {
          ...state.document,
          parameters: { ...state.document.parameters, [action.id]: value }
        },
        operation,
        {
          label: `参数更新 · ${definition.label}`,
          detail: `${definition.symbol} = ${value}${definition.unit ? ` ${definition.unit}` : ""}`,
          tone: "success"
        }
      );
    }
    case "model-parameter/change": {
      if (
        !Number.isFinite(action.value) ||
        action.value === action.previousValue
      ) {
        return state;
      }
      const operation: ManualOperation = {
        id: operationId(),
        type: "set_model_parameter",
        parameterId: action.parameterId,
        semanticRef: action.semanticRef,
        parameterLabel: action.parameterLabel,
        value: action.value,
        previousValue: action.previousValue
      };
      return {
        ...state,
        pendingOperations: [...state.pendingOperations, operation],
        undoneManualOperations: [],
        sync: "dirty",
        syncMessage: undefined,
        tasks: [
          {
            id: operation.id,
            time: timeLabel(),
            label: `参数更新 · ${action.parameterLabel}`,
            detail: `${action.previousValue} → ${action.value}（待服务器校验）`,
            tone: "success" as const
          },
          ...state.tasks
        ].slice(0, 8)
      };
    }
    case "part/select":
      return {
        ...state,
        selectedPartId: action.id,
        semanticSelections: [],
        inspectorTab: "properties",
        inspectorOpen: true
      };
    case "semantic/select": {
      const selected = state.semanticSelections.some(
        (item) =>
          item.collection === action.selection.collection &&
          item.id === action.selection.id &&
          item.semanticRef === action.selection.semanticRef
      );
      const semanticSelections = action.additive
        ? selected
          ? state.semanticSelections.filter(
              (item) =>
                !(
                  item.collection === action.selection.collection &&
                  item.id === action.selection.id &&
                  item.semanticRef === action.selection.semanticRef
                )
            )
          : [...state.semanticSelections, action.selection]
        : [action.selection];
      const primary = semanticSelections.at(-1);
      return {
        ...state,
        semanticSelections,
        selectedPartId: primary ? modelingSelectionId(primary) : "",
        inspectorTab: "properties",
        inspectorOpen: true
      };
    }
    case "semantic/clear":
      return { ...state, semanticSelections: [], selectedPartId: "" };
    case "part/visibility": {
      const part = state.document.parts.find((item) => item.id === action.id);
      if (!part) return state;
      const visible = !part.visible;
      return {
        ...state,
        document: {
          ...state.document,
          parts: state.document.parts.map((item) =>
            item.id === action.id ? { ...item, visible } : item
          )
        },
        tasks: [
          {
            id: operationId(),
            time: timeLabel(),
            label: visible ? `显示 · ${part.name}` : `隐藏 · ${part.name}`,
            detail: "仅改变当前视图，不伪装为服务器修订",
            tone: "neutral" as const
          },
          ...state.tasks
        ].slice(0, 8)
      };
    }
    case "feature/suppressed": {
      const operation: ManualOperation = {
        id: operationId(),
        type: "set_feature_suppressed",
        featureId: action.featureId,
        semanticRef: action.semanticRef,
        featureName: action.featureName,
        suppressed: action.suppressed
      };
      return {
        ...state,
        pendingOperations: [...state.pendingOperations, operation],
        undoneManualOperations: [],
        sync: "dirty",
        syncMessage: undefined,
        tasks: [
          {
            id: operation.id,
            time: timeLabel(),
            label: `${action.suppressed ? "抑制" : "恢复"} · ${action.featureName}`,
            detail: "已加入手工操作批次，服务器修订尚未改变",
            tone: action.suppressed
              ? ("warning" as const)
              : ("success" as const)
          },
          ...state.tasks
        ].slice(0, 8)
      };
    }
    case "history/undo": {
      const latestOperation = state.pendingOperations.at(-1);
      if (latestOperation?.type === "set_model_parameter") {
        const remainingOperations = state.pendingOperations.slice(0, -1);
        return {
          ...state,
          pendingOperations: remainingOperations,
          undoneManualOperations: [
            ...state.undoneManualOperations,
            latestOperation
          ].slice(-50),
          sync: remainingOperations.length
            ? "dirty"
            : state.projectId
              ? "saved"
              : "local-draft",
          tasks: [
            {
              id: operationId(),
              time: timeLabel(),
              label: "撤销参数更新",
              detail: `${latestOperation.parameterLabel} 恢复为 ${latestOperation.previousValue}`,
              tone: "neutral" as const
            },
            ...state.tasks
          ].slice(0, 8)
        };
      }
      const previous = state.past.at(-1);
      if (!previous) return state;
      const inverse = operationForDocumentDiff(state.document, previous);
      return {
        ...state,
        document: previous,
        past: state.past.slice(0, -1),
        future: [state.document, ...state.future].slice(0, 50),
        pendingOperations: inverse
          ? [...state.pendingOperations, inverse]
          : state.pendingOperations,
        sync: "dirty",
        tasks: [
          {
            id: operationId(),
            time: timeLabel(),
            label: "撤销操作",
            detail: "已恢复上一版手动状态",
            tone: "neutral" as const
          },
          ...state.tasks
        ].slice(0, 8)
      };
    }
    case "history/redo": {
      const genericOperation = state.undoneManualOperations.at(-1);
      if (genericOperation?.type === "set_model_parameter") {
        return {
          ...state,
          pendingOperations: [...state.pendingOperations, genericOperation],
          undoneManualOperations: state.undoneManualOperations.slice(0, -1),
          sync: "dirty",
          syncMessage: undefined,
          tasks: [
            {
              id: operationId(),
              time: timeLabel(),
              label: "重做参数更新",
              detail: `${genericOperation.parameterLabel} = ${genericOperation.value}`,
              tone: "neutral" as const
            },
            ...state.tasks
          ].slice(0, 8)
        };
      }
      const next = state.future[0];
      if (!next) return state;
      const operation = operationForDocumentDiff(state.document, next);
      return {
        ...state,
        document: next,
        past: [...state.past, state.document].slice(-50),
        future: state.future.slice(1),
        pendingOperations: operation
          ? [...state.pendingOperations, operation]
          : state.pendingOperations,
        sync: "dirty",
        tasks: [
          {
            id: operationId(),
            time: timeLabel(),
            label: "重做操作",
            detail: "已恢复下一版手动状态",
            tone: "neutral" as const
          },
          ...state.tasks
        ].slice(0, 8)
      };
    }
    case "tool/activate": {
      const isSection = action.tool === "section";
      const isValidation = action.tool === "interference";
      return {
        ...state,
        activeTool: action.tool,
        toolPanelOpen: ![
          "select",
          "measure",
          "section",
          "interference"
        ].includes(action.tool),
        inspectorTab: isValidation ? "validation" : state.inspectorTab,
        inspectorOpen: isValidation ? true : state.inspectorOpen,
        document: isSection
          ? {
              ...state.document,
              sectionEnabled: !state.document.sectionEnabled
            }
          : state.document
      };
    }
    case "tool/commit": {
      if (!PERSISTED_MANUAL_TOOLS.has(action.tool)) return state;
      const toolOperation = manualOperationForTool(state, action);
      if (!toolOperation) return state;
      return {
        ...state,
        toolPanelOpen: false,
        pendingOperations: [...state.pendingOperations, toolOperation],
        undoneManualOperations: [],
        sync: "dirty",
        syncMessage: undefined,
        tasks: [
          {
            id: toolOperation.id,
            time: timeLabel(),
            label: `待保存特征 · ${MANUAL_TOOL_LABELS[action.tool]}`,
            detail: "已加入手工操作批次，保存后才会生成服务器修订",
            tone: "warning" as const
          },
          ...state.tasks
        ].slice(0, 8)
      };
    }
    case "inspector/tab":
      return { ...state, inspectorTab: action.tab, inspectorOpen: true };
    case "panel/project":
      return {
        ...state,
        projectPanelOpen: action.open ?? !state.projectPanelOpen
      };
    case "panel/inspector":
      return { ...state, inspectorOpen: action.open ?? !state.inspectorOpen };
    case "panel/command":
      return {
        ...state,
        commandPanelOpen: action.open ?? !state.commandPanelOpen
      };
    case "panel/tool":
      return { ...state, toolPanelOpen: action.open ?? !state.toolPanelOpen };
    case "project/new":
      return {
        ...createInitialWorkspaceState(action.documentKind),
        projectName:
          action.name?.trim() ||
          (action.documentKind === "pump-template"
            ? "未命名通用旋片泵"
            : "未命名通用零件"),
        sync: "local-draft",
        projectPanelOpen: state.projectPanelOpen,
        inspectorOpen: state.inspectorOpen
      };
    case "project/hydrate":
      return {
        ...state,
        projectId: action.projectId,
        revisionId: action.revisionId,
        projectName: action.name,
        documentKind: action.documentKind,
        selectedPartId:
          action.selectedPartId ??
          (action.documentKind === "pump-template"
            ? state.selectedPartId || "vane-1"
            : ""),
        semanticSelections: action.semanticSelections ?? [],
        document: action.document ?? state.document,
        past: [],
        future: [],
        pendingOperations: [],
        undoneManualOperations: [],
        sync: "saved",
        syncMessage: "已载入服务器项目"
      };
    case "sync/saving":
      return { ...state, sync: "saving", syncMessage: undefined };
    case "sync/saved":
      return {
        ...state,
        projectId: action.projectId,
        revisionId: action.revisionId,
        pendingOperations: [],
        undoneManualOperations: [],
        sync: "saved",
        syncMessage: action.message ?? "操作批次已保存"
      };
    case "sync/offline":
      return { ...state, sync: "offline", syncMessage: action.message };
    case "sync/error":
      return { ...state, sync: "error", syncMessage: action.message };
    case "ai/pending":
      return {
        ...state,
        aiPlan: {
          status: "pending",
          prompt: action.prompt,
          jobId: action.jobId
        }
      };
    case "ai/needs-input":
      return {
        ...state,
        aiPlan: {
          status: "needs_input",
          prompt: action.prompt,
          question: action.question,
          planId: action.planId
        }
      };
    case "ai/preview":
      return {
        ...state,
        aiPlan: {
          status: "preview",
          prompt: action.prompt,
          planId: action.planId,
          planHash: action.planHash,
          operations: action.operations,
          summary: action.summary,
          assumptions: action.assumptions ?? [],
          warnings: action.warnings ?? [],
          expectedChecks: action.expectedChecks ?? [],
          diagnostics: action.diagnostics ?? [],
          metrics: action.metrics,
          rejecting: false
        }
      };
    case "ai/confirming":
      return {
        ...state,
        aiPlan: {
          status: "confirming",
          prompt: action.prompt,
          planId: action.planId
        }
      };
    case "ai/confirmed":
      return {
        ...state,
        aiPlan: { status: "confirmed", message: action.message },
        tasks: [
          {
            id: operationId(),
            time: timeLabel(),
            label: "AI 计划已确认",
            detail: action.message,
            tone: "success" as const
          },
          ...state.tasks
        ].slice(0, 8)
      };
    case "ai/rejecting":
      return state.aiPlan.status === "preview"
        ? {
            ...state,
            aiPlan: {
              ...state.aiPlan,
              rejecting: true,
              decisionError: undefined
            }
          }
        : state;
    case "ai/reject-failed":
      return state.aiPlan.status === "preview"
        ? {
            ...state,
            aiPlan: {
              ...state.aiPlan,
              rejecting: false,
              decisionError: action.message
            }
          }
        : state;
    case "ai/rejected":
      return {
        ...state,
        aiPlan: { status: "rejected", message: action.message },
        tasks: [
          {
            id: operationId(),
            time: timeLabel(),
            label: "AI 计划已拒绝",
            detail: action.message,
            tone: "neutral" as const
          },
          ...state.tasks
        ].slice(0, 8)
      };
    case "ai/error":
      return { ...state, aiPlan: { status: "error", message: action.message } };
    default:
      return state;
  }
}

const PERSISTED_MANUAL_TOOLS = new Set<ModelingTool>([
  "sketch",
  "extrude",
  "cut",
  "rotate",
  "slot",
  "hole",
  "fillet",
  "chamfer",
  "mirror",
  "linear-pattern",
  "circular-pattern",
  "reorder",
  "boolean",
  "assembly"
]);

const MANUAL_TOOL_LABELS: Partial<Record<ModelingTool, string>> = {
  sketch: "基础草图",
  extrude: "拉伸实体",
  cut: "切除实体",
  rotate: "旋转实体",
  slot: "开槽草图",
  hole: "孔",
  fillet: "圆角",
  chamfer: "倒角",
  mirror: "镜像",
  "linear-pattern": "线性阵列",
  "circular-pattern": "圆周阵列",
  reorder: "特征重排",
  boolean: "布尔运算",
  assembly: "装配操作"
};

function manualOperationForTool(
  state: ModelingWorkspaceState,
  action: Extract<ModelingWorkspaceAction, { type: "tool/commit" }>
): ManualOperation | undefined {
  const id = operationId();
  if (action.tool === "boolean") {
    const operation = action.settings.operation;
    if (
      operation !== "union" &&
      operation !== "subtract" &&
      operation !== "intersect"
    ) {
      return undefined;
    }
    return {
      id,
      type: "add_boolean_feature",
      operation,
      targets: state.semanticSelections.map((selection) => ({ ...selection }))
    };
  }

  if (action.tool === "assembly") {
    if (action.settings.action === "instance") {
      const source = state.semanticSelections[0];
      if (!source) return undefined;
      return {
        id,
        type: "add_component_instance",
        source: { ...source },
        name:
          typeof action.settings.name === "string"
            ? action.settings.name
            : `${source.name} 实例`,
        translationMm: vectorFromSettings(action.settings, "translation"),
        rotationDegrees: vectorFromSettings(action.settings, "rotation")
      };
    }
    const constraintKind = action.settings.constraintKind;
    if (
      constraintKind !== "fixed" &&
      constraintKind !== "coincident" &&
      constraintKind !== "concentric" &&
      constraintKind !== "distance"
    ) {
      return undefined;
    }
    return {
      id,
      type: "add_assembly_constraint",
      constraintKind,
      targets: state.semanticSelections.map((selection) => ({ ...selection })),
      ...(constraintKind === "distance" &&
      typeof action.settings.distance === "number"
        ? { distanceMm: action.settings.distance }
        : {})
    };
  }

  return {
    id,
    type: "tool_command",
    tool: action.tool,
    targetPartId: state.selectedPartId,
    settings: action.settings
  };
}

function vectorFromSettings(
  settings: Record<string, number | string | boolean>,
  prefix: "translation" | "rotation"
): [number, number, number] {
  return (["X", "Y", "Z"] as const).map((axis) => {
    const value = settings[`${prefix}${axis}`];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }) as [number, number, number];
}

export function modelingSelectionId(selection: ModelingSelection) {
  const prefix = selection.collection === "features" ? "feature" : "component";
  return `${prefix}:${selection.semanticRef}`;
}

export function isPumpDocument(value: unknown): value is PumpDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PumpDocument>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.pumpType === "rotary-vane" &&
    Boolean(candidate.parameters) &&
    Array.isArray(candidate.parts)
  );
}
