import { Check, Info, X } from "lucide-react";
import { FormEvent, useState } from "react";
import type { ModelingTool } from "@/lib/modeling/client/workspace-state";
import type { ManualToolContext } from "@/lib/modeling/client/protocol-adapter";
import styles from "./modeling-workspace.module.css";

type ManualFormTool = Exclude<
  ModelingTool,
  "select" | "measure" | "section" | "interference"
>;

const TOOL_TITLES: Record<ManualFormTool, string> = {
  sketch: "新建基础草图",
  extrude: "拉伸新实体",
  cut: "切除选中实体",
  rotate: "旋转新实体",
  slot: "新建开槽草图",
  hole: "在选中实体上创建孔",
  fillet: "在选中实体上创建圆角",
  chamfer: "在选中实体上创建倒角",
  mirror: "镜像选中实体",
  "linear-pattern": "线性阵列选中实体",
  "circular-pattern": "圆周阵列选中实体",
  reorder: "重排选中特征",
  boolean: "多实体布尔运算",
  assembly: "组件实例与装配约束"
};

const MANUAL_FORM_TOOLS = new Set<ManualFormTool>(
  Object.keys(TOOL_TITLES) as ManualFormTool[]
);

export function ToolSettingsPanel({
  tool,
  open,
  context,
  onClose,
  onCommit
}: {
  tool: ModelingTool;
  open: boolean;
  context: ManualToolContext;
  onClose: () => void;
  onCommit: (settings: Record<string, number | string | boolean>) => void;
}) {
  const manualTool = MANUAL_FORM_TOOLS.has(tool as ManualFormTool)
    ? (tool as ManualFormTool)
    : undefined;
  const [values, setValues] = useState<Record<string, string>>(() =>
    manualTool ? defaultValues(manualTool, context) : {}
  );
  const [error, setError] = useState<string>();

  if (!open || !manualTool) return null;

  const update = (key: string, value: string) => {
    setValues((current) => ({ ...current, [key]: value }));
    setError(undefined);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    try {
      validateContext(manualTool, context, values);
      onCommit(settingsForTool(manualTool, values, context));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "当前工具参数无法提交。"
      );
    }
  };

  return (
    <section
      className={styles.toolSettings}
      aria-label={`${TOOL_TITLES[manualTool]}设置`}
    >
      <div className={styles.toolSettingsHeader}>
        <div>
          <span>真实手工操作</span>
          <h2>{TOOL_TITLES[manualTool]}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭工具设置">
          <X aria-hidden size={16} />
        </button>
      </div>

      <form className={styles.manualToolForm} onSubmit={submit}>
        <ToolContextSummary tool={manualTool} context={context} />
        <ToolFields
          tool={manualTool}
          values={values}
          context={context}
          onChange={update}
        />

        {manualTool === "assembly" ? (
          <p className={styles.toolNotice}>
            <Info aria-hidden size={14} />
            装配约束会求解组件基准帧；贴合指组件基准原点，同轴指局部 Z
            轴。约束冲突时内核拒绝提交并保留上一版本。
          </p>
        ) : manualTool === "boolean" ? (
          <p className={styles.toolNotice}>
            <Info aria-hidden size={14} />
            第一个所选 Feature
            是目标，其余为工具体；已变换组件实例不能参与布尔。
          </p>
        ) : manualTool === "sketch" || manualTool === "slot" ? (
          <p className={styles.toolNotice}>
            <Info aria-hidden size={14} />
            图元和约束会进入同一版本化草图；只有闭合的非构造轮廓可继续拉伸或旋转。
          </p>
        ) : (
          <p className={styles.toolNotice}>
            <Info aria-hidden size={14} />
            此操作会进入待保存批次；服务器校验成功后才产生新修订。
          </p>
        )}

        {context.disabledReason ? (
          <p className={styles.toolError} role="alert">
            {context.disabledReason}
          </p>
        ) : null}
        {error ? (
          <p className={styles.toolError} role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          className={styles.primaryButton}
          disabled={!context.manualFeaturesEnabled}
        >
          <Check aria-hidden size={15} />
          加入待保存批次
        </button>
      </form>
    </section>
  );
}

function ToolContextSummary({
  tool,
  context
}: {
  tool: ManualFormTool;
  context: ManualToolContext;
}) {
  if (tool === "boolean") {
    return (
      <dl className={styles.toolContext}>
        <div>
          <dt>目标</dt>
          <dd>{context.selectedFeatures[0]?.name ?? "未选择 Feature"}</dd>
        </div>
        <div>
          <dt>工具体</dt>
          <dd>
            {context.selectedFeatures.length > 1
              ? context.selectedFeatures
                  .slice(1)
                  .map((feature) => feature.name)
                  .join("、")
              : "至少再加入一个 Feature"}
          </dd>
        </div>
      </dl>
    );
  }
  if (tool === "assembly") {
    return (
      <dl className={styles.toolContext}>
        <div>
          <dt>组件</dt>
          <dd>
            {context.selectedComponents.length
              ? context.selectedComponents
                  .map((component) => component.name)
                  .join("、")
              : "未选择 Component"}
          </dd>
        </div>
        {context.suggestedDistanceMm !== undefined ? (
          <div>
            <dt>原点距</dt>
            <dd>{context.suggestedDistanceMm.toFixed(3)} mm</dd>
          </div>
        ) : null}
      </dl>
    );
  }
  const needsTarget = [
    "cut",
    "hole",
    "fillet",
    "chamfer",
    "mirror",
    "linear-pattern",
    "circular-pattern",
    "reorder"
  ].includes(tool);
  const profileName =
    tool === "rotate" ? context.revolveProfileName : context.profileName;
  const needsProfile = ["extrude", "cut", "rotate"].includes(tool);

  if (!needsTarget && !needsProfile) return null;
  return (
    <dl className={styles.toolContext}>
      {needsTarget ? (
        <div>
          <dt>目标</dt>
          <dd>{context.selectedFeatureName ?? "未选择可编辑特征"}</dd>
        </div>
      ) : null}
      {needsProfile ? (
        <div>
          <dt>轮廓</dt>
          <dd>{profileName ?? "尚无可用闭合草图"}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function ToolFields({
  tool,
  values,
  context,
  onChange
}: {
  tool: ManualFormTool;
  values: Record<string, string>;
  context: ManualToolContext;
  onChange: (key: string, value: string) => void;
}) {
  if (tool === "boolean") {
    return (
      <SelectField
        label="布尔方式"
        value={values.operation ?? "union"}
        onChange={(value) => onChange("operation", value)}
        options={[
          { value: "union", label: "并集 · 合并实体" },
          { value: "subtract", label: "差集 · 目标减工具体" },
          { value: "intersect", label: "交集 · 保留重叠体" }
        ]}
      />
    );
  }

  if (tool === "assembly") {
    const action = values.action ?? "instance";
    const constraintKind = values.constraintKind ?? "fixed";
    return (
      <>
        <SelectField
          label="装配操作"
          value={action}
          onChange={(value) => onChange("action", value)}
          options={[
            { value: "instance", label: "创建组件实例" },
            { value: "constraint", label: "新增基准约束" }
          ]}
        />
        {action === "instance" ? (
          <>
            <TextField
              label="实例名称"
              value={values.name ?? "组件实例"}
              onChange={(value) => onChange("name", value)}
            />
            <div className={styles.transformFieldset}>
              <span>平移（mm）</span>
              {(["X", "Y", "Z"] as const).map((axis) => (
                <NumberField
                  key={`translation-${axis}`}
                  label={axis}
                  unit="mm"
                  min={undefined}
                  value={values[`translation${axis}`] ?? "0"}
                  onChange={(value) => onChange(`translation${axis}`, value)}
                />
              ))}
            </div>
            <div className={styles.transformFieldset}>
              <span>旋转（°）</span>
              {(["X", "Y", "Z"] as const).map((axis) => (
                <NumberField
                  key={`rotation-${axis}`}
                  label={axis}
                  unit="°"
                  min={undefined}
                  value={values[`rotation${axis}`] ?? "0"}
                  onChange={(value) => onChange(`rotation${axis}`, value)}
                />
              ))}
            </div>
          </>
        ) : (
          <>
            <SelectField
              label="约束类型"
              value={constraintKind}
              onChange={(value) => onChange("constraintKind", value)}
              options={[
                { value: "fixed", label: "固定当前变换" },
                { value: "coincident", label: "贴合 · 基准原点重合" },
                { value: "concentric", label: "同轴 · 局部 Z 轴共线" },
                { value: "distance", label: "距离 · 基准原点距离" },
                {
                  value: "parallel",
                  label: "平行（内核未支持）",
                  disabled: true
                },
                {
                  value: "perpendicular",
                  label: "垂直（内核未支持）",
                  disabled: true
                },
                { value: "angle", label: "角度（内核未支持）", disabled: true }
              ]}
            />
            {constraintKind === "distance" ? (
              <NumberField
                label="组件原点距离"
                unit="mm"
                value={
                  values.distance ??
                  String(Math.max(context.suggestedDistanceMm ?? 20, 0.1))
                }
                onChange={(value) => onChange("distance", value)}
              />
            ) : null}
          </>
        )}
      </>
    );
  }
  if (tool === "sketch") {
    return (
      <SketchFields values={values} context={context} onChange={onChange} />
    );
  }

  if (tool === "slot") {
    return (
      <>
        <SelectField
          label="草图平面"
          value={values.plane ?? "xy"}
          onChange={(value) => onChange("plane", value)}
          options={PLANE_OPTIONS}
        />
        <NumberField
          label="槽中心距"
          unit="mm"
          value={values.length ?? "30"}
          onChange={(value) => onChange("length", value)}
        />
        <NumberField
          label="槽宽"
          unit="mm"
          value={values.width ?? "8"}
          onChange={(value) => onChange("width", value)}
        />
      </>
    );
  }

  if (tool === "extrude" || tool === "cut") {
    return (
      <>
        <NumberField
          label={tool === "cut" ? "切除深度" : "拉伸距离"}
          unit="mm"
          value={values.distance ?? (tool === "cut" ? "12" : "20")}
          onChange={(value) => onChange("distance", value)}
        />
        <SelectField
          label="方向"
          value={values.direction ?? "normal"}
          onChange={(value) => onChange("direction", value)}
          options={[
            { value: "normal", label: "法向" },
            { value: "reverse", label: "反向" },
            { value: "symmetric", label: "对称" }
          ]}
        />
      </>
    );
  }

  if (tool === "rotate") {
    return (
      <NumberField
        label="旋转角度"
        unit="°"
        value={values.angle ?? "360"}
        onChange={(value) => onChange("angle", value)}
      />
    );
  }

  if (tool === "hole") {
    return (
      <>
        <NumberField
          label="孔直径"
          unit="mm"
          value={values.diameter ?? "8"}
          onChange={(value) => onChange("diameter", value)}
        />
        <SelectField
          label="终止方式"
          value={values.termination ?? "through_all"}
          onChange={(value) => onChange("termination", value)}
          options={[
            { value: "through_all", label: "贯穿全部" },
            { value: "blind", label: "盲孔" }
          ]}
        />
        {values.termination === "blind" ? (
          <NumberField
            label="盲孔深度"
            unit="mm"
            value={values.depth ?? "12"}
            onChange={(value) => onChange("depth", value)}
          />
        ) : null}
        <FaceSelector values={values} onChange={onChange} />
      </>
    );
  }

  if (tool === "fillet" || tool === "chamfer") {
    return (
      <>
        <NumberField
          label={tool === "fillet" ? "圆角半径" : "倒角距离"}
          unit="mm"
          value={
            values[tool === "fillet" ? "radius" : "distance"] ??
            (tool === "fillet" ? "3" : "2")
          }
          onChange={(value) =>
            onChange(tool === "fillet" ? "radius" : "distance", value)
          }
        />
        <EdgeSelector values={values} onChange={onChange} />
      </>
    );
  }

  if (tool === "mirror") {
    return (
      <SelectField
        label="镜像平面"
        value={values.plane ?? "yz"}
        onChange={(value) => onChange("plane", value)}
        options={PLANE_OPTIONS}
      />
    );
  }

  if (tool === "linear-pattern") {
    return (
      <>
        <NumberField
          label="阵列数量"
          unit="个"
          step="1"
          value={values.count ?? "3"}
          onChange={(value) => onChange("count", value)}
        />
        <NumberField
          label="阵列间距"
          unit="mm"
          value={values.spacing ?? "20"}
          onChange={(value) => onChange("spacing", value)}
        />
        <AxisSelector values={values} onChange={onChange} />
      </>
    );
  }

  if (tool === "circular-pattern") {
    return (
      <>
        <NumberField
          label="阵列数量"
          unit="个"
          step="1"
          value={values.count ?? "4"}
          onChange={(value) => onChange("count", value)}
        />
        <NumberField
          label="总角度"
          unit="°"
          value={values.totalAngle ?? "360"}
          onChange={(value) => onChange("totalAngle", value)}
        />
        <AxisSelector values={values} onChange={onChange} />
      </>
    );
  }

  return (
    <SelectField
      label="移动方向"
      value={values.direction ?? "earlier"}
      onChange={(value) => onChange("direction", value)}
      options={[
        { value: "earlier", label: "向前移动一位" },
        { value: "later", label: "向后移动一位" }
      ]}
    />
  );
}

const NEW_SKETCH_VALUE = "__new_sketch__";

type SketchConstraintUiKind =
  | "fixed"
  | "coincident"
  | "horizontal"
  | "vertical"
  | "parallel"
  | "perpendicular"
  | "tangent"
  | "equal_length"
  | "equal_radius"
  | "midpoint"
  | "symmetric"
  | "distance"
  | "angle"
  | "radius"
  | "diameter";

function SketchFields({
  values,
  context,
  onChange
}: {
  values: Record<string, string>;
  context: ManualToolContext;
  onChange: (key: string, value: string) => void;
}) {
  const action = values.action ?? "primitive";
  const targetSketchValue =
    values.targetSketch ??
    (action === "constraint"
      ? (context.sketches.at(-1)?.semanticRef ?? "")
      : NEW_SKETCH_VALUE);
  const targetSketch = context.sketches.find(
    (sketch) => sketch.semanticRef === targetSketchValue
  );
  const shape = values.shape ?? "rectangle";

  return (
    <>
      <SelectField
        label="草图操作"
        value={action}
        onChange={(value) => {
          onChange("action", value);
          onChange(
            "targetSketch",
            value === "constraint"
              ? (context.sketches.at(-1)?.semanticRef ?? "")
              : NEW_SKETCH_VALUE
          );
          for (let index = 0; index < 4; index += 1) {
            onChange(`target${index}`, "");
          }
        }}
        options={[
          { value: "primitive", label: "新增图元" },
          { value: "constraint", label: "新增约束" }
        ]}
      />
      <SelectField
        label="目标草图"
        value={targetSketchValue}
        onChange={(value) => {
          onChange("targetSketch", value);
          for (let index = 0; index < 4; index += 1) {
            onChange(`target${index}`, "");
          }
        }}
        options={[
          ...(action === "primitive"
            ? [{ value: NEW_SKETCH_VALUE, label: "新建独立草图" }]
            : []),
          ...context.sketches.map((sketch) => ({
            value: sketch.semanticRef,
            label: `${sketch.name} · ${sketch.plane.toUpperCase()}`
          })),
          ...(action === "constraint" && !context.sketches.length
            ? [
                {
                  value: "",
                  label: "请先保存一个草图",
                  disabled: true
                }
              ]
            : [])
        ]}
      />

      {action === "constraint" ? (
        <SketchConstraintFields
          values={values}
          targetSketch={targetSketch}
          onChange={onChange}
        />
      ) : (
        <>
          {!targetSketch ? (
            <SelectField
              label="草图平面"
              value={values.plane ?? "xy"}
              onChange={(value) => onChange("plane", value)}
              options={PLANE_OPTIONS}
            />
          ) : null}
          <SelectField
            label="图元类型"
            value={shape}
            onChange={(value) => onChange("shape", value)}
            options={[
              { value: "point", label: "点" },
              { value: "line", label: "直线" },
              { value: "polyline", label: "折线" },
              { value: "rectangle", label: "矩形" },
              { value: "circle", label: "圆" },
              { value: "arc", label: "圆弧" }
            ]}
          />
          <SelectField
            label="几何用途"
            value={values.construction ?? "false"}
            onChange={(value) => onChange("construction", value)}
            options={[
              { value: "false", label: "普通几何" },
              { value: "true", label: "构造几何" }
            ]}
          />
          <SketchPrimitiveGeometryFields
            shape={shape}
            values={values}
            onChange={onChange}
          />
        </>
      )}
    </>
  );
}

function SketchPrimitiveGeometryFields({
  shape,
  values,
  onChange
}: {
  shape: string;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  if (shape === "point") {
    return (
      <CoordinatePairFields
        prefix=""
        label="点坐标"
        values={values}
        defaults={["0", "0"]}
        onChange={onChange}
      />
    );
  }
  if (shape === "line") {
    return (
      <>
        <CoordinatePairFields
          prefix="start"
          label="起点"
          values={values}
          defaults={["0", "0"]}
          onChange={onChange}
        />
        <CoordinatePairFields
          prefix="end"
          label="终点"
          values={values}
          defaults={["20", "0"]}
          onChange={onChange}
        />
      </>
    );
  }
  if (shape === "polyline") {
    return (
      <>
        <TextField
          label="有序点（X,Y;X,Y）"
          value={values.polylinePoints ?? "0,0;20,0;20,15"}
          onChange={(value) => onChange("polylinePoints", value)}
        />
        <SelectField
          label="折线闭合"
          value={values.closed ?? "false"}
          onChange={(value) => onChange("closed", value)}
          options={[
            { value: "false", label: "开放" },
            { value: "true", label: "闭合" }
          ]}
        />
      </>
    );
  }
  if (shape === "circle") {
    return (
      <NumberField
        label="圆直径"
        unit="mm"
        value={values.diameter ?? "30"}
        onChange={(value) => onChange("diameter", value)}
      />
    );
  }
  if (shape === "arc") {
    return (
      <>
        <CoordinatePairFields
          prefix="center"
          label="圆心"
          values={values}
          defaults={["0", "0"]}
          onChange={onChange}
        />
        <CoordinatePairFields
          prefix="start"
          label="起点"
          values={values}
          defaults={["10", "0"]}
          onChange={onChange}
        />
        <CoordinatePairFields
          prefix="end"
          label="终点"
          values={values}
          defaults={["0", "10"]}
          onChange={onChange}
        />
        <SelectField
          label="圆弧方向"
          value={values.clockwise ?? "false"}
          onChange={(value) => onChange("clockwise", value)}
          options={[
            { value: "false", label: "逆时针" },
            { value: "true", label: "顺时针" }
          ]}
        />
      </>
    );
  }
  return (
    <>
      <NumberField
        label="矩形宽度"
        unit="mm"
        value={values.width ?? "40"}
        onChange={(value) => onChange("width", value)}
      />
      <NumberField
        label="矩形高度"
        unit="mm"
        value={values.height ?? "30"}
        onChange={(value) => onChange("height", value)}
      />
    </>
  );
}

function CoordinatePairFields({
  prefix,
  label,
  values,
  defaults,
  onChange
}: {
  prefix: "" | "center" | "start" | "end";
  label: string;
  values: Record<string, string>;
  defaults: [string, string];
  onChange: (key: string, value: string) => void;
}) {
  const key = (axis: "X" | "Y") =>
    prefix ? `${prefix}${axis}` : axis.toLowerCase();
  return (
    <div className={styles.transformFieldset}>
      <span>{label}（mm）</span>
      {(["X", "Y"] as const).map((axis, index) => (
        <NumberField
          key={`${prefix}-${axis}`}
          label={axis}
          unit="mm"
          min={undefined}
          value={values[key(axis)] ?? defaults[index]!}
          onChange={(value) => onChange(key(axis), value)}
        />
      ))}
    </div>
  );
}

function SketchConstraintFields({
  values,
  targetSketch,
  onChange
}: {
  values: Record<string, string>;
  targetSketch: ManualToolContext["sketches"][number] | undefined;
  onChange: (key: string, value: string) => void;
}) {
  const kind = (values.constraintKind ?? "fixed") as SketchConstraintUiKind;
  const distanceMode = values.distanceMode ?? "points";
  const targetSpecs = sketchConstraintTargetSpecs(kind, distanceMode);
  return (
    <>
      <SelectField
        label="约束类型"
        value={kind}
        onChange={(value) => {
          onChange("constraintKind", value);
          for (let index = 0; index < 4; index += 1) {
            onChange(`target${index}`, "");
          }
        }}
        options={SKETCH_CONSTRAINT_OPTIONS}
      />
      {kind === "distance" ? (
        <SelectField
          label="距离对象"
          value={distanceMode}
          onChange={(value) => {
            onChange("distanceMode", value);
            onChange("target0", "");
            onChange("target1", "");
          }}
          options={[
            { value: "points", label: "两点距离" },
            { value: "line", label: "直线长度" }
          ]}
        />
      ) : null}
      {targetSpecs.map((spec, index) => {
        const options = (targetSketch?.entities ?? []).filter((entity) =>
          spec.entityKinds.includes(entity.entityKind)
        );
        return (
          <SelectField
            key={`${kind}-${index}`}
            label={spec.label}
            value={values[`target${index}`] ?? ""}
            onChange={(value) => onChange(`target${index}`, value)}
            options={[
              {
                value: "",
                label: options.length ? "请选择实体" : "没有匹配实体",
                disabled: true
              },
              ...options.map((entity) => ({
                value: entity.semanticRef,
                label: entity.label
              }))
            ]}
          />
        );
      })}
      {["distance", "angle", "radius", "diameter"].includes(kind) ? (
        <NumberField
          label={constraintValueLabel(kind)}
          unit={kind === "angle" ? "°" : "mm"}
          value={values.constraintValue ?? (kind === "angle" ? "90" : "10")}
          onChange={(value) => onChange("constraintValue", value)}
        />
      ) : null}
    </>
  );
}

const SKETCH_CONSTRAINT_OPTIONS: readonly {
  value: SketchConstraintUiKind;
  label: string;
}[] = [
  { value: "fixed", label: "固定" },
  { value: "coincident", label: "重合" },
  { value: "horizontal", label: "水平" },
  { value: "vertical", label: "垂直" },
  { value: "parallel", label: "平行" },
  { value: "perpendicular", label: "垂直（两直线）" },
  { value: "tangent", label: "相切" },
  { value: "equal_length", label: "等长（两直线）" },
  { value: "equal_radius", label: "等半径（圆/圆弧）" },
  { value: "midpoint", label: "中点" },
  { value: "symmetric", label: "对称" },
  { value: "distance", label: "距离" },
  { value: "angle", label: "角度" },
  { value: "radius", label: "半径" },
  { value: "diameter", label: "直径" }
];

function sketchConstraintTargetSpecs(
  kind: SketchConstraintUiKind,
  distanceMode: string
) {
  const spec = (
    label: string,
    entityKinds: ManualToolContext["sketches"][number]["entities"][number]["entityKind"][]
  ) => ({ label, entityKinds });
  if (kind === "fixed") return [spec("固定对象", ALL_SKETCH_ENTITY_KINDS)];
  if (kind === "coincident") {
    return [spec("点 1", ["point"]), spec("点 2", ["point"])];
  }
  if (kind === "horizontal" || kind === "vertical") {
    return [spec("目标直线", ["line"])];
  }
  if (
    kind === "parallel" ||
    kind === "perpendicular" ||
    kind === "angle" ||
    kind === "equal_length"
  ) {
    return [spec("直线 1", ["line"]), spec("直线 2", ["line"])];
  }
  if (kind === "tangent") {
    return [
      spec("曲线 1", ["line", "circle", "arc"]),
      spec("曲线 2", ["line", "circle", "arc"])
    ];
  }
  if (kind === "equal_radius") {
    return [
      spec("圆/圆弧 1", ["circle", "arc"]),
      spec("圆/圆弧 2", ["circle", "arc"])
    ];
  }
  if (kind === "midpoint") {
    return [spec("目标点", ["point"]), spec("目标直线", ["line"])];
  }
  if (kind === "symmetric") {
    return [
      spec("点 1", ["point"]),
      spec("点 2", ["point"]),
      spec("对称轴", ["line"])
    ];
  }
  if (kind === "distance") {
    return distanceMode === "line"
      ? [spec("目标直线", ["line"])]
      : [spec("点 1", ["point"]), spec("点 2", ["point"])];
  }
  return [spec("目标圆/圆弧", ["circle", "arc"])];
}

const ALL_SKETCH_ENTITY_KINDS: ManualToolContext["sketches"][number]["entities"][number]["entityKind"][] =
  ["point", "line", "polyline", "rectangle", "circle", "arc", "slot"];

function constraintValueLabel(kind: SketchConstraintUiKind) {
  if (kind === "angle") return "角度";
  if (kind === "radius") return "半径";
  if (kind === "diameter") return "直径";
  return "距离";
}

function NumberField({
  label,
  value,
  unit,
  step = "0.1",
  min,
  onChange
}: {
  label: string;
  value: string;
  unit: string;
  step?: string;
  min?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.toolField}>
      <span>{label}</span>
      <span>
        <input
          type="number"
          {...(min === undefined ? {} : { min })}
          step={step}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-label={`${label}（${unit}）`}
        />
        <em>{unit}</em>
      </span>
    </label>
  );
}

function TextField({
  label,
  value,
  onChange
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.textField}>
      <span>{label}</span>
      <input
        type="text"
        value={value}
        maxLength={120}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-label={label}
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className={styles.selectField}>
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-label={label}
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function FaceSelector({
  values,
  onChange
}: {
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <SelectField
      label="放置面"
      value={values.faceSelector ?? "top"}
      onChange={(value) => onChange("faceSelector", value)}
      options={[
        { value: "top", label: "顶部面" },
        { value: "bottom", label: "底部面" },
        { value: "front", label: "前侧面" },
        { value: "back", label: "后侧面" }
      ]}
    />
  );
}

function EdgeSelector({
  values,
  onChange
}: {
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <SelectField
      label="边选择器"
      value={values.edgeSelector ?? "all"}
      onChange={(value) => onChange("edgeSelector", value)}
      options={[
        { value: "all", label: "全部边" },
        { value: "vertical", label: "竖直边" },
        { value: "top", label: "顶部边" },
        { value: "bottom", label: "底部边" },
        { value: "parallel_x", label: "平行 X 轴" },
        { value: "parallel_y", label: "平行 Y 轴" },
        { value: "parallel_z", label: "平行 Z 轴" }
      ]}
    />
  );
}

function AxisSelector({
  values,
  onChange
}: {
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <SelectField
      label="阵列轴"
      value={values.axis ?? "z"}
      onChange={(value) => onChange("axis", value)}
      options={[
        { value: "x", label: "X 轴" },
        { value: "y", label: "Y 轴" },
        { value: "z", label: "Z 轴" }
      ]}
    />
  );
}

function defaultValues(
  tool: ManualFormTool,
  context: ManualToolContext
): Record<string, string> {
  switch (tool) {
    case "sketch":
      return {
        action: "primitive",
        targetSketch: NEW_SKETCH_VALUE,
        plane: "xy",
        shape: "rectangle",
        construction: "false",
        width: "40",
        height: "30",
        diameter: "30",
        x: "0",
        y: "0",
        centerX: "0",
        centerY: "0",
        startX: "0",
        startY: "0",
        endX: "20",
        endY: "0",
        polylinePoints: "0,0;20,0;20,15",
        closed: "false",
        clockwise: "false",
        constraintKind: "fixed",
        distanceMode: "points",
        constraintValue: "10"
      };
    case "slot":
      return { plane: "xy", length: "30", width: "8" };
    case "extrude":
      return { distance: "20", direction: "normal" };
    case "cut":
      return { distance: "12", direction: "normal" };
    case "rotate":
      return { angle: "360" };
    case "hole":
      return {
        diameter: "8",
        termination: "through_all",
        depth: "12",
        faceSelector: "top"
      };
    case "fillet":
      return { radius: "3", edgeSelector: "all" };
    case "chamfer":
      return { distance: "2", edgeSelector: "all" };
    case "mirror":
      return { plane: "yz" };
    case "linear-pattern":
      return { count: "3", spacing: "20", axis: "x" };
    case "circular-pattern":
      return { count: "4", totalAngle: "360", axis: "z" };
    case "reorder":
      return { direction: "earlier" };
    case "boolean":
      return { operation: "union" };
    case "assembly": {
      const hasPair = context.selectedComponents.length === 2;
      const source = context.selectedComponents[0];
      return {
        action: hasPair ? "constraint" : "instance",
        name: source ? `${source.name} 实例` : "组件实例",
        translationX: hasPair ? "0" : "20",
        translationY: "0",
        translationZ: "0",
        rotationX: "0",
        rotationY: "0",
        rotationZ: "0",
        constraintKind:
          context.selectedComponents.length === 1 ? "fixed" : "coincident",
        distance: String(Math.max(context.suggestedDistanceMm ?? 20, 0.1))
      };
    }
  }
}

function validateContext(
  tool: ManualFormTool,
  context: ManualToolContext,
  values: Record<string, string>
) {
  if (!context.manualFeaturesEnabled) {
    throw new Error(context.disabledReason ?? "当前项目不能创建通用特征。");
  }
  if (tool === "boolean") {
    if (
      context.selectionCount !== context.selectedFeatures.length ||
      context.selectedFeatures.length < 2
    ) {
      throw new Error("请在特征树中多选至少两个 Feature，且不要混入组件实例。");
    }
    return;
  }
  if (tool === "assembly") {
    if (context.selectionCount !== context.selectedComponents.length) {
      throw new Error("装配操作只能选择 Component，不能混入 Feature。");
    }
    if ((values.action ?? "instance") === "instance") {
      if (context.selectedComponents.length !== 1) {
        throw new Error("创建组件实例必须且只能选择一个源组件。");
      }
      if (!values.name?.trim()) throw new Error("请输入实例名称。");
      return;
    }
    const kind = values.constraintKind ?? "fixed";
    const expected = kind === "fixed" ? 1 : 2;
    if (context.selectedComponents.length !== expected) {
      throw new Error(
        kind === "fixed"
          ? "固定约束必须且只能选择一个组件。"
          : "贴合、同轴或距离约束必须选择两个不同组件。"
      );
    }
    return;
  }
  if (["extrude", "cut"].includes(tool) && !context.profileName) {
    throw new Error("请先创建基础草图或开槽草图。");
  }
  if (tool === "rotate" && !context.revolveProfileName) {
    throw new Error("请先创建带构造轴的基础矩形或圆形草图。");
  }
  if (
    [
      "cut",
      "hole",
      "fillet",
      "chamfer",
      "mirror",
      "linear-pattern",
      "circular-pattern",
      "reorder"
    ].includes(tool) &&
    !context.selectedFeatureName
  ) {
    throw new Error("请先在通用零件特征树中选择目标特征。");
  }
  if (tool === "reorder") {
    const direction = values.direction ?? "earlier";
    if (direction === "earlier" && !context.canMoveEarlier) {
      throw new Error("所选特征已经位于特征树顶部。");
    }
    if (direction === "later" && !context.canMoveLater) {
      throw new Error("所选特征已经位于特征树底部。");
    }
  }
}

function settingsForTool(
  tool: ManualFormTool,
  values: Record<string, string>,
  context: ManualToolContext
): Record<string, number | string | boolean> {
  const number = (key: string, label: string) => {
    const parsed = Number(values[key]);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${label}必须是大于 0 的有效数字。`);
    }
    return parsed;
  };
  const scalar = (key: string, label: string) => {
    const parsed = Number(values[key]);
    if (!Number.isFinite(parsed)) {
      throw new Error(`${label}必须是有效数字。`);
    }
    return parsed;
  };
  switch (tool) {
    case "sketch": {
      const action = values.action ?? "primitive";
      const sketch = context.sketches.find(
        (candidate) => candidate.semanticRef === values.targetSketch
      );
      const targetSketchSettings: Record<string, number | string | boolean> =
        sketch
          ? {
              targetSketchId: sketch.id,
              targetSketchRef: sketch.semanticRef
            }
          : {};
      if (action === "constraint") {
        if (!sketch) throw new Error("请选择一个已保存草图。");
        const uiKind = (values.constraintKind ??
          "fixed") as SketchConstraintUiKind;
        const kind =
          uiKind === "equal_length" || uiKind === "equal_radius"
            ? "equal"
            : uiKind;
        const specs = sketchConstraintTargetSpecs(
          uiKind,
          values.distanceMode ?? "points"
        );
        const targetSettings: Record<string, string> = {};
        const selectedEntityIds = new Set<string>();
        specs.forEach((spec, index) => {
          const semanticRef = values[`target${index}`];
          const entity = sketch.entities.find(
            (candidate) =>
              candidate.semanticRef === semanticRef &&
              spec.entityKinds.includes(candidate.entityKind)
          );
          if (!entity) throw new Error(`请选择${spec.label}。`);
          if (selectedEntityIds.has(entity.id)) {
            throw new Error("同一约束不能重复选择同一个草图实体。");
          }
          selectedEntityIds.add(entity.id);
          targetSettings[`target${index}Id`] = entity.id;
          targetSettings[`target${index}Ref`] = entity.semanticRef;
        });
        return {
          action: "constraint",
          ...targetSketchSettings,
          constraintKind: kind,
          ...targetSettings,
          ...(["distance", "angle", "radius", "diameter"].includes(kind)
            ? { value: number("constraintValue", constraintValueLabel(uiKind)) }
            : {})
        };
      }
      return {
        action: "primitive",
        ...targetSketchSettings,
        plane: values.plane ?? "xy",
        shape: values.shape ?? "rectangle",
        construction: values.construction === "true",
        width: number("width", "矩形宽度"),
        height: number("height", "矩形高度"),
        diameter: number("diameter", "圆直径"),
        x: scalar("x", "点 X 坐标"),
        y: scalar("y", "点 Y 坐标"),
        centerX: scalar("centerX", "圆弧圆心 X"),
        centerY: scalar("centerY", "圆弧圆心 Y"),
        startX: scalar("startX", "起点 X"),
        startY: scalar("startY", "起点 Y"),
        endX: scalar("endX", "终点 X"),
        endY: scalar("endY", "终点 Y"),
        polylinePoints: values.polylinePoints ?? "0,0;20,0;20,15",
        closed: values.closed === "true",
        clockwise: values.clockwise === "true"
      };
    }
    case "slot":
      return {
        plane: values.plane ?? "xy",
        length: number("length", "槽中心距"),
        width: number("width", "槽宽")
      };
    case "extrude":
    case "cut":
      return {
        distance: number("distance", tool === "cut" ? "切除深度" : "拉伸距离"),
        direction: values.direction ?? "normal"
      };
    case "rotate":
      return { angle: number("angle", "旋转角度") };
    case "hole":
      return {
        diameter: number("diameter", "孔直径"),
        termination: values.termination ?? "through_all",
        depth: number("depth", "盲孔深度"),
        faceSelector: values.faceSelector ?? "top"
      };
    case "fillet":
      return {
        radius: number("radius", "圆角半径"),
        edgeSelector: values.edgeSelector ?? "all"
      };
    case "chamfer":
      return {
        distance: number("distance", "倒角距离"),
        edgeSelector: values.edgeSelector ?? "all"
      };
    case "mirror":
      return { plane: values.plane ?? "yz" };
    case "linear-pattern":
      return {
        count: number("count", "阵列数量"),
        spacing: number("spacing", "阵列间距"),
        axis: values.axis ?? "x"
      };
    case "circular-pattern":
      return {
        count: number("count", "阵列数量"),
        totalAngle: number("totalAngle", "阵列总角度"),
        axis: values.axis ?? "z"
      };
    case "reorder":
      return { direction: values.direction ?? "earlier" };
    case "boolean":
      return { operation: values.operation ?? "union" };
    case "assembly": {
      const scalar = (key: string, label: string) => {
        const parsed = Number(values[key]);
        if (!Number.isFinite(parsed)) {
          throw new Error(`${label}必须是有效数字。`);
        }
        return parsed;
      };
      if ((values.action ?? "instance") === "instance") {
        return {
          action: "instance",
          name: values.name?.trim() ?? "组件实例",
          translationX: scalar("translationX", "X 平移"),
          translationY: scalar("translationY", "Y 平移"),
          translationZ: scalar("translationZ", "Z 平移"),
          rotationX: scalar("rotationX", "X 旋转"),
          rotationY: scalar("rotationY", "Y 旋转"),
          rotationZ: scalar("rotationZ", "Z 旋转")
        };
      }
      return {
        action: "constraint",
        constraintKind: values.constraintKind ?? "fixed",
        distance: number("distance", "组件原点距离")
      };
    }
  }
}

const PLANE_OPTIONS = [
  { value: "xy", label: "XY 平面" },
  { value: "xz", label: "XZ 平面" },
  { value: "yz", label: "YZ 平面" }
] as const;
