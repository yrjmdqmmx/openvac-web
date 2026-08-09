type ContractAttachment = {
  filename: string;
  kind: "document" | "image";
  status: "processing" | "ready" | "failed" | "deleted";
};

type ContractLink = {
  label: string;
  url: string;
  status: "verified" | "unavailable";
};

type ContractArtifact = {
  id: string;
  title: string;
  format: "md" | "docx" | "pdf" | "csv";
  status: "ready" | "failed" | "deleted";
};

type ContractVersion = {
  id: string;
  status: "completed" | "failed" | "cancelled" | "incomplete";
  text: string;
};

export type AgentV3BrowserContractState = {
  attachments?: ContractAttachment[];
  links?: ContractLink[];
  table?: { columns: string[]; rows: string[][] };
  artifact?: ContractArtifact;
  quota?: { usedBytes: number; limitBytes: number; blocked: boolean };
  legacyContent?: string;
  versions?: ContractVersion[];
};

const attachmentStatus = {
  processing: "处理中",
  ready: "可用",
  failed: "处理失败",
  deleted: "已删除"
} as const;

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function renderAgentV3BrowserContract(
  state: AgentV3BrowserContractState
): string {
  const attachments = (state.attachments ?? [])
    .map((attachment, index) => renderAttachment(attachment, index))
    .join("");
  const links = (state.links ?? []).map(renderLink).join("");
  const table = state.table ? renderTable(state.table) : "";
  const artifact = state.artifact ? renderArtifact(state.artifact) : "";
  const quota = state.quota ? renderQuota(state.quota) : "";
  const legacy = state.legacyContent
    ? `<section aria-label="旧历史"><p data-testid="legacy-projection">${escapeHtml(state.legacyContent)}</p></section>`
    : "";
  const versions = state.versions ? renderVersions(state.versions) : "";

  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Agent V3 browser contract mock</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:24px;color:#172033}section{margin:16px 0;padding:12px;border:1px solid #cbd5e1;border-radius:8px}.row{display:flex;gap:8px;align-items:center}.status{color:#475569}table{border-collapse:collapse;width:100%}th,td{border:1px solid #94a3b8;padding:6px;text-align:left}.error{color:#b91c1c}a{color:#075985}img{width:72px;height:72px;object-fit:contain;border:1px solid #cbd5e1}</style></head>
<body><main><h1>Agent V3 浏览器契约 Mock</h1>
<section aria-label="上传契约"><p>每条消息最多 5 个附件；每个附件最大 25 MiB。</p><div data-testid="attachments">${attachments}</div></section>
${links}${table}${artifact}${quota}${legacy}${versions}
</main>
<script>document.querySelectorAll('[data-advance-upload]').forEach(function(button){button.addEventListener('click',function(){var status=document.querySelector('[data-upload-status="'+button.getAttribute('data-advance-upload')+'"]');if(status){status.textContent='可用';status.setAttribute('data-status','ready');button.remove();}});});</script>
</body></html>`;
}

function renderAttachment(
  attachment: ContractAttachment,
  index: number
): string {
  if (attachment.status === "deleted") {
    return `<div class="row" data-testid="attachment-${index}"><span>附件已删除</span><span class="status">已删除</span></div>`;
  }
  const preview =
    attachment.kind === "image" && attachment.status === "ready"
      ? `<img src="${ONE_PIXEL_PNG}" alt="${escapeAttribute(attachment.filename)} 的私有图片预览">`
      : "";
  const advance =
    attachment.status === "processing"
      ? `<button type="button" data-advance-upload="${index}">完成上传处理</button>`
      : "";
  return `<div class="row" data-testid="attachment-${index}">${preview}<span>${escapeHtml(attachment.filename)}</span><span class="status" data-upload-status="${index}" data-status="${attachment.status}">${attachmentStatus[attachment.status]}</span>${advance}</div>`;
}

function renderLink(link: ContractLink): string {
  const safe = safeVerifiedHttpsUrl(link.url, link.status);
  const value = safe
    ? `<a href="${escapeAttribute(safe)}" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`
    : `<span>${escapeHtml(link.label)}（链接不可用）</span>`;
  return `<section aria-label="已验证链接">${value}</section>`;
}

function renderTable(table: { columns: string[]; rows: string[][] }): string {
  const header = table.columns
    .map((column) => `<th scope="col">${escapeHtml(column)}</th>`)
    .join("");
  const rows = table.rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`
    )
    .join("");
  return `<section aria-label="答案表格"><table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

function renderArtifact(artifact: ContractArtifact): string {
  if (artifact.status !== "ready") {
    const label = artifact.status === "deleted" ? "产物已删除" : "产物生成失败";
    return `<section aria-label="工程产物"><span class="error">${label}</span></section>`;
  }
  const path = `/api/artifacts/${encodeURIComponent(artifact.id)}/${artifact.format}`;
  return `<section aria-label="工程产物"><a href="${path}" download>${escapeHtml(artifact.title)}（${artifact.format.toUpperCase()}）</a></section>`;
}

function renderQuota(quota: {
  usedBytes: number;
  limitBytes: number;
  blocked: boolean;
}): string {
  const message = quota.blocked
    ? "存储配额已用尽，无法继续上传或生成产物。"
    : `已使用 ${quota.usedBytes} / ${quota.limitBytes} 字节`;
  return `<section aria-label="存储配额" ${quota.blocked ? 'role="alert"' : ""}><span class="${quota.blocked ? "error" : "status"}">${message}</span></section>`;
}

function renderVersions(versions: ContractVersion[]): string {
  const completed = versions.filter(
    (version) => version.status === "completed"
  );
  const selected = completed.at(-1);
  const failedCount = versions.length - completed.length;
  return `<section aria-label="答案版本"><p data-testid="terminal-version">${selected ? escapeHtml(selected.text) : "暂无可用答案"}</p>${failedCount > 0 ? `<p class="status">${failedCount} 个失败或未完成版本不可复制、评价或选中。</p>` : ""}<button type="button" ${selected ? "" : "disabled"}>复制当前成功版本</button></section>`;
}

function safeVerifiedHttpsUrl(
  value: string,
  status: ContractLink["status"]
): string | null {
  if (status !== "verified") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
