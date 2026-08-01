import { describe, expect, it } from "vitest";
import {
  createInitialWorkspaceState,
  modelingWorkspaceReducer,
  type ModelingSelection
} from "./workspace-state";

describe("modeling workspace semantic selection", () => {
  it("replaces, adds, and removes stable semantic selections without indices", () => {
    const featureA = selection("features", "feature-a");
    const featureB = selection("features", "feature-b");
    let state = createInitialWorkspaceState("general-part");

    state = modelingWorkspaceReducer(state, {
      type: "semantic/select",
      selection: featureA
    });
    state = modelingWorkspaceReducer(state, {
      type: "semantic/select",
      selection: featureB,
      additive: true
    });
    expect(state.semanticSelections.map((item) => item.semanticRef)).toEqual([
      "manual.feature.feature-a",
      "manual.feature.feature-b"
    ]);
    expect(state.selectedPartId).toBe("feature:manual.feature.feature-b");

    state = modelingWorkspaceReducer(state, {
      type: "semantic/select",
      selection: featureA,
      additive: true
    });
    expect(state.semanticSelections).toEqual([featureB]);
  });

  it("snapshots the ordered multi-selection into a boolean pending operation", () => {
    const featureA = selection("features", "target");
    const featureB = selection("features", "tool");
    let state = createInitialWorkspaceState("general-part");
    state = modelingWorkspaceReducer(state, {
      type: "semantic/select",
      selection: featureA
    });
    state = modelingWorkspaceReducer(state, {
      type: "semantic/select",
      selection: featureB,
      additive: true
    });
    state = modelingWorkspaceReducer(state, {
      type: "tool/commit",
      tool: "boolean",
      settings: { operation: "subtract" }
    });

    expect(state.pendingOperations.at(-1)).toMatchObject({
      type: "add_boolean_feature",
      operation: "subtract",
      targets: [featureA, featureB]
    });
  });

  it("keeps the V1 pump fixed at two vanes", () => {
    const state = createInitialWorkspaceState("pump-template");
    const next = modelingWorkspaceReducer(state, {
      type: "parameter/change",
      id: "vaneCount",
      value: 6
    });

    expect(next).toBe(state);
    expect(next.document.parameters.vaneCount).toBe(2);
    expect(next.pendingOperations).toHaveLength(0);
  });

  it("undoes and redoes a generic parameter operation without losing its identity", () => {
    let state = createInitialWorkspaceState("general-part");
    state = modelingWorkspaceReducer(state, {
      type: "project/hydrate",
      projectId: "project-1",
      revisionId: "revision-1",
      name: "参数零件",
      documentKind: "general-part"
    });
    state = modelingWorkspaceReducer(state, {
      type: "model-parameter/change",
      parameterId: "10000000-0000-4000-8000-000000000001",
      semanticRef: "manual.parameter.width",
      parameterLabel: "宽度",
      value: 24,
      previousValue: 20
    });

    expect(state.pendingOperations.at(-1)).toMatchObject({
      type: "set_model_parameter",
      value: 24,
      previousValue: 20
    });

    state = modelingWorkspaceReducer(state, { type: "history/undo" });
    expect(state.pendingOperations).toHaveLength(0);
    expect(state.sync).toBe("saved");
    expect(state.undoneManualOperations).toHaveLength(1);

    state = modelingWorkspaceReducer(state, { type: "history/redo" });
    expect(state.pendingOperations.at(-1)).toMatchObject({
      type: "set_model_parameter",
      semanticRef: "manual.parameter.width",
      value: 24
    });
    expect(state.undoneManualOperations).toHaveLength(0);
  });
});

function selection(
  collection: ModelingSelection["collection"],
  token: string
): ModelingSelection {
  return {
    collection,
    id: `${token.padEnd(8, "0")}-0000-4000-8000-000000000000`,
    semanticRef: `manual.feature.${token}`,
    name: token
  };
}
