"use client";

import { Menu } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChatComposer,
  type ComposerLink
} from "@/components/chat/chat-composer";
import { answerBlocksToPlainText } from "@/components/chat/answer-blocks";
import { ProblemReportDialog } from "@/components/chat/problem-report-dialog";
import { ConversationSidebar } from "@/components/chat/conversation-sidebar";
import { ExpertAnswer } from "@/components/chat/expert-answer";
import { MessagePartCards } from "@/components/chat/message-part-cards";
import { Brand } from "@/components/brand";
import type { LocalChatAttachment } from "@/lib/chat-attachments";
import { reconcileChatMessages } from "@/lib/chat-version-reconciliation";
import {
  consumeLegacyPendingQuestionDraft,
  consumePendingQuestionIntent,
  savePendingQuestionIntent
} from "@/lib/pending-question-draft";
import { ChatStreamProtocolError, parseChatEventStream } from "@/lib/sse";
import { replaceWindowLocation } from "@/lib/client-navigation";
import type {
  AnswerMeta,
  AnswerSectionName,
  AnswerSectionValue,
  AnswerV2,
  ChatMessage,
  ConversationSummary
} from "@/types/chat";
import type {
  AnswerV3,
  ArtifactPart,
  AttachmentPart,
  InputMessagePart,
  MessagePart,
  VerifiedLinkPart
} from "@/types/chat-v3";

const CONVERSATION_PAGE_SIZE = 20;
const CONVERSATION_SEARCH_DEBOUNCE_MS = 250;
const CONVERSATION_DATA_CLEARED_ABORT_REASON = "conversation-data-cleared";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type AgentTimelineEntry = {
  id: string;
  label: string;
  status: "running" | "completed" | "failed";
};

const EMPTY_ANSWER_V2: AnswerV2 = {
  schemaVersion: "openvac.answer.v2",
  answerKind: "general_guidance",
  conclusion: [],
  assumptions: [],
  evidence: [],
  missingInputs: [],
  nextSteps: [],
  calculationRefs: []
};

type ConversationPage = {
  items: ConversationSummary[];
  page: number;
  pageSize: number;
  total: number;
};

function conversationHistoryUrl(query: string, page: number) {
  if (!query && page === 1) return "/api/conversations";

  const params = new URLSearchParams();
  if (query) params.set("q", query);
  params.set("page", String(page));
  params.set("pageSize", String(CONVERSATION_PAGE_SIZE));
  return `${query ? "/api/conversations/search" : "/api/conversations"}?${params.toString()}`;
}

function conversationPageFromPayload(
  payload: {
    conversations?: ConversationSummary[];
    items?: ConversationSummary[];
    page?: number;
    pageSize?: number;
    total?: number;
    data?: {
      conversations?: ConversationSummary[];
      items?: ConversationSummary[];
      page?: number;
      pageSize?: number;
      total?: number;
    };
  },
  requestedPage: number
): ConversationPage {
  const data = payload.data ?? payload;
  const items = data.conversations ?? data.items ?? [];
  return {
    items,
    page: data.page ?? requestedPage,
    pageSize: data.pageSize ?? CONVERSATION_PAGE_SIZE,
    total: data.total ?? items.length
  };
}

function appendUniqueConversations(
  current: ConversationSummary[],
  incoming: ConversationSummary[]
) {
  const byId = new Map(
    current.map((conversation) => [conversation.id, conversation])
  );
  for (const conversation of incoming) byId.set(conversation.id, conversation);
  return [...byId.values()];
}

function makeLocalId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function withAnswerSection(
  answer: AnswerV2 | undefined,
  section: AnswerSectionName,
  value: AnswerSectionValue
): AnswerV2 {
  const current = answer ?? EMPTY_ANSWER_V2;
  switch (section) {
    case "conclusion":
      return { ...current, conclusion: value as AnswerV2["conclusion"] };
    case "assumptions":
      return { ...current, assumptions: value as string[] };
    case "evidence":
      return { ...current, evidence: value as AnswerV2["evidence"] };
    case "missingInputs":
      return { ...current, missingInputs: value as string[] };
    case "nextSteps":
      return { ...current, nextSteps: value as string[] };
  }
}

function renderAnswerForClipboard(answer: AnswerV2 | AnswerV3): string {
  if (answer.schemaVersion === "openvac.answer.v3") {
    return answerBlocksToPlainText(answer.blocks);
  }
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n");
  return [
    "## 结论",
    answer.conclusion.map((item) => item.text).join("\n\n"),
    "## 采用的条件/假设",
    list(answer.assumptions),
    "## 依据与来源",
    list(answer.evidence.map((item) => item.claim)),
    "## 仍缺少的信息",
    list(answer.missingInputs),
    "## 建议下一步",
    list(answer.nextSteps)
  ].join("\n\n");
}

function isAnswerV3(answer: AnswerV2 | AnswerV3): answer is AnswerV3 {
  return answer.schemaVersion === "openvac.answer.v3";
}

function composerInputParts(
  text: string,
  links: ComposerLink[],
  attachments: LocalChatAttachment[]
): InputMessagePart[] {
  return [
    ...(text ? ([{ type: "text", text }] as const) : []),
    ...links.map((link): InputMessagePart => ({
      type: "link",
      url: link.url,
      label: link.label
    })),
    ...attachments.flatMap((attachment): InputMessagePart[] =>
      attachment.status === "ready" && attachment.attachmentId
        ? [{ type: "attachment", attachmentId: attachment.attachmentId }]
        : []
    )
  ];
}

function inputPartsPlaintext(
  text: string,
  links: ComposerLink[],
  attachments: LocalChatAttachment[]
) {
  return [
    text,
    ...links.map((link) => `链接：${link.label}`),
    ...attachments
      .filter((attachment) => attachment.status === "ready")
      .map((attachment) => `附件：${attachment.filename}`)
  ]
    .filter(Boolean)
    .join("\n");
}

