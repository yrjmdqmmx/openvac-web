import { Box, CheckCircle2, FilePlus2, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import type { ModelingDocumentKind } from "@/lib/modeling/client/workspace-state";
import styles from "./modeling-workspace.module.css";

export function NewProjectDialog({
  open,
  onClose,
  onCreate
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (
    name: string,
    documentKind: ModelingDocumentKind,
    material?: { name?: string; densityKgM3: number }
  ) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("通用单级旋片泵");
  const [documentKind, setDocumentKind] =
    useState<ModelingDocumentKind>("pump-template");
  const [materialName, setMaterialName] = useState("");
  const [densityKgM3, setDensityKgM3] = useState("");
  const [densityError, setDensityError] = useState<string>();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    const density = densityKgM3.trim() ? Number(densityKgM3.trim()) : undefined;
    if (density !== undefined && (!Number.isFinite(density) || density <= 0)) {
      setDensityError("材料密度必须是大于 0 的 kg/m³ 数值。");
      return;
    }
    setDensityError(undefined);
    onCreate(
      name.trim(),
      documentKind,
      density === undefined
        ? undefined
        : {
            name: materialName.trim() || undefined,
            densityKgM3: density
          }
    );
  };

  return (
    <dialog
      ref={dialogRef}
      className={styles.newProjectDialog}
      onClose={onClose}
      onCancel={onClose}
    >
      <form onSubmit={submit}>
        <div className={styles.dialogHeading}>
          <div>
            <span className={styles.dialogIcon} aria-hidden>
              <Box size={19} />
            </span>
            <div>
              <h2>新建建模项目</h2>
              <p>选择专用泵模板或通用 CAD 零件</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭新建项目对话框"
          >
            <X aria-hidden size={18} />
          </button>
        </div>
        <label className={styles.dialogField}>
          <span>项目名称</span>
          <input
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            autoFocus
          />
        </label>
        <div
          className={styles.templateChoices}
          role="radiogroup"
          aria-label="项目类型"
        >
          <button
            type="button"
            className={`${styles.templatePreview} ${documentKind === "pump-template" ? styles.templateSelected : ""}`}
            role="radio"
            aria-checked={documentKind === "pump-template"}
            onClick={() => {
              setDocumentKind("pump-template");
              if (name === "空白通用零件") setName("通用单级旋片泵");
            }}
          >
            <span className={styles.templatePump} aria-hidden>
              ◉
            </span>
            <span>
              <strong>单级旋片真空泵</strong>
              <span>专用参数化构建器 · 编辑受支持参数与本地显示状态</span>
            </span>
            {documentKind === "pump-template" ? (
              <CheckCircle2 aria-hidden size={17} />
            ) : null}
          </button>
          <button
            type="button"
            className={`${styles.templatePreview} ${documentKind === "general-part" ? styles.templateSelected : ""}`}
            role="radio"
            aria-checked={documentKind === "general-part"}
            onClick={() => {
              setDocumentKind("general-part");
              if (name === "通用单级旋片泵") setName("空白通用零件");
            }}
          >
            <span className={styles.templatePump} aria-hidden>
              <FilePlus2 size={18} />
            </span>
            <span>
              <strong>空白通用零件</strong>
              <span>可创建草图、拉伸、孔、圆角、倒角与阵列</span>
            </span>
            {documentKind === "general-part" ? (
              <CheckCircle2 aria-hidden size={17} />
            ) : null}
          </button>
        </div>
        <div className={styles.dialogField}>
          <span>材料与质量（可选）</span>
          <input
            value={materialName}
            onChange={(event) => setMaterialName(event.currentTarget.value)}
            placeholder="材料名称（例如用户指定牌号）"
            aria-label="材料名称"
          />
          <input
            type="number"
            min="0.000001"
            step="any"
            value={densityKgM3}
            onChange={(event) => {
              setDensityKgM3(event.currentTarget.value);
              setDensityError(undefined);
            }}
            placeholder="密度 kg/m³；留空则质量不可用"
            aria-label="材料密度（kg/m³）"
            aria-invalid={densityError ? true : undefined}
          />
          {densityError ? <small role="alert">{densityError}</small> : null}
        </div>
        <p className={styles.dialogNotice}>
          通用 CAD
          特征只能用于空白通用零件；旋片泵模板会显式禁用这些工具。OpenVac
          不会猜测材料密度，留空时质量指标会明确标记为不可用。
        </p>
        <div className={styles.dialogActions}>
          <button
            type="button"
            className={styles.outlineButton}
            onClick={onClose}
          >
            取消
          </button>
          <button type="submit" className={styles.primaryButton}>
            创建项目
          </button>
        </div>
      </form>
    </dialog>
  );
}
