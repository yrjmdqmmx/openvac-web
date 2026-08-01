import {
  ArrowUpDown,
  Blocks,
  Box,
  CircleDot,
  Combine,
  Copy,
  Grid3X3,
  MousePointer2,
  Orbit,
  PenTool,
  RotateCw,
  Ruler,
  ScanLine,
  Scissors,
  Search,
  Square,
  Waves
} from "lucide-react";
import type { ModelingTool } from "@/lib/modeling/client/workspace-state";
import styles from "./modeling-workspace.module.css";

type ToolbarItem = {
  id: ModelingTool;
  label: string;
  icon: React.ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  availability: "always" | "general" | "pump" | "unavailable";
  unavailableReason?: string;
};

const TOOLS: ToolbarItem[] = [
  { id: "select", label: "选择", icon: MousePointer2, availability: "always" },
  { id: "sketch", label: "草图", icon: PenTool, availability: "general" },
  { id: "extrude", label: "拉伸", icon: Box, availability: "general" },
  { id: "cut", label: "切除", icon: Scissors, availability: "general" },
  { id: "rotate", label: "旋转", icon: RotateCw, availability: "general" },
  { id: "slot", label: "开槽", icon: Orbit, availability: "general" },
  { id: "hole", label: "孔", icon: CircleDot, availability: "general" },
  { id: "fillet", label: "圆角", icon: Waves, availability: "general" },
  { id: "chamfer", label: "倒角", icon: Square, availability: "general" },
  { id: "mirror", label: "镜像", icon: Copy, availability: "general" },
  {
    id: "linear-pattern",
    label: "线阵",
    icon: Grid3X3,
    availability: "general"
  },
  {
    id: "circular-pattern",
    label: "环阵",
    icon: Orbit,
    availability: "general"
  },
  {
    id: "reorder",
    label: "重排",
    icon: ArrowUpDown,
    availability: "general"
  },
  {
    id: "boolean",
    label: "布尔",
    icon: Combine,
    availability: "general"
  },
  { id: "measure", label: "测量", icon: Ruler, availability: "always" },
  { id: "section", label: "剖切", icon: ScanLine, availability: "always" },
  {
    id: "interference",
    label: "干涉检查",
    icon: Search,
    availability: "always"
  },
  {
    id: "assembly",
    label: "装配",
    icon: Blocks,
    availability: "general"
  }
];

export function ModelingToolbar({
  activeTool,
  manualFeaturesEnabled,
  onActivate
}: {
  activeTool: ModelingTool;
  manualFeaturesEnabled: boolean;
  onActivate: (tool: ModelingTool) => void;
}) {
  return (
    <div
      className={styles.modelingToolbar}
      role="toolbar"
      aria-label="建模工具"
    >
      {TOOLS.map((tool) => {
        const Icon = tool.icon;
        const disabled = !toolAvailable(tool, manualFeaturesEnabled);
        const reason = unavailableReason(tool, manualFeaturesEnabled);
        return (
          <button
            key={tool.id}
            type="button"
            className={activeTool === tool.id ? styles.toolActive : undefined}
            onClick={() => {
              if (!disabled) onActivate(tool.id);
            }}
            aria-pressed={activeTool === tool.id}
            aria-label={disabled ? `${tool.label}（未开放）` : tool.label}
            title={reason ?? tool.label}
            disabled={disabled}
          >
            <Icon aria-hidden size={17} />
            <span>{tool.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function toolAvailable(tool: ToolbarItem, generalPart: boolean) {
  if (tool.availability === "always") return true;
  if (tool.availability === "general") return generalPart;
  if (tool.availability === "pump") return !generalPart;
  return false;
}

function unavailableReason(tool: ToolbarItem, generalPart: boolean) {
  if (tool.availability === "unavailable") return tool.unavailableReason;
  if (tool.availability === "general" && !generalPart) {
    return "旋片泵模板由专用参数化内核构建；请新建空白通用零件后使用此工具。";
  }
  if (tool.availability === "pump" && generalPart) return undefined;
}
