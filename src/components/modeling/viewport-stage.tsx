"use client";

import {
  Box,
  CircleDot,
  Focus,
  Layers3,
  RotateCcw,
  Ruler,
  Settings2
} from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import type {
  ModelingDocumentKind,
  ModelingSelection,
  ModelingTool,
  PumpDocument
} from "@/lib/modeling/client/workspace-state";
import type { ModelDocument } from "@/types/modeling";
import styles from "./modeling-workspace.module.css";

type ViewportMeasurement =
  | { status: "awaiting-second-point"; sourceKey: string }
  | { status: "complete"; distanceMm: number; sourceKey: string };

const PumpViewport = dynamic(() => import("./pump-viewport"), {
  ssr: false,
  loading: () => (
    <div className={styles.viewportLoading} role="status">
      <span className={styles.viewportLoadingMark} aria-hidden />
      正在载入参数化视图…
    </div>
  )
});

export function ViewportStage({
  document,
  documentKind,
  selectedPartId,
  activeTool,
  kernelPreview,
  modelDocument,
  semanticSelections,
  hiddenSemanticIds = [],
  isolatedSemanticId,
  onSelectPart
}: {
  document: PumpDocument;
  documentKind: ModelingDocumentKind;
  selectedPartId: string;
  activeTool: ModelingTool;
  kernelPreview: {
    status: "procedural" | "queued" | "ready" | "failed";
    url?: string;
    message?: string;
    diagnostics?: Array<{
      code: string;
      severity: string;
      message: string;
      target_id?: string | null;
      targetId?: string | null;
    }>;
  };
  modelDocument: ModelDocument;
  semanticSelections: ModelingSelection[];
  hiddenSemanticIds?: string[];
  isolatedSemanticId?: string;
  onSelectPart: (partId: string) => void;
}) {
  const [measurement, setMeasurement] = useState<ViewportMeasurement>();
  const measurementSourceKey = `${modelDocument.revisionId}:${kernelPreview.url ?? "none"}`;
  const currentMeasurement =
    measurement?.sourceKey === measurementSourceKey ? measurement : undefined;
  const diagnosticIds = diagnosticSelectionIds(
    modelDocument,
    kernelPreview.diagnostics ?? []
  );
  const visibleDiagnostics = (kernelPreview.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.severity !== "info"
  );

  return (
    <div className={styles.viewportStage}>
      {documentKind === "pump-template" || kernelPreview.url ? (
        <PumpViewport
          document={document}
          documentKind={documentKind}
          modelDocument={modelDocument}
          selectedPartId={selectedPartId}
          selectedSemanticIds={semanticSelections.map(
            (selection) =>
              `${selection.collection === "features" ? "feature" : "component"}:${selection.semanticRef}`
          )}
          errorSemanticIds={diagnosticIds}
          hiddenSemanticIds={hiddenSemanticIds}
          isolatedSemanticId={isolatedSemanticId}
          activeTool={activeTool}
          previewUrl={kernelPreview.url}
          onSelectPart={onSelectPart}
          onMeasurementChange={(next) =>
            setMeasurement(
              next ? { ...next, sourceKey: measurementSourceKey } : undefined
            )
          }
        />
      ) : (
        <div className={styles.generalPartEmpty} role="status">
          <Box aria-hidden size={34} />
          <strong>待首次权威构建</strong>
          <span>先创建基础草图，再暂存拉伸或旋转实体并保存。</span>
          <small>
            当前仅为空网格状态，不显示泵或伪几何；服务器 CAD
            校验通过后才加载真实 GLB。
          </small>
        </div>
      )}

      <div className={styles.viewStatus}>
        <span className={styles.liveDot} aria-hidden />
        {kernelPreview.message ??
          (documentKind === "pump-template"
            ? "参数化客户端预览"
            : "等待首个可构建修订")}
      </div>

      {visibleDiagnostics.length ? (
        <div className={styles.viewportDiagnostic} role="alert">
          <strong>
            {visibleDiagnostics.some(
              (diagnostic) => diagnostic.severity === "error"
            )
              ? "内核拒绝当前规格"
              : "内核检查警告"}
          </strong>
          <span>{visibleDiagnostics[0]!.message}</span>
        </div>
      ) : null}

      {documentKind === "pump-template" && activeTool === "measure" ? (
        <div className={styles.measureOverlay} aria-live="polite">
          <div className={styles.measureHorizontal}>
            <span>Ø {document.parameters.cavityDiameter.toFixed(1)} mm</span>
          </div>
          <div className={styles.measureVertical}>
            <span>{document.parameters.axialWidth.toFixed(1)} mm</span>
          </div>
        </div>
      ) : null}

      {documentKind === "general-part" && activeTool === "measure" ? (
        <div className={styles.measureResult} aria-live="polite">
          <Ruler aria-hidden size={15} />
          {kernelPreview.url
            ? currentMeasurement?.status === "complete"
              ? `点到点距离 ${currentMeasurement.distanceMm.toFixed(3)} mm`
              : currentMeasurement?.status === "awaiting-second-point"
                ? "已选第一点，请在实体上选择第二点"
                : "在权威 GLB 实体上依次选择两点"
            : "请先保存并完成权威 GLB 构建"}
        </div>
      ) : null}

      {activeTool === "section" ||
      (documentKind === "pump-template" && document.sectionEnabled) ? (
        <div className={styles.sectionCallout}>
          <span>剖切 1</span>
          <strong>YZ · 0.0 mm</strong>
        </div>
      ) : null}

      {documentKind === "pump-template" && activeTool === "interference" ? (
        <div className={styles.interferenceCallout} role="status">
          <CircleDot aria-hidden size={14} />
          旋转示意 · 干涉结论以当前修订的 OCCT 内核诊断为准
        </div>
      ) : null}

      <div className={styles.viewportDock} role="toolbar" aria-label="视图控制">
        <button
          type="button"
          title="等轴测视图"
          aria-label="等轴测视图"
          onClick={() => sendViewCommand("isometric")}
        >
          <Box aria-hidden size={16} />
        </button>
        <button
          type="button"
          title="适合窗口"
          aria-label="适合窗口"
          onClick={() => sendViewCommand("fit")}
        >
          <Focus aria-hidden size={16} />
        </button>
        <button
          type="button"
          title="显示/隐藏网格"
          aria-label="显示或隐藏网格"
          onClick={() => sendViewCommand("grid")}
        >
          <Layers3 aria-hidden size={16} />
        </button>
        <span aria-hidden />
        <button
          type="button"
          title="重置视图"
          aria-label="重置视图"
          onClick={() => sendViewCommand("reset")}
        >
          <RotateCcw aria-hidden size={16} />
        </button>
        <button
          type="button"
          title="切换画布明暗"
          aria-label="切换画布明暗"
          onClick={() => sendViewCommand("background")}
        >
          <Settings2 aria-hidden size={16} />
        </button>
      </div>
    </div>
  );
}

export function diagnosticSelectionIds(
  document: ModelDocument,
  diagnostics: Array<{ target_id?: string | null; targetId?: string | null }>
) {
  const identities = new Map<string, string>();
  for (const feature of document.features) {
    const selectionId = `feature:${feature.semanticRef}`;
    identities.set(feature.id, selectionId);
    identities.set(feature.semanticRef, selectionId);
  }
  for (const component of document.components) {
    const selectionId = `component:${component.semanticRef}`;
    identities.set(component.id, selectionId);
    identities.set(component.semanticRef, selectionId);
  }
  return [
    ...new Set(
      diagnostics.flatMap((diagnostic) =>
        String(diagnostic.target_id ?? diagnostic.targetId ?? "")
          .split("|")
          .map((target) => identities.get(target))
          .filter((target): target is string => Boolean(target))
      )
    )
  ];
}

function sendViewCommand(command: string) {
  window.dispatchEvent(
    new CustomEvent("openvac:modeling-view", { detail: { command } })
  );
}
