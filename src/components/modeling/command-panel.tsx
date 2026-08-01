import {
  CheckCircle2,
  CircleHelp,
  Clock3,
  LoaderCircle,
  Play,
  Send,
  Sparkles,
  TerminalSquare,
  TriangleAlert,
  X
} from "lucide-react";
import { FormEvent, useState } from "react";
import type {
  AiPlanState,
  TaskRecord
} from "@/lib/modeling/client/workspace-state";
import styles from "./modeling-workspace.module.css";

export function CommandPanel({
  open,
  aiPlan,
  tasks,
  onOpenChange,
  onPrompt,
  onConfirmPlan,
  onRejectPlan,
  onCommand
}: {
  open: boolean;
  aiPlan: AiPlanState;
  tasks: TaskRecord[];
  onOpenChange: (open: boolean) => void;
  onPrompt: (prompt: string) => void;
  onConfirmPlan: () => void;
  onRejectPlan: () => void;
  onCommand: (command: string) => void;
}) {
  const [tab, setTab] = useState<"natural" | "command">("natural");
  const [prompt, setPrompt] = useState("");
  const [command, setCommand] = useState("");
  const aiBusy =
    aiPlan.status === "pending" ||
    aiPlan.status === "confirming" ||
    (aiPlan.status === "preview" && aiPlan.rejecting);

  if (!open) {
    return (
      <button
        type="button"
        className={styles.commandCollapsed}
        onClick={() => onOpenChange(true)}
      >
        <Sparkles aria-hidden size={15} />
        打开 AI 计划与任务记录
      </button>
    );
  }

  const submitPrompt = (event: FormEvent) => {
    event.preventDefault();
    const value = prompt.trim();
    if (!value || aiBusy) return;
    onPrompt(value);
  };

  const submitCommand = (event: FormEvent) => {
    event.preventDefault();
    const value = command.trim();
    if (!value) return;
    onCommand(value);
    setCommand("");
  };

  return (
    <section className={styles.commandPanel} aria-label="建模命令与任务记录">
      <div
        className={styles.commandTabs}
        role="tablist"
        aria-label="命令输入方式"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "natural"}
          className={tab === "natural" ? styles.commandTabActive : undefined}
          onClick={() => setTab("natural")}
        >
          <Sparkles aria-hidden size={13} />
          自然语言
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "command"}
          className={tab === "command" ? styles.commandTabActive : undefined}
          onClick={() => setTab("command")}
        >
          <TerminalSquare aria-hidden size={13} />
          命令行
        </button>
        <button
          type="button"
          className={styles.commandClose}
          onClick={() => onOpenChange(false)}
          aria-label="收起命令面板"
        >
          <X aria-hidden size={15} />
        </button>
      </div>

      {tab === "natural" ? (
        <div className={styles.naturalCommand}>
          <form className={styles.promptForm} onSubmit={submitPrompt}>
            <label htmlFor="modeling-ai-prompt" className="visually-hidden">
              描述希望 AI 规划的建模修改
            </label>
            <input
              id="modeling-ai-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.currentTarget.value)}
              placeholder="例如：将偏心量改为 8 mm，并检查整周干涉"
              disabled={aiBusy}
            />
            <button
              type="submit"
              disabled={!prompt.trim() || aiBusy}
              aria-label="生成 AI 建模计划"
            >
              {aiPlan.status === "pending" ? (
                <LoaderCircle aria-hidden size={16} className={styles.spin} />
              ) : (
                <Send aria-hidden size={16} />
              )}
            </button>
          </form>
          <AiPlanPreview
            state={aiPlan}
            onConfirm={onConfirmPlan}
            onReject={onRejectPlan}
          />
        </div>
      ) : (
        <form className={styles.commandLine} onSubmit={submitCommand}>
          <span aria-hidden>&gt;</span>
          <label htmlFor="modeling-command" className="visually-hidden">
            手动建模命令
          </label>
          <input
            id="modeling-command"
            value={command}
            onChange={(event) => setCommand(event.currentTarget.value)}
            placeholder="measure cavityDiameter / section on / interference"
          />
          <button type="submit" className={styles.outlineButton}>
            <Play aria-hidden size={13} />
            运行
          </button>
        </form>
      )}

      <div className={styles.taskArea}>
        <h2>任务记录</h2>
        <div className={styles.taskList}>
          {tasks.slice(0, 4).map((task) => (
            <div key={task.id} className={styles.taskRow}>
              <span className={styles.taskTime}>
                <Clock3 aria-hidden size={12} />
                {task.time}
              </span>
              <span
                className={`${styles.taskTone} ${styles[`taskTone-${task.tone}`]}`}
              >
                {task.tone === "warning" ? (
                  <TriangleAlert aria-hidden size={13} />
                ) : (
                  <CheckCircle2 aria-hidden size={13} />
                )}
              </span>
              <strong>{task.label}</strong>
              <span>{task.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function AiPlanPreview({
  state,
  onConfirm,
  onReject
}: {
  state: AiPlanState;
  onConfirm: () => void;
  onReject: () => void;
}) {
  if (state.status === "idle") {
    return (
      <div className={styles.planHint}>
        <CircleHelp aria-hidden size={13} />
        AI 只生成可审阅计划；确认前不会修改模型。
      </div>
    );
  }
  if (state.status === "pending") {
    return (
      <div className={styles.planPending} role="status">
        <LoaderCircle aria-hidden size={15} className={styles.spin} />
        <div>
          <strong>AI 计划生成中</strong>
          <span>正在分析参数、约束与当前修订，不会自动执行。</span>
        </div>
      </div>
    );
  }
  if (state.status === "needs_input") {
    return (
      <div className={styles.planNeedsInput} role="status">
        <CircleHelp aria-hidden size={15} />
        <div>
          <strong>需要补充信息</strong>
          <span>{state.question}</span>
        </div>
      </div>
    );
  }
  if (state.status === "preview") {
    return (
      <div className={styles.planPreview}>
        <div className={styles.planPreviewHeading}>
          <div>
            <strong>AI 执行计划（预览）</strong>
            <span>{state.operations.length} 个待确认操作</span>
          </div>
          <div className={styles.planActions}>
            <button
              type="button"
              className={styles.outlineButton}
              onClick={onReject}
              disabled={state.rejecting}
            >
              {state.rejecting ? (
                <LoaderCircle aria-hidden size={13} className={styles.spin} />
              ) : null}
              {state.rejecting ? "正在拒绝…" : "拒绝计划"}
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              onClick={onConfirm}
              disabled={state.rejecting}
            >
              确认并执行
            </button>
          </div>
        </div>
        {state.decisionError ? (
          <div className={styles.planDecisionError} role="alert">
            <TriangleAlert aria-hidden size={13} />
            拒绝失败：{state.decisionError}。计划仍保留，可重试。
          </div>
        ) : null}
        {state.summary ? (
          <p className={styles.planSummary}>{state.summary}</p>
        ) : null}
        <div className={styles.planEvidence}>
          <EvidenceList label="假设" items={state.assumptions} />
          <EvidenceList label="警告" items={state.warnings} tone="warning" />
          <EvidenceList label="预期检查" items={state.expectedChecks} />
          <EvidenceList
            label="内核诊断"
            items={state.diagnostics.map(
              (diagnostic) =>
                `${diagnostic.severity} · ${diagnostic.code} · ${diagnostic.message}`
            )}
            tone={
              state.diagnostics.some(
                (diagnostic) => diagnostic.severity === "error"
              )
                ? "warning"
                : undefined
            }
          />
          {state.metrics ? (
            <div>
              <strong>干跑指标</strong>
              <span>
                {Object.entries(state.metrics)
                  .map(([key, value]) => `${key}=${value}`)
                  .join("；")}
              </span>
            </div>
          ) : null}
        </div>
        <ol>
          {state.operations.length ? (
            state.operations.map((operation) => (
              <li key={operation.id}>
                <div className={styles.planOperationHeading}>
                  <span>{operation.label}</span>
                  <em>{operation.summary}</em>
                </div>
                {operation.diffs.length ? (
                  <dl className={styles.planDiffList}>
                    {operation.diffs.map((diff) => (
                      <div key={`${operation.id}:${diff.field}`}>
                        <dt>{diff.label}</dt>
                        <dd>
                          <span>{diff.before}</span>
                          <b aria-label="变更为">→</b>
                          <strong>{diff.after}</strong>
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </li>
            ))
          ) : (
            <li>
              <span>服务器计划已就绪</span>
              <em>确认后按计划哈希执行</em>
            </li>
          )}
        </ol>
      </div>
    );
  }
  if (state.status === "confirming") {
    return (
      <div className={styles.planPending} role="status">
        <LoaderCircle aria-hidden size={15} className={styles.spin} />
        <div>
          <strong>正在确认计划</strong>
          <span>服务器正在校验计划哈希与基础修订。</span>
        </div>
      </div>
    );
  }
  if (state.status === "confirmed") {
    return (
      <div className={styles.planConfirmed} role="status">
        <CheckCircle2 aria-hidden size={15} />
        {state.message}
      </div>
    );
  }
  if (state.status === "rejected") {
    return (
      <div className={styles.planRejected} role="status">
        <X aria-hidden size={15} />
        {state.message}
      </div>
    );
  }
  return (
    <div className={styles.planError} role="alert">
      <TriangleAlert aria-hidden size={15} />
      {state.message}
    </div>
  );
}

function EvidenceList({
  label,
  items,
  tone
}: {
  label: string;
  items: string[];
  tone?: "warning";
}) {
  if (!items.length) return null;
  return (
    <div
      className={tone === "warning" ? styles.planEvidenceWarning : undefined}
    >
      <strong>{label}</strong>
      <span>{items.join("；")}</span>
    </div>
  );
}