function optimisticMessageParts(
  text: string,
  attachments: LocalChatAttachment[]
): MessagePart[] {
  return [
    ...(text ? ([{ type: "text", text }] as const) : []),
    ...attachments.flatMap((attachment): AttachmentPart[] =>
      attachment.status === "ready" && attachment.attachmentId
        ? [
            {
              type: "attachment",
              attachmentId: attachment.attachmentId,
              kind: attachment.kind,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              status: "ready"
            }
          ]
        : []
    )
  ];
}

function userMessageText(message: ChatMessage) {
  if (!message.parts && !message.inputParts) return message.content;
  return [
    ...(message.parts ?? []).flatMap((part) =>
      part.type === "text" ? [part.text] : []
    ),
    ...(message.parts ? [] : (message.inputParts ?? [])).flatMap((part) =>
      part.type === "text" ? [part.text] : []
    )
  ].join("\n");
}

function upsertMessagePart(
  parts: MessagePart[] | undefined,
  next: AttachmentPart | ArtifactPart | VerifiedLinkPart
) {
  return [
    ...(parts ?? []).filter((part) =>
      next.type === "attachment"
        ? part.type !== "attachment" || part.attachmentId !== next.attachmentId
        : next.type === "artifact"
          ? part.type !== "artifact" || part.artifactId !== next.artifactId
          : part.type !== "verified_link" || part.linkId !== next.linkId
    ),
    next
  ];
}

function mergeAnswerParts(
  parts: MessagePart[] | undefined,
  meta: AnswerMeta | undefined
): MessagePart[] | undefined {
  const published = [
    ...(meta?.verifiedLinks ?? []),
    ...(meta?.artifacts ?? [])
  ];
  if (published.length === 0) return parts;
  return published.reduce<MessagePart[]>(
    (current, part) => upsertMessagePart(current, part),
    parts ?? []
  );
}

export function problemReportDescriptionForMessage(
  messages: ChatMessage[],
  messageId?: string
): string {
  const answerIndex = messageId
    ? messages.findIndex(
        (message) => message.id === messageId && message.role === "assistant"
      )
    : messages.length;
  const searchFrom = answerIndex >= 0 ? answerIndex - 1 : messages.length - 1;

  for (let index = searchFrom; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.content;
  }
  return "";
}

