import {
  Box,
  CheckSquare2,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FilePenLine,
  Folder,
  History,
  Layers3,
  LoaderCircle,
  MoreVertical,
  Plus,
  RefreshCw,
  RotateCcw,
  Ruler,
  Settings2,
  Square,
  Upload,
  X
} from "lucide-react";
import type { ModelingRevisionSummary } from "@/lib/modeling/client/api";
import type {
  ManualOperation,
  ModelingDocumentKind,
  ModelingSelection,
  PumpDocument
} from "@/lib/modeling/client/workspace-state";
import type { Component, Feature, ModelDocument } from "@/types/modeling";
import styles from "./modeling-workspace.module.css";

export function ProjectPanel({
  projectName,
  document,
  modelDocument,
  documentKind,
  pendingOperations,
  selectedPartId,
  semanticSelections,
  hiddenSemanticIds,
  isolatedSemanticId,
  mobileOpen,
  readOnlyHistory,
  revisions,
  revisionsLoading,
  activeRevisionId,
  currentRevisionId,
  canImportStep,
  historyError,
  importStatus,
  onClose,
  onNew,
  onImportStep,
  onRefreshRevisions,
  onOpenRevision,
  onReturnToCurrent,
  onSelectPart,
  onSelectSemantic,
  onToggleVisibility,
  onToggleFeatureSuppressed,
  onToggleSemanticVisibility,
  onIsolateSemantic
}: {
  projectName: string;
  document: PumpDocument;
  modelDocument: ModelDocument;
  documentKind: ModelingDocumentKind;
  pendingOperations: ManualOperation[];
  selectedPartId: string;
  semanticSelections: ModelingSelection[];
  hiddenSemanticIds: string[];
  isolatedSemanticId?: string;
  mobileOpen: boolean;
  readOnlyHistory: boolean;
  revisions: ModelingRevisionSummary[];
  revisionsLoading: boolean;
  activeRevisionId?: string;
  currentRevisionId?: string;
  canImportStep: boolean;
  historyError?: string;
  importStatus?: { busy: boolean; message: string; error?: boolean };
  onClose: () => void;
  onNew: () => void;
  onImportStep: (file: File) => void;
  onRefreshRevisions: () => void;
  onOpenRevision: (revision: ModelingRevisionSummary) => void;
  onReturnToCurrent: () => void;
  onSelectPart: (partId: string) => void;
  onSelectSemantic: (selection: ModelingSelection, additive: boolean) => void;
  onToggleVisibility: (partId: string) => void;
  onToggleFeatureSuppressed: (feature: Feature, suppressed: boolean) => void;
  onToggleSemanticVisibility: (semanticId: string) => void;
  onIsolateSemantic: (semanticId: string) => void;
}) {
  const mutationLocked = readOnlyHistory || Boolean(importStatus?.busy);
  return (
    <aside
      className={`${styles.projectPanel} ${mobileOpen ? styles.drawerOpen : ""}`}
      aria-label="项目结构"
    >
      <div className={styles.panelTitleRow}>
        <h2>项目</h2>
        <div className={styles.panelTitleActions}>
          <button
            type="button"
            className={styles.outlineButton}
            onClick={onNew}
            disabled={mutationLocked}
          >
            <Plus aria-hidden size={15} />
            新建
          </button>
          <label
            className={`${styles.outlineButton} ${styles.importButton} ${!canImportStep || importStatus?.busy ? styles.controlDisabled : ""}`}
            title={
              canImportStep
                ? "导入为新的不可变 STEP 基础实体版本"
                : "请先返回当前版本并保存待处理操作，再导入 STEP"
            }
          >
            {importStatus?.busy ? (
              <LoaderCircle aria-hidden size={15} className={styles.spin} />
            ) : (
              <Upload aria-hidden size={15} />
            )}
            STEP
            <input
              className={styles.fileInput}
              type="file"
              accept=".step,.stp,model/step,application/step,application/octet-stream"
              aria-label="导入 STEP 文件"
              disabled={!canImportStep || importStatus?.busy}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) onImportStep(file);
              }}
            />
          </label>
          <button
            type="button"
            className={styles.drawerClose}
            onClick={onClose}
            aria-label="关闭项目面板"
          >
            <X aria-hidden size={17} />
          </button>
        </div>
      </div>

      {importStatus?.message ? (
        <p
          className={`${styles.projectStatus} ${importStatus.error ? styles.projectStatusError : ""}`}
          role={importStatus.error ? "alert" : "status"}
        >
          {importStatus.message}
        </p>
      ) : null}

      <div className={styles.tree}>
        <TreeGroup
          icon={<Folder size={15} />}
          label={projectName}
          strong
          endIcon={<MoreVertical size={14} />}
        >
          <TreeRow
            icon={<span className={styles.sigma}>Σ</span>}
            label={`参数${documentKind === "general-part" ? `（${modelDocument.parameters.length}）` : ""}`}
            inset={1}
          />
          <TreeGroup icon={<Folder size={14} />} label="参考几何" inset={1}>
            <TreeRow
              icon={<Settings2 size={14} />}
              label="坐标系"
              inset={2}
              collapsed
            />
            <TreeRow
              icon={<Layers3 size={14} />}
              label="基准平面"
              inset={2}
              collapsed
            />
          </TreeGroup>
          <TreeGroup icon={<FilePenLine size={14} />} label="草图" inset={1}>
            {modelDocument.sketches.length ? (
              modelDocument.sketches.map((sketch, index) => (
                <TreeRow
                  key={sketch.id}
                  icon={<FilePenLine size={14} />}
                  label={`${index + 1}. ${sketch.name}`}
                  inset={2}
                />
              ))
            ) : (
              <TreeRow
                icon={<FilePenLine size={14} />}
                label={
                  documentKind === "pump-template"
                    ? "模板由参数化特征直接构建，未声明独立草图历史"
                    : "尚无已保存草图"
                }
                inset={2}
              />
            )}
          </TreeGroup>
          {documentKind === "pump-template" ? (
            <TreeGroup icon={<Box size={14} />} label="零部件" inset={1}>
              {document.parts.map((part) => (
                <div
                  key={part.id}
                  className={`${styles.partRow} ${selectedPartId === part.id ? styles.partRowSelected : ""}`}
                  style={{ "--tree-inset": 2 } as React.CSSProperties}
                >
                  <button
                    type="button"
                    className={styles.partSelect}
                    onClick={() => onSelectPart(part.id)}
                    aria-pressed={selectedPartId === part.id}
                  >
                    <Box aria-hidden size={13} />
                    <span>{part.name}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.treeIconButton}
                    onClick={() => onToggleVisibility(part.id)}
                    aria-label={`${part.visible ? "隐藏" : "显示"}${part.name}`}
                    disabled={mutationLocked}
                  >
                    {part.visible ? (
                      <Eye aria-hidden size={14} />
                    ) : (
                      <EyeOff aria-hidden size={14} />
                    )}
                  </button>
                </div>
              ))}
            </TreeGroup>
          ) : (
            <TreeGroup icon={<Box size={14} />} label="特征" inset={1}>
              {modelDocument.features.length ? (
                modelDocument.features.map((feature, index) => {
                  const suppressed = stagedSuppression(
                    feature,
                    pendingOperations
                  );
                  const selection = selectionForFeature(feature);
                  const selected = selectionIncluded(
                    semanticSelections,
                    selection
                  );
                  const viewId = `feature:${feature.semanticRef}`;
                  const hidden = hiddenSemanticIds.includes(viewId);
                  return (
                    <div
                      key={feature.id}
                      className={`${styles.partRow} ${selected ? styles.partRowSelected : ""} ${suppressed ? styles.partRowSuppressed : ""}`}
                      style={{ "--tree-inset": 2 } as React.CSSProperties}
                    >
                      <button
                        type="button"
                        className={styles.partSelect}
                        onClick={() => onSelectSemantic(selection, false)}
                        aria-pressed={selected}
                        aria-label={`选择特征：${feature.name}`}
                      >
                        <Box aria-hidden size={13} />
                        <span>{`${index + 1}. ${feature.name}`}</span>
                      </button>
                      <SemanticMultiSelectButton
                        selected={selected}
                        name={feature.name}
                        onClick={() => onSelectSemantic(selection, true)}
                      />
                      <button
                        type="button"
                        className={styles.treeIconButton}
                        onClick={() => onToggleSemanticVisibility(viewId)}
                        aria-label={`${hidden ? "显示" : "隐藏"}${feature.name}`}
                        aria-pressed={hidden}
                      >
                        {hidden ? (
                          <EyeOff aria-hidden size={14} />
                        ) : (
                          <Eye aria-hidden size={14} />
                        )}
                      </button>
                      <button
                        type="button"
                        className={styles.treeIconButton}
                        onClick={() => onIsolateSemantic(viewId)}
                        aria-label={`${isolatedSemanticId === viewId ? "退出隔离" : "隔离"}${feature.name}`}
                        aria-pressed={isolatedSemanticId === viewId}
                        title="隔离显示"
                      >
                        I
                      </button>
                      <button
                        type="button"
                        className={styles.suppressButton}
                        onClick={() =>
                          onToggleFeatureSuppressed(feature, !suppressed)
                        }
                        aria-label={`${suppressed ? "恢复" : "抑制"}${feature.name}`}
                        aria-pressed={suppressed}
                        title={suppressed ? "恢复特征" : "抑制特征"}
                        disabled={mutationLocked}
                      >
                        S
                      </button>
                    </div>
                  );
                })
              ) : (
                <TreeRow
                  icon={<Box size={13} />}
                  label="尚无已保存实体特征"
                  inset={2}
                />
              )}
              {pendingOperations.some(
                (operation) =>
                  operation.type === "tool_command" ||
                  operation.type === "add_boolean_feature" ||
                  operation.type === "add_component_instance" ||
                  operation.type === "add_assembly_constraint"
              ) ? (
                <TreeRow
                  icon={<Layers3 size={13} />}
                  label={`${pendingOperations.filter((operation) => !["set_parameter", "set_model_parameter", "set_part_visibility", "set_section"].includes(operation.type)).length} 个待保存建模命令`}
                  inset={2}
                />
              ) : null}
            </TreeGroup>
          )}
          {documentKind === "general-part" ? (
            <>
              <TreeGroup
                icon={<Layers3 size={14} />}
                label="组件实例"
                inset={1}
              >
                {modelDocument.components.length ? (
                  modelDocument.components.map((component, index) => {
                    const selection = selectionForComponent(component);
                    const selected = selectionIncluded(
                      semanticSelections,
                      selection
                    );
                    const viewId = `component:${component.semanticRef}`;
                    const hidden = hiddenSemanticIds.includes(viewId);
                    return (
                      <div
                        key={component.id}
                        className={`${styles.partRow} ${selected ? styles.partRowSelected : ""} ${component.suppressed ? styles.partRowSuppressed : ""}`}
                        style={{ "--tree-inset": 2 } as React.CSSProperties}
                      >
                        <button
                          type="button"
                          className={styles.partSelect}
                          onClick={() => onSelectSemantic(selection, false)}
                          aria-pressed={selected}
                          aria-label={`选择组件：${component.name}`}
                        >
                          <Layers3 aria-hidden size={13} />
                          <span>{`${index + 1}. ${component.name}`}</span>
                          <small>{transformLabel(component)}</small>
                        </button>
                        <SemanticMultiSelectButton
                          selected={selected}
                          name={component.name}
                          onClick={() => onSelectSemantic(selection, true)}
                        />
                        <button
                          type="button"
                          className={styles.treeIconButton}
                          onClick={() => onToggleSemanticVisibility(viewId)}
                          aria-label={`${hidden ? "显示" : "隐藏"}${component.name}`}
                          aria-pressed={hidden}
                        >
                          {hidden ? (
                            <EyeOff aria-hidden size={14} />
                          ) : (
                            <Eye aria-hidden size={14} />
                          )}
                        </button>
                        <button
                          type="button"
                          className={styles.treeIconButton}
                          onClick={() => onIsolateSemantic(viewId)}
                          aria-label={`${isolatedSemanticId === viewId ? "退出隔离" : "隔离"}${component.name}`}
                          aria-pressed={isolatedSemanticId === viewId}
                          title="隔离显示"
                        >
                          I
                        </button>
                      </div>
                    );
                  })
                ) : (
                  <TreeRow
                    icon={<Layers3 size={13} />}
                    label="尚无已保存组件实例"
                    inset={2}
                  />
                )}
                {semanticSelections.length > 1 ? (
                  <TreeRow
                    icon={<CheckSquare2 size={13} />}
                    label={`已多选 ${semanticSelections.length} 个语义对象`}
                    inset={2}
                  />
                ) : null}
              </TreeGroup>
              <TreeGroup
                icon={<Layers3 size={14} />}
                label="装配关系 · 基准求解"
                inset={1}
              >
                {modelDocument.assemblyConstraints.length ? (
                  modelDocument.assemblyConstraints.map((constraint) => (
                    <TreeRow
                      key={constraint.id}
                      icon={<Settings2 size={13} />}
                      label={`${constraint.name} · ${constraint.status}`}
                      inset={2}
                    />
                  ))
                ) : (
                  <TreeRow
                    icon={<Settings2 size={13} />}
                    label="尚无已保存装配约束"
                    inset={2}
                  />
                )}
              </TreeGroup>
            </>
          ) : (
            <TreeRow
              icon={<Layers3 size={14} />}
              label="装配关系（模板内置）"
              inset={1}
              collapsed
            />
          )}
          <TreeGroup icon={<Ruler size={14} />} label="剖切视图" inset={1}>
            <TreeRow
              icon={<Box size={13} />}
              label={
                document.sectionEnabled
                  ? "客户端剖切视图（当前开启）"
                  : "客户端剖切视图（当前关闭）"
              }
              inset={2}
            />
          </TreeGroup>
        </TreeGroup>

        <div className={styles.revisionSection}>
          <div className={styles.revisionHeading}>
            <span>
              <History aria-hidden size={14} />
              版本历史
            </span>
            <button
              type="button"
              onClick={onRefreshRevisions}
              disabled={revisionsLoading || !currentRevisionId}
              aria-label="刷新版本历史"
              title="刷新版本历史"
            >
              <RefreshCw
                aria-hidden
                size={13}
                className={revisionsLoading ? styles.spin : undefined}
              />
            </button>
          </div>
          {readOnlyHistory ? (
            <div className={styles.historyNotice} role="status">
              <span>历史版本只读，编辑器与 AI 指令已锁定。</span>
              <button type="button" onClick={onReturnToCurrent}>
                <RotateCcw aria-hidden size={13} />
                返回当前版本
              </button>
            </div>
          ) : null}
          {historyError ? (
            <p className={styles.revisionError} role="status">
              版本历史读取失败：{historyError}
            </p>
          ) : null}
          {revisions.length ? (
            <ol className={styles.revisionList} aria-label="项目版本">
              {revisions.map((revision) => {
                const active = revision.id === activeRevisionId;
                const current = revision.id === currentRevisionId;
                return (
                  <li key={revision.id}>
                    <button
                      type="button"
                      className={active ? styles.revisionActive : undefined}
                      onClick={() => onOpenRevision(revision)}
                      disabled={
                        !revision.document || Boolean(importStatus?.busy)
                      }
                      aria-current={active ? "true" : undefined}
                      aria-label={
                        current
                          ? `打开当前版本 V${revision.revisionNumber ?? "未知"}`
                          : `只读打开历史版本 V${revision.revisionNumber ?? "未知"}`
                      }
                      title={
                        revision.document
                          ? current
                            ? `打开当前版本 ${revision.revisionNumber ?? "未知"}`
                            : `只读打开历史版本 ${revision.revisionNumber ?? "未知"}`
                          : "版本文档不可用"
                      }
                    >
                      <span>
                        <strong>V{revision.revisionNumber ?? "?"}</strong>
                        <span>{revisionSourceLabel(revision.source)}</span>
                      </span>
                      <span>
                        <time dateTime={revision.createdAt}>
                          {revisionTimeLabel(revision.createdAt)}
                        </time>
                        {current ? <em>当前</em> : null}
                        {active && !current ? <em>只读</em> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className={styles.revisionEmpty}>
              {revisionsLoading
                ? "正在读取不可变版本…"
                : currentRevisionId
                  ? "暂无可显示版本"
                  : "项目保存后显示版本历史"}
            </p>
          )}
        </div>
      </div>

      <div className={styles.configuration}>
        <h3>配置</h3>
        <button
          type="button"
          className={styles.configurationButton}
          disabled
          title="配置切换尚未开放"
        >
          <Settings2 aria-hidden size={14} />
          <span>默认配置</span>
          <span className={styles.configurationCheck} aria-hidden>
            ✓
          </span>
        </button>
      </div>
    </aside>
  );
}

function revisionSourceLabel(source: ModelingRevisionSummary["source"]) {
  switch (source) {
    case "initial":
      return "初始";
    case "manual":
      return "手工";
    case "ai_plan":
      return "AI 计划";
    case "import":
      return "STEP 导入";
    default:
      return "版本";
  }
}

function revisionTimeLabel(value?: string) {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function SemanticMultiSelectButton({
  selected,
  name,
  onClick
}: {
  selected: boolean;
  name: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.semanticSelectButton}
      onClick={onClick}
      aria-label={`${selected ? "移出" : "加入"}多选：${name}`}
      aria-pressed={selected}
      title={selected ? "移出语义多选" : "加入语义多选"}
    >
      {selected ? (
        <CheckSquare2 aria-hidden size={14} />
      ) : (
        <Square aria-hidden size={14} />
      )}
    </button>
  );
}

function selectionForFeature(feature: Feature): ModelingSelection {
  return {
    collection: "features",
    id: feature.id,
    semanticRef: feature.semanticRef,
    name: feature.name
  };
}

function selectionForComponent(component: Component): ModelingSelection {
  return {
    collection: "components",
    id: component.id,
    semanticRef: component.semanticRef,
    name: component.name
  };
}

function selectionIncluded(
  selections: readonly ModelingSelection[],
  target: ModelingSelection
) {
  return selections.some(
    (selection) =>
      selection.collection === target.collection &&
      selection.id === target.id &&
      selection.semanticRef === target.semanticRef
  );
}

function transformLabel(component: Component) {
  const [x, y, z] = component.transform.translationMm;
  return `T ${x}, ${y}, ${z} mm`;
}

function stagedSuppression(
  feature: Feature,
  operations: readonly ManualOperation[]
) {
  const staged = [...operations]
    .reverse()
    .find(
      (operation) =>
        operation.type === "set_feature_suppressed" &&
        operation.featureId === feature.id &&
        operation.semanticRef === feature.semanticRef
    );
  return staged?.type === "set_feature_suppressed"
    ? staged.suppressed
    : feature.suppressed;
}

function TreeGroup({
  icon,
  label,
  inset = 0,
  strong = false,
  endIcon,
  children
}: {
  icon: React.ReactNode;
  label: string;
  inset?: number;
  strong?: boolean;
  endIcon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.treeGroup}>
      <div
        className={`${styles.treeGroupLabel} ${strong ? styles.treeStrong : ""}`}
        style={{ "--tree-inset": inset } as React.CSSProperties}
      >
        <ChevronDown aria-hidden size={13} />
        {icon}
        <span>{label}</span>
        {endIcon ? <span className={styles.treeEndIcon}>{endIcon}</span> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

function TreeRow({
  icon,
  label,
  inset,
  collapsed = false
}: {
  icon: React.ReactNode;
  label: string;
  inset: number;
  collapsed?: boolean;
}) {
  return (
    <div
      className={styles.treeRow}
      style={{ "--tree-inset": inset } as React.CSSProperties}
    >
      {collapsed ? (
        <ChevronRight aria-hidden size={13} />
      ) : (
        <span className={styles.treeSpacer} />
      )}
      {icon}
      <span>{label}</span>
    </div>
  );
}
