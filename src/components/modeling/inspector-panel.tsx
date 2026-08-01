import {
  CheckCircle2,
  Eye,
  EyeOff,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  X
} from "lucide-react";
import { useState } from "react";
import type {
  InspectorTab,
  ModelingDocumentKind,
  ModelingSelection,
  PumpDocument,
  PumpParameterId
} from "@/lib/modeling/client/workspace-state";
import { PARAMETER_DEFINITIONS } from "@/lib/modeling/client/workspace-state";
import type {
  Component,
  Feature,
  ModelDocument,
  ModelParameter
} from "@/types/modeling";
import styles from "./modeling-workspace.module.css";

const INSPECTOR_TABS: { id: InspectorTab; label: string }[] = [
  { id: "properties", label: "属性" },
  { id: "parameters", label: "参数" },
  { id: "validation", label: "验证" },
  { id: "material", label: "材料" }
];

export function InspectorPanel({
  document,
  modelDocument,
  documentKind,
  selectedPartId,
  semanticSelections,
  activeTab,
  mobileOpen,
  onClose,
  onTab,
  onParameterChange,
  onModelParameterChange,
  onToggleVisibility,
  onToggleFeatureSuppressed,
  hiddenSemanticIds,
  isolatedSemanticId,
  onToggleSemanticVisibility,
  onIsolateSemantic,
  onActivateInterference
}: {
  document: PumpDocument;
  modelDocument: ModelDocument;
  documentKind: ModelingDocumentKind;
  selectedPartId: string;
  semanticSelections: ModelingSelection[];
  activeTab: InspectorTab;
  mobileOpen: boolean;
  onClose: () => void;
  onTab: (tab: InspectorTab) => void;
  onParameterChange: (id: PumpParameterId, value: number) => void;
  onModelParameterChange: (parameter: ModelParameter, value: number) => void;
  onToggleVisibility: (partId: string) => void;
  onToggleFeatureSuppressed: (feature: Feature, suppressed: boolean) => void;
  hiddenSemanticIds: string[];
  isolatedSemanticId?: string;
  onToggleSemanticVisibility: (semanticId: string) => void;
  onIsolateSemantic: (semanticId: string) => void;
  onActivateInterference: () => void;
}) {
  const selectedPart =
    document.parts.find((part) => part.id === selectedPartId) ??
    document.parts[0];
  const selectedFeature = selectedPartId.startsWith("feature:")
    ? modelDocument.features.find(
        (feature) => feature.semanticRef === selectedPartId.slice(8)
      )
    : undefined;
  const selectedComponent = selectedPartId.startsWith("component:")
    ? modelDocument.components.find(
        (component) => component.semanticRef === selectedPartId.slice(10)
      )
    : undefined;

  return (
    <aside
      className={`${styles.inspectorPanel} ${mobileOpen ? styles.drawerOpen : ""}`}
      aria-label="模型检查器"
    >
      <div
        className={styles.inspectorTabs}
        role="tablist"
        aria-label="检查器视图"
      >
        {INSPECTOR_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={
              activeTab === tab.id ? styles.inspectorTabActive : undefined
            }
            onClick={() => onTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <button
          type="button"
          className={styles.drawerClose}
          onClick={onClose}
          aria-label="关闭参数面板"
        >
          <X aria-hidden size={17} />
        </button>
      </div>

      <div className={styles.inspectorContent}>
        {activeTab === "parameters" && documentKind === "pump-template" ? (
          <ParameterInspector
            document={document}
            onParameterChange={onParameterChange}
          />
        ) : null}
        {activeTab === "parameters" && documentKind === "general-part" ? (
          <GeneralParameterInspector
            document={modelDocument}
            onParameterChange={onModelParameterChange}
          />
        ) : null}
        {activeTab === "properties" && documentKind === "pump-template" ? (
          <PropertiesInspector
            selectedPart={selectedPart}
            onToggleVisibility={onToggleVisibility}
          />
        ) : null}
        {activeTab === "properties" && documentKind === "general-part" ? (
          <GeneralSelectionInspector
            feature={selectedFeature}
            component={selectedComponent}
            selections={semanticSelections}
            onToggleSuppressed={onToggleFeatureSuppressed}
            hiddenSemanticIds={hiddenSemanticIds}
            isolatedSemanticId={isolatedSemanticId}
            onToggleVisibility={onToggleSemanticVisibility}
            onIsolate={onIsolateSemantic}
          />
        ) : null}
        {activeTab === "validation" && documentKind === "pump-template" ? (
          <ValidationInspector
            document={document}
            onActivateInterference={onActivateInterference}
          />
        ) : null}
        {activeTab === "validation" && documentKind === "general-part" ? (
          <GeneralValidationInspector document={modelDocument} />
        ) : null}
        {activeTab === "material" && documentKind === "pump-template" ? (
          <MaterialInspector
            selectedPartName={selectedPart.name}
            modelDocument={modelDocument}
          />
        ) : null}
        {activeTab === "material" && documentKind === "general-part" ? (
          <MaterialInspector
            selectedPartName={modelDocument.name}
            modelDocument={modelDocument}
          />
        ) : null}
      </div>
    </aside>
  );
}

function GeneralParameterInspector({
  document,
  onParameterChange
}: {
  document: ModelDocument;
  onParameterChange: (parameter: ModelParameter, value: number) => void;
}) {
  return (
    <section aria-labelledby="general-parameters-heading">
      <div className={styles.inspectorSectionHeading}>
        <h2 id="general-parameters-heading">通用特征参数</h2>
        <span>{document.parameters.length} 项</span>
      </div>
      {document.parameters.length ? (
        <div className={styles.parameterList}>
          {document.parameters.map((parameter) => (
            <label key={parameter.id} className={styles.parameterRow}>
              <span className={styles.parameterLabel}>
                {parameter.label}
                {!parameter.editable ? (
                  <small className={styles.fixedParameterNote}>只读</small>
                ) : null}
                <var>{parameter.semanticRef.split(".").at(-1)}</var>
              </span>
              <span className={styles.parameterInputWrap}>
                <input
                  type="number"
                  value={parameter.value}
                  min={parameter.minimum}
                  max={parameter.maximum}
                  step={parameter.parameterType === "integer" ? 1 : 0.1}
                  disabled={!parameter.editable}
                  aria-label={`${parameter.label}（${parameter.unit}）`}
                  onChange={(event) =>
                    onParameterChange(
                      parameter,
                      event.currentTarget.valueAsNumber
                    )
                  }
                />
                <span>
                  {parameter.unit === "count" ? "个" : parameter.unit}
                </span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className={styles.materialNote}>
          尚无已保存参数。创建草图或实体特征后，参数会随服务器修订显示。
        </p>
      )}
    </section>
  );
}

function GeneralSelectionInspector({
  feature,
  component,
  selections,
  onToggleSuppressed,
  hiddenSemanticIds,
  isolatedSemanticId,
  onToggleVisibility,
  onIsolate
}: {
  feature?: Feature;
  component?: Component;
  selections: ModelingSelection[];
  onToggleSuppressed: (feature: Feature, suppressed: boolean) => void;
  hiddenSemanticIds: string[];
  isolatedSemanticId?: string;
  onToggleVisibility: (semanticId: string) => void;
  onIsolate: (semanticId: string) => void;
}) {
  if (selections.length > 1) {
    return (
      <section aria-labelledby="general-multi-selection-heading">
        <div className={styles.inspectorSectionHeading}>
          <h2 id="general-multi-selection-heading">语义多选</h2>
          <span>{selections.length} 项</span>
        </div>
        <dl className={styles.propertyList}>
          {selections.map((selection, index) => (
            <div key={`${selection.collection}:${selection.id}`}>
              <dt>{index === 0 ? "目标" : `选择 ${index + 1}`}</dt>
              <dd>{selection.name}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.materialNote}>
          布尔运算使用第一个 Feature 为目标；装配约束只接受 Component。
        </p>
      </section>
    );
  }
  if (component) {
    const semanticId = `component:${component.semanticRef}`;
    return (
      <GeneralComponentInspector
        component={component}
        hidden={hiddenSemanticIds.includes(semanticId)}
        isolated={isolatedSemanticId === semanticId}
        onToggleVisibility={() => onToggleVisibility(semanticId)}
        onIsolate={() => onIsolate(semanticId)}
      />
    );
  }
  if (!feature) {
    return (
      <UnavailableInspector
        title="通用特征属性"
        message="请先在左侧特征树中选择一个已保存特征。"
      />
    );
  }
  const semanticId = `feature:${feature.semanticRef}`;
  return (
    <section aria-labelledby="general-feature-heading">
      <div className={styles.inspectorSectionHeading}>
        <h2 id="general-feature-heading">特征属性</h2>
        <span>已选择</span>
      </div>
      <div className={styles.propertyHero}>
        <span className={styles.propertyCube} aria-hidden>
          ◇
        </span>
        <div>
          <strong>{feature.name}</strong>
          <p>{feature.featureKind} · 协议实体</p>
        </div>
      </div>
      <dl className={styles.propertyList}>
        <div>
          <dt>语义引用</dt>
          <dd>{feature.semanticRef}</dd>
        </div>
        <div>
          <dt>求解状态</dt>
          <dd>{feature.suppressed ? "已抑制" : "参与求解"}</dd>
        </div>
      </dl>
      <button
        type="button"
        className={
          feature.suppressed ? styles.primaryButton : styles.outlineButton
        }
        onClick={() => onToggleSuppressed(feature, !feature.suppressed)}
      >
        <RefreshCw aria-hidden size={14} />
        {feature.suppressed ? "恢复特征" : "抑制特征"}
      </button>
      <ViewActions
        hidden={hiddenSemanticIds.includes(semanticId)}
        isolated={isolatedSemanticId === semanticId}
        onToggleVisibility={() => onToggleVisibility(semanticId)}
        onIsolate={() => onIsolate(semanticId)}
      />
    </section>
  );
}

function GeneralComponentInspector({
  component,
  hidden,
  isolated,
  onToggleVisibility,
  onIsolate
}: {
  component: Component;
  hidden: boolean;
  isolated: boolean;
  onToggleVisibility: () => void;
  onIsolate: () => void;
}) {
  return (
    <section aria-labelledby="general-component-heading">
      <div className={styles.inspectorSectionHeading}>
        <h2 id="general-component-heading">组件实例属性</h2>
        <span>{component.suppressed ? "已抑制" : "参与装配"}</span>
      </div>
      <div className={styles.propertyHero}>
        <span className={styles.propertyCube} aria-hidden>
          ◇
        </span>
        <div>
          <strong>{component.name}</strong>
          <p>{component.featureRefs.length} 个 Feature 引用</p>
        </div>
      </div>
      <dl className={styles.propertyList}>
        <div>
          <dt>语义引用</dt>
          <dd>{component.semanticRef}</dd>
        </div>
        <div>
          <dt>平移 mm</dt>
          <dd>{component.transform.translationMm.join(", ")}</dd>
        </div>
        <div>
          <dt>旋转 °</dt>
          <dd>{component.transform.rotationDegrees.join(", ")}</dd>
        </div>
      </dl>
      <ViewActions
        hidden={hidden}
        isolated={isolated}
        onToggleVisibility={onToggleVisibility}
        onIsolate={onIsolate}
      />
      <p className={styles.materialNote}>
        组件实例引用终态
        Feature；固定、贴合、同轴和距离约束由内核确定性求解，冲突循环会失败并保留上一版本。
      </p>
    </section>
  );
}

function ViewActions({
  hidden,
  isolated,
  onToggleVisibility,
  onIsolate
}: {
  hidden: boolean;
  isolated: boolean;
  onToggleVisibility: () => void;
  onIsolate: () => void;
}) {
  return (
    <div className={styles.viewActionRow}>
      <button
        type="button"
        className={styles.outlineButton}
        onClick={onToggleVisibility}
      >
        {hidden ? (
          <EyeOff aria-hidden size={14} />
        ) : (
          <Eye aria-hidden size={14} />
        )}
        {hidden ? "显示" : "隐藏"}
      </button>
      <button
        type="button"
        className={isolated ? styles.primaryButton : styles.outlineButton}
        onClick={onIsolate}
      >
        {isolated ? "退出隔离" : "隔离显示"}
      </button>
    </div>
  );
}

function GeneralValidationInspector({ document }: { document: ModelDocument }) {
  return (
    <section aria-labelledby="general-validation-heading">
      <div className={styles.validationSummary}>
        <div>
          <ShieldCheck size={21} />
          <div>
            <h2 id="general-validation-heading">服务器 CAD 校验</h2>
            <p>
              {document.features.length
                ? "最近修订已由内核接收"
                : "等待首个实体特征"}
            </p>
          </div>
        </div>
      </div>
      <p className={styles.materialNote}>
        每个手工操作批次都会先由 OCCT
        校验；失败时服务器保留旧修订，本地待保存操作不会丢失。
      </p>
    </section>
  );
}

function UnavailableInspector({
  title,
  message
}: {
  title: string;
  message: string;
}) {
  return (
    <section>
      <div className={styles.inspectorSectionHeading}>
        <h2>{title}</h2>
        <span>未开放</span>
      </div>
      <p className={styles.materialNote}>{message}</p>
    </section>
  );
}

function ParameterInspector({
  document,
  onParameterChange
}: {
  document: PumpDocument;
  onParameterChange: (id: PumpParameterId, value: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section aria-labelledby="basic-parameters-heading">
      <div className={styles.inspectorSectionHeading}>
        <h2 id="basic-parameters-heading">基本参数 (mm)</h2>
        <span>参数化</span>
      </div>
      {!collapsed ? (
        <div className={styles.parameterList}>
          {PARAMETER_DEFINITIONS.map((parameter) => {
            const fixedVaneCount = parameter.id === "vaneCount";
            return (
              <label key={parameter.id} className={styles.parameterRow}>
                <span className={styles.parameterLabel}>
                  {parameter.label}
                  {fixedVaneCount ? (
                    <small className={styles.fixedParameterNote}>
                      V1 固定 2
                    </small>
                  ) : null}
                  <var>{parameter.symbol}</var>
                </span>
                <span className={styles.parameterInputWrap}>
                  <input
                    type="number"
                    value={document.parameters[parameter.id]}
                    min={parameter.min}
                    max={parameter.max}
                    step={parameter.step}
                    disabled={fixedVaneCount}
                    title={fixedVaneCount ? "V1 固定双滑片" : undefined}
                    onChange={(event) =>
                      onParameterChange(
                        parameter.id,
                        event.currentTarget.valueAsNumber
                      )
                    }
                    aria-label={
                      fixedVaneCount
                        ? "旋片数量（V1 固定双滑片）"
                        : `${parameter.label}${parameter.unit ? `（${parameter.unit}）` : ""}`
                    }
                  />
                  {parameter.unit ? <span>{parameter.unit}</span> : null}
                </span>
              </label>
            );
          })}
        </div>
      ) : null}
      <button
        type="button"
        className={styles.collapseButton}
        onClick={() => setCollapsed((current) => !current)}
        aria-expanded={!collapsed}
      >
        {collapsed ? "展开参数" : "收起参数"}
        <span aria-hidden>{collapsed ? "⌄" : "⌃"}</span>
      </button>
    </section>
  );
}

function PropertiesInspector({
  selectedPart,
  onToggleVisibility
}: {
  selectedPart: PumpDocument["parts"][number];
  onToggleVisibility: (partId: string) => void;
}) {
  return (
    <section aria-labelledby="part-properties-heading">
      <div className={styles.inspectorSectionHeading}>
        <h2 id="part-properties-heading">零部件属性</h2>
        <span>已选择</span>
      </div>
      <div className={styles.propertyHero}>
        <span className={styles.propertyCube} aria-hidden>
          ◇
        </span>
        <div>
          <strong>{selectedPart.name}</strong>
          <p>{selectedPart.kind} · 参数化实体</p>
        </div>
      </div>
      <dl className={styles.propertyList}>
        <div>
          <dt>实体 ID</dt>
          <dd>{selectedPart.id}</dd>
        </div>
        <div>
          <dt>构建方式</dt>
          <dd>模板参数化内核（不可单独抑制）</dd>
        </div>
        <div>
          <dt>显示状态</dt>
          <dd>{selectedPart.visible ? "可见" : "隐藏"}</dd>
        </div>
      </dl>
      <div className={styles.inspectorSingleButton}>
        <button
          type="button"
          className={styles.outlineButton}
          onClick={() => onToggleVisibility(selectedPart.id)}
        >
          {selectedPart.visible ? <EyeOff size={15} /> : <Eye size={15} />}
          {selectedPart.visible ? "隐藏" : "显示"}
        </button>
      </div>
    </section>
  );
}

function ValidationInspector({
  document,
  onActivateInterference
}: {
  document: PumpDocument;
  onActivateInterference: () => void;
}) {
  const clearance =
    (document.parameters.cavityDiameter - document.parameters.rotorDiameter) /
      2 -
    document.parameters.eccentricity;
  const checks = [
    {
      label: "径向间隙公式",
      value: clearance > 0 ? "参数可行" : "参数冲突",
      pass: clearance > 0
    },
    {
      label: "最小间隙",
      value: `${Math.max(0, clearance).toFixed(2)} mm`,
      pass: clearance > 0
    },
    { label: "旋片行程", value: "等待内核诊断", pass: undefined },
    { label: "体积计算", value: "等待内核诊断", pass: undefined },
    { label: "密封线连续性", value: "等待内核诊断", pass: undefined }
  ];

  return (
    <section aria-labelledby="validation-heading">
      <div className={styles.validationSummary}>
        <div>
          {clearance > 0 ? (
            <ShieldCheck size={21} />
          ) : (
            <TriangleAlert size={21} />
          )}
          <div>
            <h2 id="validation-heading">客户端参数预检</h2>
            <p>{clearance > 0 ? "径向公式未发现冲突" : "径向公式需要调整"}</p>
          </div>
        </div>
      </div>
      <ul className={styles.validationList}>
        {checks.map((check) => (
          <li key={check.label}>
            {check.pass === true ? (
              <CheckCircle2 aria-hidden size={14} />
            ) : check.pass === false ? (
              <TriangleAlert aria-hidden size={14} />
            ) : (
              <RefreshCw aria-hidden size={14} />
            )}
            <span>{check.label}</span>
            <strong>{check.value}</strong>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className={styles.validationButton}
        onClick={onActivateInterference}
      >
        <RefreshCw aria-hidden size={14} />
        运行权威干涉检查
      </button>
    </section>
  );
}

function MaterialInspector({
  selectedPartName,
  modelDocument
}: {
  selectedPartName: string;
  modelDocument: ModelDocument;
}) {
  const material = modelDocument.metadata?.material;
  return (
    <section aria-labelledby="material-heading">
      <div className={styles.inspectorSectionHeading}>
        <h2 id="material-heading">材料属性</h2>
        <span>{material ? "用户输入" : "未设置"}</span>
      </div>
      {material ? (
        <>
          <dl className={styles.propertyList}>
            <div>
              <dt>对象</dt>
              <dd>{selectedPartName}</dd>
            </div>
            <div>
              <dt>材料名称</dt>
              <dd>{material.name ?? "用户未命名"}</dd>
            </div>
            <div>
              <dt>密度</dt>
              <dd>{material.densityKgM3.toLocaleString()} kg/m³</dd>
            </div>
            <div>
              <dt>来源</dt>
              <dd>用户显式输入</dd>
            </div>
          </dl>
          <p className={styles.materialNote}>
            质量由权威 B-Rep
            体积乘以此密度计算；不代表牌号、孔隙率、涂层、紧固件或工作液的制造真值。
          </p>
        </>
      ) : (
        <p className={styles.materialNote}>
          “{selectedPartName}
          ”没有用户确认的材料密度，内核会把质量明确标记为不可用，不会猜测牌号或物性。
        </p>
      )}
    </section>
  );
}
