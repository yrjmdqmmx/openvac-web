"use client";

import {
  BookOpen,
  CircleStop,
  HelpCircle,
  LoaderCircle,
  PanelLeftOpen,
  Send
} from "lucide-react";
import Link from "next/link";
import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { ProblemReportDialog } from "@/components/chat/problem-report-dialog";
import { ConversationSidebar } from "@/components/chat/conversation-sidebar";
import { ExpertAnswer } from "@/components/chat/expert-answer";
import {
  clearPendingQuestionDraft,
  loadPendingQuestionDraft,
  savePendingQuestionDraft,
  type PendingQuestionDraft
} from "@/lib/pending-question-draft";
import { ChatStreamProtocolError, parseChatEventStream } from "@/lib/sse";
import type {
  AnswerMeta,
  ChatMessage,
  ConversationSummary
} from "@/types/chat";

const CONVERSATION_PAGE_SIZE = 20;
const CONVERSATION_SEARCH_DEBOUNCE_MS = 250;

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

export function ChatWorkspace({
  userId,
  userName
}: {
  userId: string;
  userName: string;
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
  const [pendingDraft, setPendingDraft] = useState<PendingQuestionDraft | null>(
    null
  );
  const [pendingDraftText, setPendingDraftText] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [stage, setStage] = useState<string>();
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
  const firstConversationHistoryLoadRef = useRef(true);
  const conversationQueryRef = useRef("");
  const endRef = useRef<HTMLDivElement>(null);

  const busy = Boolean(stage);

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
    async (rawQuestion: string) => {
      const question = rawQuestion.trim();
      if (!question || busy) return;
      if (Array.from(question).length < 2) {
        setError("请至少输入 2 个字符，以便 OpenVac 理解你的问题。");
        return;
      }

      const clientRequestId = crypto.randomUUID();
      const localAssistantId = makeLocalId("assistant");
      setInput("");
      setError(undefined);
      setResetAt(undefined);
      setStage("正在准备证据检索…");
      setMessages((current) => [
        ...current,
        {
          id: makeLocalId("user"),
          role: "user",
          content: question,
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
            conversationId,
            message: question,
            clientRequestId
          }),
          signal: controller.signal
        });

        if (response.status === 401) {
          savePendingQuestionDraft({ text: question, ownerUserId: userId });
          window.location.assign("/sign-in?returnTo=%2Fchat");
          return;
        }
        if (!response.ok || !response.body) {
          const payload = (await response.json().catch(() => null)) as {
            error?: { message?: string; resetAt?: string };
          } | null;
          throw Object.assign(
            new Error(payload?.error?.message ?? "回答服务暂时不可用。"),
            { resetAt: payload?.error?.resetAt }
          );
        }

        let finalMessageId = localAssistantId;
        let finalMeta: AnswerMeta | undefined;
        let completedConversationId = conversationId;
        let completionSeen = false;

        for await (const event of parseChatEventStream(response)) {
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
                  status: "completed",
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
        if (controller.signal.aborted) {
          setError("已取消本次回答；未完成的回答不会扣除额度。");
        } else {
          const typed = caught as Error & { resetAt?: string };
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
                    "本次回答未完成。系统已归还预占额度，请稍后重试；若持续发生，可提交问题反馈。"
                }
              : message
          )
        );
      } finally {
        abortRef.current = undefined;
        setStage(undefined);
      }
    },
    [busy, conversationId, loadConversationPage, userId]
  );

  useEffect(() => {
    let expiryTimer: number | undefined;
    const loadTimer = window.setTimeout(() => {
      const draft = loadPendingQuestionDraft({ userId });
      if (!draft) {
        setPendingDraft(null);
        setPendingDraftText("");
        return;
      }

      setPendingDraft(draft);
      setPendingDraftText(draft.text);
      expiryTimer = window.setTimeout(
        () => {
          clearPendingQuestionDraft();
          setPendingDraft(null);
          setPendingDraftText("");
        },
        Math.max(0, draft.expiresAt - Date.now())
      );
    }, 0);

    return () => {
      window.clearTimeout(loadTimer);
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
    };
  }, [userId]);

  function discardPendingDraft() {
    clearPendingQuestionDraft();
    setPendingDraft(null);
    setPendingDraftText("");
  }

  function confirmPendingDraft() {
    const question = pendingDraftText.trim();
    if (!question || busy) return;

    clearPendingQuestionDraft();
    setPendingDraft(null);
    setPendingDraftText("");
    void send(question);
  }

  async function selectConversation(id: string) {
    if (busy) return;
    const requestId = ++conversationDetailRequestRef.current;
    conversationDetailAbortRef.current?.abort();
    const controller = new AbortController();
    conversationDetailAbortRef.current = controller;
    setConversationId(id);
    setMessages([]);
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
      }
      await loadConversationPage({
        query: conversationQueryRef.current,
        page: 1,
        append: false
      });
    }
  }

  const latestProblem = useMemo(
    () =>
      [...messages].reverse().find((message) => message.role === "user")
        ?.content ?? "",
    [messages]
  );
  return (
    <main className="flex h-dvh min-h-[640px] overflow-hidden bg-white">
      <ConversationSidebar
        conversations={conversations}
        activeId={conversationId}
        open={sidebarOpen}
        onOpenChange={setSidebarOpen}
        onSelect={(id) => void selectConversation(id)}
        onNew={() => {
          conversationDetailAbortRef.current?.abort();
          conversationDetailRequestRef.current += 1;
          setConversationId(undefined);
          setMessages([]);
          setError(undefined);
          setConversationQuery("");
          setSidebarOpen(false);
        }}
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
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-20 shrink-0 items-center justify-between border-b border-[var(--border)] px-5 pl-16 lg:px-7">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="hidden h-9 w-9 place-items-center rounded-full hover:bg-[var(--surface)] lg:grid"
              aria-label="打开历史对话"
            >
              <PanelLeftOpen className="h-5 w-5" />
            </button>
            <h1 className="text-sm font-medium sm:text-base">真空泵专家</h1>
          </div>
          <nav className="flex items-center gap-4 text-sm">
            <Link
              href="/sources"
              className="hidden items-center gap-2 text-[var(--muted)] hover:text-[var(--ink)] sm:flex"
            >
              <BookOpen className="h-4 w-4" />
              知识来源
            </Link>
            <Link
              href="/help"
              aria-label="帮助"
              className="grid h-9 w-9 place-items-center rounded-full hover:bg-[var(--surface)]"
            >
              <HelpCircle className="h-5 w-5" />
            </Link>
          </nav>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="mx-auto flex h-full max-w-[760px] flex-col justify-center px-5 pb-20">
              <p className="text-sm font-medium text-[var(--accent)]">
                OpenVac 真空泵专家
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-[-0.04em] sm:text-4xl">
                今天要解决什么问题？
              </h2>
              <p className="mt-4 max-w-xl text-sm leading-7 text-[var(--muted)]">
                请尽量提供泵型、介质、入口压力、目标压力、抽速、温度和故障现象。证据不足时，我会先追问。
              </p>
            </div>
          ) : (
            <div className="px-5 pt-8 sm:px-8">
              {messages.map((message) =>
                message.role === "user" ? (
                  <div
                    key={message.id}
                    className="mx-auto mb-10 flex max-w-[760px] justify-end"
                  >
                    <p className="max-w-[85%] rounded-2xl bg-[var(--surface)] px-5 py-3 text-sm leading-7 sm:text-base">
                      {message.content}
                    </p>
                  </div>
                ) : (
                  <ExpertAnswer
                    key={message.id}
                    message={message}
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
                                    rating === "up" ? "helpful" : "not_helpful",
                                  reason:
                                    rating === "up" ? "helpful" : "not_helpful"
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
          <div className="mx-auto max-w-[1080px]">
            {stage && (
              <div
                role="status"
                className="mb-2 flex items-center gap-2 px-2 text-xs text-[var(--muted)]"
              >
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                {stage}
              </div>
            )}
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
            {pendingDraft && (
              <section
                aria-labelledby="pending-draft-title"
                className="mb-3 rounded-[14px] border border-[#add5d1] bg-[var(--accent-soft)] p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2
                      id="pending-draft-title"
                      className="text-sm font-semibold text-[#0b5d57]"
                    >
                      有一条待发送草稿
                    </h2>
                    <p className="mt-1 text-xs leading-5 text-[var(--muted)]">
                      请确认或编辑后再发送，系统不会自动发送。
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={discardPendingDraft}
                    className="text-xs text-[var(--muted)] underline underline-offset-4"
                  >
                    丢弃草稿
                  </button>
                </div>
                <label
                  htmlFor="pending-question-draft"
                  className="visually-hidden"
                >
                  待发送草稿
                </label>
                <textarea
                  id="pending-question-draft"
                  rows={2}
                  maxLength={4000}
                  value={pendingDraftText}
                  onChange={(event) => setPendingDraftText(event.target.value)}
                  className="mt-3 max-h-36 min-h-20 w-full resize-y rounded-lg border border-[#add5d1] bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-[var(--ink)]"
                />
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    disabled={!pendingDraftText.trim() || busy}
                    onClick={confirmPendingDraft}
                    className="h-9 rounded-lg bg-[var(--ink)] px-4 text-sm font-medium text-white disabled:opacity-40"
                  >
                    确认发送
                  </button>
                </div>
              </section>
            )}
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void send(input);
              }}
              className="flex min-h-[74px] items-end gap-3 rounded-[14px] border border-[var(--border-strong)] bg-white p-3 pl-5 shadow-[0_4px_20px_rgba(17,19,21,0.04)] focus-within:border-[var(--ink)]"
            >
              <label htmlFor="chat-input" className="visually-hidden">
                继续提问
              </label>
              <textarea
                id="chat-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send(input);
                  }
                }}
                rows={2}
                maxLength={4000}
                placeholder="继续描述工况、型号或故障现象……"
                className="max-h-40 min-h-11 min-w-0 flex-1 resize-none border-0 bg-transparent py-2 text-sm leading-6 outline-none sm:text-base"
              />
              {busy ? (
                <button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--ink)] text-white"
                  aria-label="取消回答"
                >
                  <CircleStop className="h-5 w-5" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={Array.from(input.trim()).length < 2}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[var(--ink)] text-white disabled:opacity-30"
                  aria-label="发送"
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </form>
            <p className="mt-2 text-center text-[11px] leading-5 text-[var(--muted)]">
              AI 生成 · 专业建议仅供排查参考，涉及拆机请由合格人员操作。
            </p>
          </div>
        </div>
      </section>

      <ProblemReportDialog
        open={problemReportOpen}
        conversationId={conversationId}
        messageId={problemReportMessageId}
        description={latestProblem}
        onClose={() => setProblemReportOpen(false)}
      />
    </main>
  );
}