export function ChatWorkspace({
  userId,
  userName,
  userEmail
}: {
  userId: string;
  userName: string;
  userEmail: string;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationQuery, setConversationQuery] = useState("");
  const [conversationPage, setConversationPage] = useState(1);
  const [conversationTotal, setConversationTotal] = useState(0);
  const [conversationHistoryLoading, setConversationHistoryLoading] =
    useState(false);
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [composerLinks, setComposerLinks] = useState<ComposerLink[]>([]);
  const [composerAttachments, setComposerAttachments] = useState<
    LocalChatAttachment[]
  >([]);
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [stage, setStage] = useState<string>();
  const [timeline, setTimeline] = useState<AgentTimelineEntry[]>([]);
  const [mode, setMode] = useState<"auto" | "deep">("auto");
  const [webMode, setWebMode] = useState<"auto" | "always">("auto");
  const [activeRunId, setActiveRunId] = useState<string>();
  const [selectedVersionByTurn, setSelectedVersionByTurn] = useState<
    Record<string, number>
  >({});
  const [memoryDraft, setMemoryDraft] = useState<{
    messageId: string;
    text: string;
    label: string;
    kind: "equipment" | "operating_context" | "unit_preference";
  }>();
  const [error, setError] = useState<string>();
  const [resetAt, setResetAt] = useState<string>();
  const [problemReportOpen, setProblemReportOpen] = useState(false);
  const [problemReportMessageId, setProblemReportMessageId] = useState<
    string | undefined
  >();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const conversationHistoryAbortRef = useRef<AbortController | undefined>(
    undefined
  );
  const conversationHistoryRequestRef = useRef(0);
  const conversationDetailAbortRef = useRef<AbortController | undefined>(
    undefined
  );
  const conversationDetailRequestRef = useRef(0);
  const conversationCreationRef = useRef<Promise<string> | undefined>(
    undefined
  );
  const firstConversationHistoryLoadRef = useRef(true);
  const pendingQuestionHandledRef = useRef(false);
  const conversationQueryRef = useRef("");
  const endRef = useRef<HTMLDivElement>(null);

  const busy = Boolean(stage);
  const reconciliation = useMemo(
    () => reconcileChatMessages(messages, selectedVersionByTurn),
    [messages, selectedVersionByTurn]
  );
  const visibleMessages = reconciliation.visibleMessages;
  const reconciledTurns = reconciliation.turns;

  const loadConversationPage = useCallback(
    async ({
      query,
      page,
      append
    }: {
      query: string;
      page: number;
      append: boolean;
    }) => {
      const requestId = ++conversationHistoryRequestRef.current;
      conversationHistoryAbortRef.current?.abort();
      const controller = new AbortController();
      conversationHistoryAbortRef.current = controller;
      setConversationHistoryLoading(true);

      try {
        const response = await fetch(conversationHistoryUrl(query, page), {
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) return;
        const payload = (await response.json()) as Parameters<
          typeof conversationPageFromPayload
        >[0];
        if (
          controller.signal.aborted ||
          requestId !== conversationHistoryRequestRef.current
        ) {
          return;
        }

        const result = conversationPageFromPayload(payload, page);
        setConversations((current) =>
          append
            ? appendUniqueConversations(current, result.items)
            : result.items
        );
        setConversationPage(result.page);
        setConversationTotal(result.total);
      } catch (caught) {
        if (!controller.signal.aborted) {
          void caught;
        }
      } finally {
        if (requestId === conversationHistoryRequestRef.current) {
          setConversationHistoryLoading(false);
        }
      }
    },
    []
  );

  const normalizedConversationQuery = conversationQuery.trim();

  const ensureConversation = useCallback(async (): Promise<string> => {
    if (conversationId) return conversationId;
    if (conversationCreationRef.current) return conversationCreationRef.current;

    const creation = (async () => {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "新对话" })
      });
      if (!response.ok) throw new Error("暂时无法创建附件所属对话。");
      const payload = (await response.json()) as {
        id?: string;
        data?: { id?: string };
      };
      const id = payload.data?.id ?? payload.id;
      if (!id || !UUID_PATTERN.test(id)) {
        throw new Error("新对话响应不完整，请稍后重试。");
      }
      setConversationId(id);
      await loadConversationPage({ query: "", page: 1, append: false });
      return id;
    })();
    conversationCreationRef.current = creation;
    try {
      return await creation;
    } finally {
      conversationCreationRef.current = undefined;
    }
  }, [conversationId, loadConversationPage]);

  useEffect(() => {
    conversationQueryRef.current = normalizedConversationQuery;
  }, [normalizedConversationQuery]);

  useEffect(() => {
    conversationHistoryAbortRef.current?.abort();
    conversationHistoryRequestRef.current += 1;
    const delay = firstConversationHistoryLoadRef.current
      ? 0
      : CONVERSATION_SEARCH_DEBOUNCE_MS;
    firstConversationHistoryLoadRef.current = false;
    const timer = window.setTimeout(
      () =>
        void loadConversationPage({
          query: normalizedConversationQuery,
          page: 1,
          append: false
        }),
      delay
    );
    return () => window.clearTimeout(timer);
  }, [loadConversationPage, normalizedConversationQuery]);

  useEffect(
    () => () => {
      conversationHistoryAbortRef.current?.abort();
      conversationDetailAbortRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, stage]);

  const send = useCallback(
    async (
      rawQuestion: string,
      requested?: {
        mode?: "auto" | "deep";
        webMode?: "auto" | "always";
      },
      composition?: {
        links: ComposerLink[];
        attachments: LocalChatAttachment[];
      }
    ) => {
      const question = rawQuestion.trim();
      const links = composition?.links ?? [];
      const attachments = composition?.attachments ?? [];
      const parts = composerInputParts(question, links, attachments);
      if (parts.length === 0 || busy) return;
      if (question && Array.from(question).length < 2) {
        setError("请至少输入 2 个字符，以便 OpenVac 理解你的问题。");
        return;
      }
      if (
        attachments.some(
          (attachment) =>
            attachment.status !== "ready" &&
            attachment.status !== "cancelled" &&
            attachment.status !== "deleted"
        )
      ) {
        setError("所有附件就绪后才能发送。");
        return;
      }
      pendingQuestionHandledRef.current = true;
      const requestedMode = requested?.mode ?? mode;
      const requestedWebMode = requested?.webMode ?? webMode;

      const clientRequestId = crypto.randomUUID();
      const localUserId = makeLocalId("user");
      const localAssistantId = makeLocalId("assistant");
      setInput("");
      setComposerLinks([]);
      setComposerAttachments([]);
      setError(undefined);
      setResetAt(undefined);
      setStage("正在准备证据检索…");
      setTimeline([{ id: "accepted", label: "准备运行", status: "running" }]);
      setActiveRunId(undefined);
      setMessages((current) => [
        ...current,
        {
          id: localUserId,
          role: "user",
          content: inputPartsPlaintext(question, links, attachments),
          parts: optimisticMessageParts(question, attachments),
          inputParts: parts,
          status: "completed"
        },
        {
          id: localAssistantId,
          role: "assistant",
          content: "",
          status: "streaming",
          meta: {
            riskLevel: "low",
            missingInputs: [],
            webSearched: false,
            citations: []
          }
        }
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream"
          },
          body: JSON.stringify({
            protocolVersion: 3,
            conversationId,
            parts,
            clientRequestId,
            mode: requestedMode,
            webMode: requestedWebMode
          }),
          signal: controller.signal
        });

        if (response.status === 401) {
          if (!question) {
            throw new Error(
              "登录状态已失效。附件和链接不会暂存在浏览器中，请重新登录后再添加。"
            );
          }
          if (
            !savePendingQuestionIntent({
              text: question,
              ownerUserId: userId,
              mode: requestedMode,
              webMode: requestedWebMode
            })
          ) {
            throw new Error(
              "登录状态已失效，且浏览器无法暂存问题。问题仍保留在当前对话中，请复制后重新登录。"
            );
          }
          replaceWindowLocation("/sign-in?returnTo=%2Fchat");
          return;
        }
        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => null)) as {
            error?: {
              message?: string;
              resetAt?: string;
              charged?: boolean | null;
              settlement?: "released" | "pending_recovery";
            };
          } | null;
          throw Object.assign(
            new Error(payload?.error?.message ?? "回答服务暂时不可用。"),
            {
              resetAt: payload?.error?.resetAt,
              charged: payload?.error?.charged,
              settlement: payload?.error?.settlement
            }
          );
        }

        let finalMessageId = localAssistantId;
        let finalMeta: AnswerMeta | undefined;
        let completedConversationId = conversationId;
        let completionSeen = false;
        let finalStatus: ChatMessage["status"] = "completed";
        let finalAnswerV3: AnswerV3 | undefined;

        for await (const event of parseChatEventStream(response)) {
          if (event.type === "run.accepted") {
            setActiveRunId(event.runId);
            finalMessageId = event.messageId;
            completedConversationId = event.conversationId;
            setTimeline((current) => [
              ...current.map((item) =>
                item.status === "running"
                  ? { ...item, status: "completed" as const }
                  : item
              ),
              {
                id: `run-${event.sequence}`,
                label: "运行已接受",
                status: "completed"
              }
            ]);
            setMessages((current) =>
              current.map((message) =>
                message.id === localUserId
                  ? { ...message, id: event.userMessageId }
                  : message.id === localAssistantId
                    ? {
                        ...message,
                        meta: {
                          ...(message.meta ?? {
                            riskLevel: "low" as const,
                            missingInputs: [],
                            webSearched: false,
                            citations: []
                          }),
                          runId: event.runId,
                          turnId: event.turnId,
                          answerVersion: event.answerVersion
                        }
                      }
                    : message
              )
            );
          }
          if (event.type === "stage.changed") {
            setStage(event.label);
            setTimeline((current) =>
              [
                ...current.map((item) =>
                  item.status === "running"
                    ? { ...item, status: "completed" as const }
                    : item
                ),
                {
                  id: `stage-${event.sequence}`,
                  label: event.label,
                  status: "running" as const
                }
              ].slice(-20)
            );
          }
          if (
            event.type === "tool.started" ||
            event.type === "tool.completed" ||
            event.type === "tool.failed"
          ) {
            setTimeline((current) =>
              [
                ...current,
                {
                  id: `tool-${event.sequence}`,
                  label: event.label,
                  status: (event.type === "tool.started"
                    ? "running"
                    : event.type === "tool.completed"
                      ? "completed"
                      : "failed") as AgentTimelineEntry["status"]
                }
              ].slice(-20)
            );
          }
          if (event.type === "answer.section.committed") {
            setMessages((current) =>
              current.map((message) =>
                message.id === localAssistantId
                  ? {
                      ...message,
                      meta: {
                        ...(message.meta ?? {
                          riskLevel: "low" as const,
                          missingInputs: [],
                          webSearched: false,
                          citations: []
                        }),
                        answer: withAnswerSection(
                          message.meta?.answer,
                          event.section,
                          event.value
                        )
                      }
                    }
                  : message
              )
            );
          }
          if (event.type === "answer.block.committed") {
            setMessages((current) =>
              current.map((message) => {
                if (message.id !== localAssistantId) return message;
                const blocks = [...(message.meta?.answerBlocks ?? [])];
                blocks[event.index] = event.block;
                return {
                  ...message,
                  meta: {
                    ...(message.meta ?? {
                      riskLevel: "low" as const,
                      missingInputs: [],
                      webSearched: false,
                      citations: []
                    }),
                    answerBlocks: blocks.filter(Boolean)
                  }
                };
              })
            );
          }
          if (event.type === "attachment.updated") {
            setMessages((current) =>
              current.map((message) =>
                message.inputParts?.some(
                  (part) =>
                    part.type === "attachment" &&
                    part.attachmentId === event.attachment.attachmentId
                )
                  ? {
                      ...message,
                      parts: upsertMessagePart(message.parts, event.attachment)
                    }
                  : message
              )
            );
          }
          if (event.type === "artifact.updated") {
            setMessages((current) =>
              current.map((message) =>
                message.id === localAssistantId
                  ? {
                      ...message,
                      parts: upsertMessagePart(message.parts, event.artifact)
                    }
                  : message
              )
            );
          }
          if (event.type === "answer.completed") {
            finalAnswerV3 = event.answer;
            setMessages((current) =>
              current.map((message) =>
                message.id === localAssistantId
                  ? {
                      ...message,
                      meta: {
                        ...(message.meta ?? {
                          riskLevel: "low" as const,
                          missingInputs: [],
                          webSearched: false,
                          citations: []
                        }),
                        answerV3: event.answer,
                        answerBlocks: event.answer.blocks
                      }
                    }
                  : message
              )
            );
          }
          if (event.type === "citation.committed") {
            setMessages((current) =>
              current.map((message) =>
                message.id === localAssistantId
                  ? {
                      ...message,
                      meta: {
                        ...(message.meta ?? {
                          riskLevel: "low" as const,
                          missingInputs: [],
                          webSearched: false,
                          citations: []
                        }),
                        citations: [
                          ...(message.meta?.citations ?? []).filter(
                            (citation) =>
                              citation.sourceId !== event.citation.sourceId
                          ),
                          event.citation
                        ]
                      }
                    }
                  : message
              )
            );
          }
          if (event.type === "run.completed") {
            completionSeen = true;
            finalMessageId = event.messageId;
            finalMeta = isAnswerV3(event.answer)
              ? {
                  ...event.meta,
                  answerV3: event.answer,
                  answerBlocks: event.answer.blocks
                }
              : { ...event.meta, answer: event.answer };
            if (isAnswerV3(event.answer)) finalAnswerV3 = event.answer;
            completedConversationId = event.conversationId;
            finalStatus = event.meta.incomplete ? "incomplete" : "completed";
            setTimeline((current) =>
              current.map((item) =>
                item.status === "running"
                  ? { ...item, status: "completed" as const }
                  : item
              )
            );
          }
          if (event.type === "run.cancelled") {
            completionSeen = true;
            throw Object.assign(new Error(event.message), {
              charged: event.charged,
              settlement: event.settlement
            });
          }
          if (event.type === "run.failed") {
            completionSeen = true;
            throw Object.assign(new Error(event.message), {
              resetAt: event.resetAt,
              charged: event.charged,
              settlement: event.settlement
            });
          }
          if (event.type === "status") {
            setStage(event.label);
          }
          if (event.type === "delta") {
            setMessages((current) =>
              current.map((message) =>
                message.id === localAssistantId
                  ? { ...message, content: message.content + event.text }
                  : message
              )
            );
          }
          if (event.type === "citation") {
            setMessages((current) =>
              current.map((message) =>
                message.id === localAssistantId
                  ? {
                      ...message,
                      meta: {
                        ...(message.meta ?? {
                          riskLevel: "low" as const,
                          missingInputs: [],
                          webSearched: false,
                          citations: []
                        }),
                        citations: [
                          ...(message.meta?.citations ?? []).filter(
                            (citation) =>
                              citation.sourceId !== event.citation.sourceId
                          ),
                          event.citation
                        ]
                      }
                    }
                  : message
              )
            );
          }
          if (event.type === "complete") {
            if (completionSeen) {
              throw new ChatStreamProtocolError(
                "服务器重复发送了回答完成标记，请刷新对话历史。"
              );
            }
            completionSeen = true;
            finalMessageId = event.messageId;
            finalMeta = event.meta;
            completedConversationId = event.conversationId;
          }
          if (event.type === "error") {
            const streamError = Object.assign(new Error(event.message), {
              resetAt: event.resetAt
            });
            throw streamError;
          }
        }

        if (!completionSeen) {
          throw new ChatStreamProtocolError(
            "连接中断，未收到完整的回答。请刷新对话历史后重试。"
          );
        }

        setConversationId(completedConversationId);
        setMessages((current) =>
          current.map((message) =>
            message.id === localAssistantId
              ? {
                  ...message,
                  id: finalMessageId,
                  status: finalStatus,
                  content: finalMeta?.answerV3
                    ? answerBlocksToPlainText(finalMeta.answerV3.blocks)
                    : finalAnswerV3
                      ? answerBlocksToPlainText(finalAnswerV3.blocks)
                      : finalMeta?.answer && !message.content
                        ? renderAnswerForClipboard(finalMeta.answer)
                        : message.content,
                  parts: mergeAnswerParts(message.parts, finalMeta),
                  meta: finalMeta ?? message.meta
                }
              : message
          )
        );
        await loadConversationPage({
          query: conversationQueryRef.current,
          page: 1,
          append: false
        });
      } catch (caught) {
        if (
          controller.signal.aborted &&
          controller.signal.reason === CONVERSATION_DATA_CLEARED_ABORT_REASON
        ) {
          return;
        }
        const typed = caught as Error & {
          resetAt?: string;
          charged?: boolean | null;
          settlement?: "released" | "pending_recovery";
        };
        const settlementPending =
          typed.settlement === "pending_recovery" || typed.charged === null;
        if (controller.signal.aborted) {
          setError(
            "已发起取消。本次回答不会计为成功；额度结算状态正在同步，可稍后刷新确认。"
          );
        } else {
          setError(typed.message || "回答服务暂时不可用。");
          setResetAt(typed.resetAt);
        }
        setMessages((current) =>
          current.map((message) =>
            message.id === localAssistantId
              ? {
                  ...message,
                  status: "error",
                  content:
                    message.content ||
                    (settlementPending
                      ? "本次回答未完成。额度与产物清理正在自动恢复，请稍后刷新确认。"
                      : typed.charged === false ||
                          typed.settlement === "released"
                        ? "本次回答未完成。系统已归还预占额度，请稍后重试；若持续发生，可提交问题反馈。"
                        : "本次回答未完成。额度状态尚未确认，请稍后刷新；若持续发生，可提交问题反馈。")
                }
              : message
          )
        );
      } finally {
        abortRef.current = undefined;
        setActiveRunId(undefined);
        setStage(undefined);
      }
    },
    [busy, conversationId, loadConversationPage, mode, userId, webMode]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (pendingQuestionHandledRef.current) return;
      pendingQuestionHandledRef.current = true;

      const intent = consumePendingQuestionIntent({ userId });
      if (intent) {
        const intentMode = intent.mode ?? "auto";
        const intentWebMode = intent.webMode ?? "auto";
        setMode(intentMode);
        setWebMode(intentWebMode);
        void send(intent.text, {
          mode: intentMode,
          webMode: intentWebMode
        });
        return;
      }

      const legacyDraft = consumeLegacyPendingQuestionDraft({ userId });
      if (legacyDraft) setInput(legacyDraft.text);
    }, 0);

    return () => window.clearTimeout(timer);
  }, [send, userId]);

  async function selectConversation(id: string) {
    if (busy) return;
    const requestId = ++conversationDetailRequestRef.current;
    conversationDetailAbortRef.current?.abort();
    const controller = new AbortController();
    conversationDetailAbortRef.current = controller;
    setConversationId(id);
    setMessages([]);
    setComposerLinks([]);
    setComposerAttachments([]);
    setTimeline([]);
    setActiveRunId(undefined);
    setSelectedVersionByTurn({});
    setError(undefined);
    try {
      const response = await fetch(`/api/conversations/${id}`, {
        cache: "no-store",
        signal: controller.signal
      });
      if (
        controller.signal.aborted ||
        requestId !== conversationDetailRequestRef.current
      ) {
        return;
      }
      if (!response.ok) {
        setError("无法恢复这段对话。");
        return;
      }
      const payload = (await response.json()) as {
        messages?: ChatMessage[];
        conversation?: { messages?: ChatMessage[] };
        data?: { messages?: ChatMessage[] };
      };
      if (requestId !== conversationDetailRequestRef.current) return;
      setMessages(
        payload.messages ??
          payload.conversation?.messages ??
          payload.data?.messages ??
          []
      );
      const restored =
        payload.messages ??
        payload.conversation?.messages ??
        payload.data?.messages ??
        [];
      const latestAgentMeta = restored
        .toReversed()
        .find((message) => message.role === "assistant")?.meta;
      if (latestAgentMeta?.requestedMode)
        setMode(latestAgentMeta.requestedMode);
      if (latestAgentMeta?.webMode) setWebMode(latestAgentMeta.webMode);
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError("无法恢复这段对话。");
      }
      void caught;
    }
  }

  async function renameConversation(id: string, title: string) {
    const response = await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title })
    });
    if (response.ok) {
      await loadConversationPage({
        query: conversationQueryRef.current,
        page: 1,
        append: false
      });
    }
  }

  async function deleteConversation(id: string) {
    const response = await fetch(`/api/conversations/${id}`, {
      method: "DELETE"
    });
    if (response.ok) {
      if (conversationId === id) {
        conversationDetailAbortRef.current?.abort();
        conversationDetailRequestRef.current += 1;
        setConversationId(undefined);
        setMessages([]);
        setComposerLinks([]);
        setComposerAttachments([]);
      }
      await loadConversationPage({
        query: conversationQueryRef.current,
        page: 1,
        append: false
      });
    }
  }

  function clearConversationState() {
    abortRef.current?.abort(CONVERSATION_DATA_CLEARED_ABORT_REASON);
    abortRef.current = undefined;
    conversationHistoryAbortRef.current?.abort();
    conversationHistoryRequestRef.current += 1;
    conversationDetailAbortRef.current?.abort();
    conversationDetailRequestRef.current += 1;
    setConversations([]);
    setConversationQuery("");
    setConversationPage(1);
    setConversationTotal(0);
    setConversationHistoryLoading(false);
    setConversationId(undefined);
    setMessages([]);
    setComposerLinks([]);
    setComposerAttachments([]);
    setTimeline([]);
    setActiveRunId(undefined);
    setSelectedVersionByTurn({});
    setStage(undefined);
    setError(undefined);
    setResetAt(undefined);
    setProblemReportOpen(false);
    setProblemReportMessageId(undefined);
    setMemoryDraft(undefined);
  }

  const problemReportDescription = useMemo(
    () => problemReportDescriptionForMessage(messages, problemReportMessageId),
    [messages, problemReportMessageId]
  );

  async function cancelActiveRun() {
    if (!activeRunId) {
      abortRef.current?.abort();
      return;
    }
    setStage("正在停止回答…");
    try {
      const response = await fetch(`/api/chat/runs/${activeRunId}/cancel`, {
        method: "POST",
        signal: AbortSignal.timeout(2_000)
      });
      if (!response.ok && response.status !== 409)
        throw new Error("cancel failed");
    } catch {
      abortRef.current?.abort();
    }
  }

  async function runAnswerAction(
    source: ChatMessage,
    action: "retry" | "regenerate" | "continue"
  ) {
    const turnId = source.meta?.turnId;
    if (!turnId || busy) return;
    const localAssistantId = makeLocalId("assistant-version");
    const clientRequestId = crypto.randomUUID();
    let actionRunId: string | undefined;
    const provisionalVersion = (source.meta?.answerVersion ?? 1) + 1;
    setSelectedVersionByTurn((current) => ({
      ...current,
      [turnId]: provisionalVersion
    }));
    setError(undefined);
    setResetAt(undefined);
    setStage("正在创建回答版本…");
    setTimeline([{ id: "action", label: "创建回答版本", status: "running" }]);
    setMessages((current) => [
      ...current,
      {
        id: localAssistantId,
        role: "assistant",
        content: "",
        status: "streaming",
        meta: {
          riskLevel: source.meta?.riskLevel ?? "low",
          missingInputs: [],
          webSearched: false,
          citations: [],
          turnId,
          answerVersion: provisionalVersion
        }
      }
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`/api/chat/turns/${turnId}/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        body: JSON.stringify({ action, clientRequestId, mode, webMode }),
        signal: controller.signal
      });
      if (!response.ok || !response.body) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string; resetAt?: string };
        } | null;
        throw Object.assign(
          new Error(payload?.error?.message ?? "暂时无法创建回答版本。"),
          { resetAt: payload?.error?.resetAt }
        );
      }
      let completed = false;
      for await (const event of parseChatEventStream(response)) {
        if (event.type === "run.accepted") {
          actionRunId = event.runId;
          setSelectedVersionByTurn((current) => ({
            ...current,
            [event.turnId]: event.answerVersion
          }));
          setActiveRunId(event.runId);
          setMessages((current) =>
            current.map((message) =>
              message.id === localAssistantId
                ? {
                    ...message,
                    id: event.messageId,
                    meta: {
                      ...message.meta!,
                      runId: event.runId,
                      turnId: event.turnId,
                      answerVersion: event.answerVersion
                    }
                  }
                : message
            )
          );
        }
        if (event.type === "stage.changed") {
          setStage(event.label);
          setTimeline((current) =>
            [
              ...current.map((item) =>
                item.status === "running"
                  ? { ...item, status: "completed" as const }
                  : item
              ),
              {
                id: `stage-${event.sequence}`,
                label: event.label,
                status: "running" as const
              }
            ].slice(-20)
          );
        }
        if (
          event.type === "tool.started" ||
          event.type === "tool.completed" ||
          event.type === "tool.failed"
        ) {
          setTimeline((current) =>
            [
              ...current,
              {
                id: `tool-${event.sequence}`,
                label: event.label,
                status: (event.type === "tool.started"
                  ? "running"
                  : event.type === "tool.completed"
                    ? "completed"
                    : "failed") as AgentTimelineEntry["status"]
              }
            ].slice(-20)
          );
        }
        if (event.type === "answer.section.committed") {
          setMessages((current) =>
            current.map((message) =>
              message.id === localAssistantId ||
              message.meta?.runId === event.runId
                ? {
                    ...message,
                    meta: {
                      ...message.meta!,
                      answer: withAnswerSection(
                        message.meta?.answer,
                        event.section,
                        event.value
                      )
                    }
                  }
                : message
            )
          );
        }
        if (event.type === "answer.block.committed") {
          setMessages((current) =>
            current.map((message) => {
              if (
                message.id !== localAssistantId &&
                message.meta?.runId !== event.runId
              ) {
                return message;
              }
              const blocks = [...(message.meta?.answerBlocks ?? [])];
              blocks[event.index] = event.block;
              return {
                ...message,
                meta: {
                  ...message.meta!,
                  answerBlocks: blocks.filter(Boolean)
                }
              };
            })
          );
        }
        if (event.type === "attachment.updated") {
          setMessages((current) =>
            current.map((message) =>
              message.inputParts?.some(
                (part) =>
                  part.type === "attachment" &&
                  part.attachmentId === event.attachment.attachmentId
              )
                ? {
                    ...message,
                    parts: upsertMessagePart(message.parts, event.attachment)
                  }
                : message
            )
          );
        }
        if (event.type === "artifact.updated") {
          setMessages((current) =>
            current.map((message) =>
              message.id === localAssistantId ||
              message.meta?.runId === event.runId
                ? {
                    ...message,
                    parts: upsertMessagePart(message.parts, event.artifact)
                  }
                : message
            )
          );
        }
        if (event.type === "answer.completed") {
          setMessages((current) =>
            current.map((message) =>
              message.id === localAssistantId ||
              message.meta?.runId === event.runId
                ? {
                    ...message,
                    meta: {
                      ...message.meta!,
                      answerV3: event.answer,
                      answerBlocks: event.answer.blocks
                    }
                  }
                : message
            )
          );
        }
        if (event.type === "citation.committed") {
          setMessages((current) =>
            current.map((message) =>
              message.id === localAssistantId ||
              message.meta?.runId === event.runId
                ? {
                    ...message,
                    meta: {
                      ...message.meta!,
                      citations: [
                        ...(message.meta?.citations ?? []).filter(
                          (citation) =>
                            citation.sourceId !== event.citation.sourceId
                        ),
                        event.citation
                      ]
                    }
                  }
                : message
            )
          );
        }
        if (event.type === "run.completed") {
          completed = true;
          setMessages((current) =>
            current.map((message) =>
              message.meta?.runId === event.runId ||
              message.id === localAssistantId
                ? {
                    ...message,
                    id: event.messageId,
                    status: event.meta.incomplete ? "incomplete" : "completed",
                    content: isAnswerV3(event.answer)
                      ? answerBlocksToPlainText(event.answer.blocks)
                      : renderAnswerForClipboard(event.answer),
                    parts: mergeAnswerParts(message.parts, event.meta),
                    meta: isAnswerV3(event.answer)
                      ? {
                          ...event.meta,
                          answerV3: event.answer,
                          answerBlocks: event.answer.blocks
                        }
                      : { ...event.meta, answer: event.answer }
                  }
                : message
            )
          );
        }
        if (event.type === "run.failed" || event.type === "run.cancelled") {
          completed = true;
          throw new Error(event.message);
        }
      }
      if (!completed)
        throw new ChatStreamProtocolError("回答版本连接提前中断。");
      await loadConversationPage({
        query: conversationQueryRef.current,
        page: 1,
        append: false
      });
    } catch (caught) {
      const typed = caught as Error & { resetAt?: string };
      setError(typed.message || "回答版本未完成。");
      setResetAt(typed.resetAt);
      setMessages((current) =>
        current.map((message) =>
          message.id === localAssistantId ||
          (actionRunId && message.meta?.runId === actionRunId)
            ? {
                ...message,
                status: "error",
                content: message.content || "本次回答版本未完成，可重新重试。"
              }
            : message
        )
      );
    } finally {
      abortRef.current = undefined;
      setActiveRunId(undefined);
      setStage(undefined);
    }
  }

  return (
    <main className="flex h-dvh min-h-[640px] overflow-hidden bg-white">
      <ConversationSidebar
        conversations={conversations}
        activeId={conversationId}
        expanded={sidebarExpanded}
        onExpandedChange={setSidebarExpanded}
        mobileOpen={mobileSidebarOpen}
        onMobileOpenChange={setMobileSidebarOpen}
        onSelect={(id) => void selectConversation(id)}
        onNew={() => {
          conversationDetailAbortRef.current?.abort();
          conversationDetailRequestRef.current += 1;
          setConversationId(undefined);
          setMessages([]);
          setComposerLinks([]);
          setComposerAttachments([]);
          setSelectedVersionByTurn({});
          setError(undefined);
          setConversationQuery("");
          setMobileSidebarOpen(false);
        }}
        onConversationDataCleared={clearConversationState}
        onRename={(id, title) => void renameConversation(id, title)}
        onDelete={(id) => void deleteConversation(id)}
        searchQuery={conversationQuery}
        onSearchQueryChange={setConversationQuery}
        loading={conversationHistoryLoading}
        hasMore={conversations.length < conversationTotal}
        onLoadMore={() =>
          void loadConversationPage({
            query: conversationQueryRef.current,
            page: conversationPage + 1,
            append: true
          })
        }
        userName={userName}
        userEmail={userEmail}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-[var(--border)]">
          <div className="flex h-[68px] items-center px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setMobileSidebarOpen(true)}
                className="grid h-10 w-10 shrink-0 place-items-center rounded-lg transition-colors hover:bg-[var(--surface)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)] lg:hidden"
                aria-label="打开对话记录"
              >
                <Menu aria-hidden className="h-5 w-5" />
              </button>
              <Brand
                compact
                className={sidebarExpanded ? "lg:hidden" : undefined}
              />
            </div>
          </div>
        </header>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {messages.length === 0 ? (
              <div className="mx-auto flex h-full max-w-[920px] flex-col justify-center px-5 pb-12 text-center sm:pb-16">
                <h1 className="text-[clamp(2rem,4vw,3.25rem)] font-semibold tracking-[-0.055em]">
                  {"今天想解决"}
                  <span className="whitespace-nowrap">什么真空问题？</span>
                </h1>
                <p className="mx-auto mt-4 max-w-[680px] text-sm leading-7 text-[var(--muted)] sm:text-base">
                  描述泵型、工况或故障现象，OpenVac 会结合资料给出可核查的回答。
                </p>
              </div>
            ) : (
              <div className="px-5 pt-12 sm:px-8 sm:pt-14">
                {visibleMessages.map((message) =>
                  message.role === "user" ? (
                    <div
                      key={message.id}
                      className="mx-auto mb-8 flex max-w-[830px] flex-col items-end"
                    >
                      <div className="max-w-[88%] rounded-2xl bg-[var(--surface-strong)] px-5 py-3 text-sm leading-7 sm:max-w-[74%] sm:text-base">
                        {userMessageText(message) ? (
                          <p className="whitespace-pre-wrap">
                            {userMessageText(message)}
                          </p>
                        ) : null}
                        <MessagePartCards
                          parts={message.parts}
                          inputParts={message.inputParts}
                          compact
                        />
                      </div>
                      <button
                        type="button"
                        disabled={!UUID_PATTERN.test(message.id)}
                        title={
                          UUID_PATTERN.test(message.id)
                            ? "确认后保存为跨对话记忆"
                            : "等待本轮消息保存后即可记忆"
                        }
                        onClick={() =>
                          setMemoryDraft({
                            messageId: message.id,
                            text: message.content,
                            label: message.content.slice(0, 40),
                            kind: "operating_context"
                          })
                        }
                        className="mt-1.5 rounded px-1.5 py-1 text-[11px] text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ink)] disabled:cursor-wait disabled:opacity-40"
                      >
                        记住此信息
                      </button>
                      {memoryDraft?.messageId === message.id ? (
                        <div className="mt-2 w-full max-w-md rounded-xl border border-[var(--border)] bg-white p-4 text-left shadow-sm">
                          <p className="text-sm font-medium">
                            确认保存为跨对话记忆
                          </p>
                          <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
                            只有确认后才会保存；之后可在设置中编辑、停用或删除。
                          </p>
                          <div className="mt-3 grid gap-2 sm:grid-cols-[140px_1fr]">
                            <select
                              aria-label="记忆类型"
                              value={memoryDraft.kind}
                              onChange={(event) =>
                                setMemoryDraft((current) =>
                                  current
                                    ? {
                                        ...current,
                                        kind: event.target
                                          .value as typeof current.kind
                                      }
                                    : current
                                )
                              }
                              className="h-9 rounded-md border border-[var(--border)] px-2 text-sm"
                            >
                              <option value="equipment">设备资料</option>
                              <option value="operating_context">
                                常用工况
                              </option>
                              <option value="unit_preference">单位偏好</option>
                            </select>
                            <input
                              aria-label="记忆名称"
                              value={memoryDraft.label}
                              maxLength={120}
                              onChange={(event) =>
                                setMemoryDraft((current) =>
                                  current
                                    ? { ...current, label: event.target.value }
                                    : current
                                )
                              }
                              className="h-9 rounded-md border border-[var(--border)] px-3 text-sm"
                            />
                          </div>
                          <div className="mt-3 flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setMemoryDraft(undefined)}
                              className="h-8 rounded-md px-3 text-xs text-[var(--muted)]"
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              disabled={!memoryDraft.label.trim()}
                              onClick={async () => {
                                const response = await fetch(
                                  "/api/account/memories",
                                  {
                                    method: "POST",
                                    headers: {
                                      "Content-Type": "application/json"
                                    },
                                    body: JSON.stringify({
                                      kind: memoryDraft.kind,
                                      label: memoryDraft.label.trim(),
                                      facts: { note: memoryDraft.text },
                                      sourceMessageIds: [memoryDraft.messageId]
                                    })
                                  }
                                );
                                if (!response.ok) {
                                  setError("记忆保存失败，请稍后重试。");
                                  return;
                                }
                                setMemoryDraft(undefined);
                              }}
                              className="h-8 rounded-md bg-[var(--ink)] px-3 text-xs text-white disabled:opacity-40"
                            >
                              确认保存
                            </button>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <ExpertAnswer
                      key={message.id}
                      message={message}
                      stage={message.status === "streaming" ? stage : undefined}
                      timeline={
                        message.status === "streaming" ? timeline : undefined
                      }
                      onRunAction={(action) =>
                        void runAnswerAction(message, action)
                      }
                      versionOptions={
                        message.meta?.turnId
                          ? reconciledTurns.get(message.meta.turnId)
                              ?.selectableVersions
                          : []
                      }
                      historicalVersions={
                        message.meta?.turnId
                          ? reconciledTurns.get(message.meta.turnId)
                              ?.historicalVersions
                          : []
                      }
                      onVersionChange={(version) => {
                        const turnId = message.meta?.turnId;
                        if (!turnId) return;
                        setSelectedVersionByTurn((current) => ({
                          ...current,
                          [turnId]: version
                        }));
                      }}
                      onProblemReport={(messageId) => {
                        setProblemReportMessageId(messageId);
                        setProblemReportOpen(true);
                      }}
                      onFeedback={async (messageId, rating) => {
                        const reporting = rating === "report";
                        const response = await fetch(
                          `/api/messages/${messageId}/${reporting ? "report" : "feedback"}`,
                          {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(
                              reporting
                                ? {
                                    category: "other",
                                    details: "用户在对话界面主动举报该回答。"
                                  }
                                : {
                                    rating:
                                      rating === "up"
                                        ? "helpful"
                                        : "not_helpful",
                                    reason:
                                      rating === "up"
                                        ? "helpful"
                                        : "not_helpful"
                                  }
                            )
                          }
                        );
                        if (!response.ok) {
                          throw new Error("feedback failed");
                        }
                      }}
                    />
                  )
                )}
                <div ref={endRef} />
              </div>
            )}
          </div>

          <div className="shrink-0 bg-white px-4 pb-4 sm:px-7 sm:pb-5">
            <div className="mx-auto max-w-[892px]">
              {error && (
                <div
                  role="alert"
                  className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[#e2b8b3] bg-[#fff7f6] px-4 py-2.5 text-xs text-[var(--danger)]"
                >
                  <span>
                    {error}
                    {resetAt
                      ? ` 可在 ${new Date(resetAt).toLocaleString("zh-CN", {
                          timeZone: "Asia/Shanghai",
                          hour12: false
                        })} 后恢复。`
                      : ""}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setProblemReportMessageId(undefined);
                      setProblemReportOpen(true);
                    }}
                    className="font-medium underline underline-offset-4"
                  >
                    提交问题反馈
                  </button>
                </div>
              )}
              <ChatComposer
                key={conversationId ?? "new-conversation"}
                input={input}
                onInputChange={setInput}
                links={composerLinks}
                onLinksChange={setComposerLinks}
                attachments={composerAttachments}
                onAttachmentsChange={setComposerAttachments}
                conversationId={conversationId}
                onEnsureConversation={ensureConversation}
                busy={busy}
                mode={mode}
                webMode={webMode}
                onModeChange={setMode}
                onWebModeChange={setWebMode}
                onSubmit={() =>
                  void send(input, undefined, {
                    links: composerLinks,
                    attachments: composerAttachments
                  })
                }
                onCancelRun={() => void cancelActiveRun()}
                onError={setError}
              />
              <p className="mt-2 text-center text-[11px] leading-5 text-[var(--muted)]">
                AI 生成 · 专业建议仅供排查参考，涉及拆机请由合格人员操作。
              </p>
            </div>
          </div>
        </section>
      </div>

      <ProblemReportDialog
        open={problemReportOpen}
        conversationId={conversationId}
        messageId={problemReportMessageId}
        description={problemReportDescription}
        onClose={() => setProblemReportOpen(false)}
      />
    </main>
  );
}
