import { AlertTriangle, CircleAlert, Info } from "lucide-react";

import { MessagePartCards } from "@/components/chat/message-part-cards";
import { evaluateVerifiedLinkPart } from "@/lib/citation-link-policy";
import type { AnswerBlock, MessagePart } from "@/types/chat-v3";

export function AnswerBlocks({
  blocks,
  parts = [],
  onEvidenceActivate
}: {
  blocks: AnswerBlock[];
  parts?: MessagePart[];
  onEvidenceActivate?: (evidenceId: string) => void;
}) {
  const links = new Map(
    parts
      .filter((part) => part.type === "verified_link")
      .map((part) => [part.linkId, part])
  );
  const artifacts = new Map(
    parts
      .filter((part) => part.type === "artifact")
      .map((part) => [part.artifactId, part])
  );
  const referencedArtifactIds = new Set(
    blocks.flatMap((block) =>
      block.type === "artifact_reference" ? [block.artifactId] : []
    )
  );

  return (
    <div className="answer-content">
      {blocks.map((block, index) => {
        const key = `${block.type}-${index}`;
        if (block.type === "paragraph") {
          return (
            <p key={key} data-evidence={block.evidenceIds.join(" ")}>
              {block.text}
              <EvidenceButtons
                ids={block.evidenceIds}
                onActivate={onEvidenceActivate}
              />
            </p>
          );
        }
        if (block.type === "heading") {
          return block.level === 2 ? (
            <h2 key={key}>{block.text}</h2>
          ) : (
            <h3 key={key} className="mt-5 font-semibold">
              {block.text}
            </h3>
          );
        }
        if (block.type === "list") {
          const List = block.style === "ordered" ? "ol" : "ul";
          return (
            <List
              key={key}
              className={
                block.style === "ordered" ? "list-decimal" : "list-disc"
              }
            >
              {block.items.map((item, itemIndex) => (
                <li
                  key={`${key}-${itemIndex}`}
                  data-evidence={block.evidenceIds.join(" ")}
                >
                  {item}
                  <EvidenceButtons
                    ids={block.evidenceIds}
                    onActivate={onEvidenceActivate}
                  />
                </li>
              ))}
            </List>
          );
        }
        if (block.type === "table") {
          return (
            <div
              key={key}
              className="my-4 overflow-x-auto rounded-lg border border-[var(--border)]"
            >
              <table className="w-full min-w-[520px] border-collapse text-left text-sm">
                <thead className="bg-[var(--surface)]">
                  <tr>
                    {block.columns.map((column, columnIndex) => (
                      <th
                        key={`${key}-column-${columnIndex}`}
                        scope="col"
                        className="border-b border-[var(--border)] px-3 py-2 font-medium"
                      >
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`${key}-row-${rowIndex}`}>
                      {block.columns.map((_, columnIndex) => (
                        <td
                          key={`${key}-cell-${rowIndex}-${columnIndex}`}
                          className="border-b border-[var(--border)] px-3 py-2 align-top last:border-b-0"
                        >
                          {row[columnIndex] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <EvidenceButtons
                ids={block.evidenceIds}
                onActivate={onEvidenceActivate}
              />
            </div>
          );
        }
        if (block.type === "code") {
          return (
            <pre
              key={key}
              className="my-4 overflow-x-auto rounded-lg bg-[#17191b] p-4 text-sm leading-6 text-white"
            >
              <code data-language={block.language}>{block.code}</code>
            </pre>
          );
        }
        if (block.type === "callout") {
          const Icon =
            block.tone === "danger"
              ? AlertTriangle
              : block.tone === "warning"
                ? CircleAlert
                : Info;
          return (
            <aside
              key={key}
              className={`my-4 flex gap-3 rounded-lg border px-4 py-3 ${
                block.tone === "danger"
                  ? "border-[#e2b8b3] bg-[#fff7f6]"
                  : block.tone === "warning"
                    ? "border-[#ead2ac] bg-[#fffbf4]"
                    : "border-[var(--border)] bg-[var(--surface)]"
              }`}
            >
              <Icon aria-hidden className="mt-1 h-4 w-4 shrink-0" />
              <div>
                {block.title ? (
                  <p className="font-medium">{block.title}</p>
                ) : null}
                <p data-evidence={block.evidenceIds.join(" ")}>{block.body}</p>
                <EvidenceButtons
                  ids={block.evidenceIds}
                  onActivate={onEvidenceActivate}
                />
              </div>
            </aside>
          );
        }
        if (block.type === "calculation") {
          return (
            <section
              key={key}
              aria-label={`工程计算：${block.title}`}
              className="my-4 rounded-lg border border-[var(--border)] p-4"
            >
              <h3 className="font-semibold">{block.title}</h3>
              <output className="mt-2 block text-2xl font-semibold tracking-tight">
                {localizedResult(block.result)}
                {block.unit ? (
                  <span className="ml-1 text-sm font-normal text-[var(--muted)]">
                    {block.unit}
                  </span>
                ) : null}
              </output>
              {block.assumptions.length > 0 ? (
                <p className="mt-2 text-xs text-[var(--muted)]">
                  假设：{block.assumptions.join("；")}
                </p>
              ) : null}
              {block.warnings.length > 0 ? (
                <p className="mt-1 text-xs text-[var(--warning)]">
                  警告：{block.warnings.join("；")}
                </p>
              ) : null}
            </section>
          );
        }
        if (block.type === "link_reference") {
          const link = links.get(block.linkId);
          const decision = link ? evaluateVerifiedLinkPart(link) : undefined;
          return decision?.allowed ? (
            <a
              key={key}
              href={decision.href}
              target="_blank"
              rel="noopener noreferrer"
              className="my-2 inline-flex items-center rounded-lg border border-[var(--border)] px-3 py-2 text-sm underline underline-offset-4"
            >
              {block.label}
            </a>
          ) : (
            <span
              key={key}
              className="my-2 inline-flex rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--muted)]"
            >
              {block.label} · 链接未通过验证
            </span>
          );
        }
        const artifact = artifacts.get(block.artifactId);
        return artifact ? (
          <MessagePartCards key={key} parts={[artifact]} />
        ) : (
          <span
            key={key}
            className="my-2 inline-flex rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-[var(--muted)]"
          >
            {block.label} · Artifact 不可用
          </span>
        );
      })}
      <MessagePartCards
        parts={parts.filter(
          (part) =>
            part.type === "attachment" ||
            (part.type === "artifact" &&
              !referencedArtifactIds.has(part.artifactId))
        )}
      />
    </div>
  );
}

export function answerBlocksToPlainText(blocks: AnswerBlock[]) {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "paragraph":
          return block.text;
        case "heading":
          return `${"#".repeat(block.level)} ${block.text}`;
        case "list":
          return block.items
            .map((item, index) =>
              block.style === "ordered" ? `${index + 1}. ${item}` : `- ${item}`
            )
            .join("\n");
        case "table":
          return [block.columns, ...block.rows]
            .map((row) => row.join(" | "))
            .join("\n");
        case "code":
          return `\`\`\`${block.language ?? ""}\n${block.code}\n\`\`\``;
        case "callout":
          return [block.title, block.body].filter(Boolean).join("\n");
        case "calculation":
          return `${block.title}: ${block.result}${block.unit ? ` ${block.unit}` : ""}`;
        case "link_reference":
        case "artifact_reference":
          return block.label;
      }
    })
    .join("\n\n");
}

function EvidenceButtons({
  ids,
  onActivate
}: {
  ids: string[];
  onActivate?: (evidenceId: string) => void;
}) {
  if (!onActivate || ids.length === 0) return null;
  return (
    <span className="ml-1 inline-flex gap-0.5 align-baseline">
      {[...new Set(ids)].map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onActivate(id)}
          aria-label={`查看依据 ${id}`}
          className="rounded px-0.5 text-xs text-[var(--accent)] underline"
        >
          [{id}]
        </button>
      ))}
    </span>
  );
}

function localizedResult(value: string) {
  if (!/^-?\d+(?:\.\d+)?$/u.test(value.trim())) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 12 }).format(
        parsed
      )
    : value;
}
