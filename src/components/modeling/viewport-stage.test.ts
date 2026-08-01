// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createBlankPartDocument } from "@/lib/modeling/client/protocol-adapter";
import { createGenericPumpDocument } from "@/lib/modeling/client/workspace-state";
import { diagnosticSelectionIds, ViewportStage } from "./viewport-stage";

afterEach(cleanup);

describe("ViewportStage general-part fallback", () => {
  it("shows an explicit empty authoritative-build state instead of a pump", () => {
    const modelDocument = createBlankPartDocument("空白零件");
    render(
      createElement(ViewportStage, {
        document: createGenericPumpDocument(),
        documentKind: "general-part",
        modelDocument,
        semanticSelections: [],
        selectedPartId: "",
        activeTool: "select",
        kernelPreview: {
          status: "procedural",
          message: "等待首个可构建修订"
        },
        onSelectPart: () => undefined
      })
    );

    expect(screen.getByText("待首次权威构建")).toBeInTheDocument();
    expect(
      screen.getByText(/当前仅为空网格状态，不显示泵或伪几何/u)
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("旋片真空泵三维视图")
    ).not.toBeInTheDocument();
  });

  it("maps kernel diagnostic UUIDs and semantic refs to highlightable scene ids", () => {
    const modelDocument = createBlankPartDocument("诊断零件");
    modelDocument.features.push({
      id: "10000000-0000-4000-8000-000000000001",
      semanticRef: "feature.base",
      name: "基础实体",
      featureKind: "imported_step",
      artifactId: "10000000-0000-4000-8000-000000000002",
      artifactSha256: "a".repeat(64),
      sourceName: "base.step",
      bodySemanticRefs: ["body.base"],
      suppressed: false
    });

    expect(
      diagnosticSelectionIds(modelDocument, [
        { target_id: "10000000-0000-4000-8000-000000000001" },
        { targetId: "feature.base" }
      ])
    ).toEqual(["feature:feature.base"]);
  });
});
