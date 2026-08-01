import {
  CheckCircle2,
  CircleHelp,
  CloudOff,
  OctagonAlert,
  LoaderCircle,
  Menu,
  Redo2,
  Save,
  Undo2,
  UserRound
} from "lucide-react";
import Link from "next/link";
import { Brand } from "@/components/brand";
import type { SyncState } from "@/lib/modeling/client/workspace-state";
import styles from "./modeling-workspace.module.css";

const SYNC_LABEL: Record<SyncState, string> = {
  "local-draft": "本地草稿 · 尚未保存",
  dirty: "有未保存更改",
  saving: "正在保存…",
  saved: "已保存到项目",
  offline: "离线草稿 · 未持久化",
  error: "保存失败 · 旧版保留"
};

export function ModelingHeader({
  projectName,
  userName,
  sync,
  canUndo,
  canRedo,
  canSave,
  canExport,
  onUndo,
  onRedo,
  onSave,
  onExport,
  onOpenProject,
  onOpenInspector
}: {
  projectName: string;
  userName: string;
  sync: SyncState;
  canUndo: boolean;
  canRedo: boolean;
  canSave: boolean;
  canExport: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onExport: (format: "step" | "stl" | "glb") => void;
  onOpenProject: () => void;
  onOpenInspector: () => void;
}) {
  const statusIcon =
    sync === "saving" ? (
      <LoaderCircle aria-hidden size={14} className={styles.spin} />
    ) : sync === "error" ? (
      <OctagonAlert aria-hidden size={14} />
    ) : sync === "offline" ? (
      <CloudOff aria-hidden size={14} />
    ) : sync === "saved" ? (
      <CheckCircle2 aria-hidden size={14} />
    ) : (
      <Save aria-hidden size={14} />
    );

  return (
    <header className={styles.header}>
      <div className={styles.brandCluster}>
        <button
          type="button"
          className={styles.mobileIconButton}
          onClick={onOpenProject}
          aria-label="打开项目面板"
        >
          <Menu aria-hidden size={18} />
        </button>
        <Brand compact className={styles.brand} />
        <span className={styles.headerDivider} aria-hidden />
        <Link href="/chat" className={styles.expertLink}>
          真空泵专家
        </Link>
        <Link
          href="/modeling"
          className={styles.activeProductLink}
          aria-current="page"
        >
          智能建模
        </Link>
      </div>

      <div className={styles.projectHeading} title={projectName}>
        <span>{projectName}</span>
        <span className={styles.projectChevron} aria-hidden>
          ⌄
        </span>
      </div>

      <div className={styles.headerActions}>
        <span
          className={`${styles.syncStatus} ${sync === "offline" || sync === "error" ? styles.syncOffline : ""}`}
          role="status"
        >
          {statusIcon}
          <span>{SYNC_LABEL[sync]}</span>
        </span>
        <button
          type="button"
          className={styles.headerButton}
          onClick={onUndo}
          disabled={!canUndo}
          aria-label="撤销"
        >
          <Undo2 aria-hidden size={17} />
          <span>撤销</span>
        </button>
        <button
          type="button"
          className={styles.headerButton}
          onClick={onRedo}
          disabled={!canRedo}
          aria-label="重做"
        >
          <Redo2 aria-hidden size={17} />
          <span>重做</span>
        </button>
        <button
          type="button"
          className={styles.headerButton}
          onClick={onSave}
          disabled={!canSave}
          aria-label="保存项目"
        >
          <Save aria-hidden size={17} />
          <span>保存</span>
        </button>
        <select
          className={styles.exportSelect}
          aria-label="导出模型"
          defaultValue=""
          disabled={!canExport}
          title={
            canExport ? "从当前已保存修订生成制品" : "请先保存一个含实体的修订"
          }
          onChange={(event) => {
            const format = event.currentTarget.value;
            event.currentTarget.value = "";
            if (format === "step" || format === "stl" || format === "glb") {
              onExport(format);
            }
          }}
        >
          <option value="">导出…</option>
          <option value="step">STEP</option>
          <option value="stl">STL</option>
          <option value="glb">GLB</option>
        </select>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="建模帮助"
        >
          <CircleHelp aria-hidden size={18} />
        </button>
        <button
          type="button"
          className={`${styles.userButton} ${styles.desktopUser}`}
          title={userName}
          aria-label={`当前用户：${userName}`}
        >
          <UserRound aria-hidden size={16} />
          <span>{userName}</span>
        </button>
        <button
          type="button"
          className={styles.mobileIconButton}
          onClick={onOpenInspector}
          aria-label="打开参数面板"
        >
          <span aria-hidden>⌘</span>
        </button>
      </div>
    </header>
  );
}
