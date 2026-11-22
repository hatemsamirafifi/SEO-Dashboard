import { useAgent } from "agents/react";
// Think speaks the same chat protocol as @cloudflare/ai-chat, but its hook
// variant skips the client->server transcript sync Think doesn't support.
import { useAgentChat } from "@cloudflare/think/react";
import { Radio } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ChatComposer } from "@/client/features/onboarding/OnboardingChatParts";
import { invalidateSamSessions } from "@/client/features/sam/samQueries";
import { SamDebugTracePanel } from "@/client/features/sam/SamDebugTrace";
import { parseTraceFrame } from "@/client/features/sam/samTraceFormat";
import type { TextDirection } from "@/client/components/chat/bidiText";
import type { SamReplyLanguage } from "@/shared/samReplyLanguage";
import type { SamTraceFrame } from "@/shared/samToolTraceTypes";
import {
  ChatMessage,
  type ResolveToolLabel,
} from "@/client/components/chat/ChatMessage";
import { safeSamErrorMessage } from "@/client/features/sam/samErrorFallbacks";

import {
  samToolLabel,
  SUGGESTIONS,
  WORKFLOW_PRESETS,
} from "@/client/features/sam/samConversationPresets";

const resolveSamToolLabel: ResolveToolLabel = (partType) =>
  samToolLabel(partType);

export function SamConversation({
  projectId,
  sessionId,
  direction,
  replyLanguage,
}: {
  projectId: string;
  sessionId: string;
  direction: TextDirection;
  replyLanguage: SamReplyLanguage;
}) {
  // The conversation lives in the SamChatAgent Durable Object, keyed by the
  // session id. The WebSocket is authorized in the Worker (src/server.ts) before
  // it reaches the DO; billing gates come back as normal assistant messages.
  const agent = useAgent({ agent: "sam-chat", name: sessionId });
  // Multi-tool turns stream hundreds of WS chunks per assistant message (and a
  // single tool part can carry hundreds of KB). Each chunk replaces the whole
  // message in chat state, so an unthrottled store re-renders the chat tree
  // per chunk — faster than the main thread can commit, which React 19 aborts
  // as "Maximum update depth exceeded". 100ms coalesces chunk bursts to ≤10
  // renders/s; the final message still renders in full when the stream settles.
  const {
    messages,
    sendMessage,
    setMessages,
    clearHistory,
    status,
    error,
    isStreaming,
    stop,
  } = useAgentChat({
    agent,
    body: { samReplyLanguage: replyLanguage },
    experimental_throttle: 100,
  });

  const isBusy =
    status === "submitted" || status === "streaming" || Boolean(isStreaming);
  const [stopped, setStopped] = useState(false);
  const sendText = (text: string) => {
    setStopped(false);
    void sendMessage({ text });
  };
  const stopTurn = () => {
    setStopped(true);
    void stop();
  };
  const latestUserText = messages
    .findLast((message) => message.role === "user")
    ?.parts.find((part) => part.type === "text")?.text;
  const arabicFeedback =
    replyLanguage === "ar" ||
    (replyLanguage === "auto" &&
      /\p{Script=Arabic}/u.test(latestUserText ?? ""));

  // Debug Trace (Phase DT): conversation-scoped trace frame. Always tracks
  // `sam_trace` WebSocket frames in a ref, but only dispatches React state
  // updates when the trace panel is actually open (throttled to 200ms) to prevent
  // trace broadcasts from competing with message streaming and causing React
  // nested update depth loops.
  const [traceFrame, setTraceFrame] = useState<SamTraceFrame | null>(null);
  const [tracePanelOpen, setTracePanelOpen] = useState(false);
  const traceFrameRef = useRef<SamTraceFrame | null>(null);
  const tracePanelOpenRef = useRef(tracePanelOpen);
  tracePanelOpenRef.current = tracePanelOpen;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingFrame: SamTraceFrame | null = null;

    const flushThrottled = () => {
      timer = null;
      if (pendingFrame && tracePanelOpenRef.current) {
        setTraceFrame(pendingFrame);
        pendingFrame = null;
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        const parsed = parseTraceFrame(event.data);
        if (parsed) {
          traceFrameRef.current = parsed;
          if (tracePanelOpenRef.current) {
            pendingFrame = parsed;
            if (!timer) {
              setTraceFrame(parsed);
              timer = setTimeout(flushThrottled, 200);
            }
          }
        }
      }
    };
    agent.addEventListener("message", onMessage);
    return () => {
      agent.removeEventListener("message", onMessage);
      if (timer) clearTimeout(timer);
    };
  }, [agent]);

  useEffect(() => {
    let active = true;
    fetch(`/agents/sam-chat/${sessionId}/trace`)
      .then(async (res) => {
        if (!res.ok) return null;
        const raw = await res.text();
        return parseTraceFrame(raw);
      })
      .then((data) => {
        if (active && data) {
          const prev = traceFrameRef.current;
          const next =
            !prev || (data.turnId && prev.turnId === data.turnId) ? data : prev;
          traceFrameRef.current = next;
          if (tracePanelOpenRef.current) {
            setTraceFrame(next);
          }
        }
      })
      .catch(() => {
        // Best-effort trace hydration
      });

    const requestSnapshot = () => {
      try {
        agent.send(JSON.stringify({ type: "sam_trace_request" }));
      } catch {
        // Socket may not be open yet
      }
    };
    agent.addEventListener("open", requestSnapshot);
    requestSnapshot();

    return () => {
      active = false;
      agent.removeEventListener("open", requestSnapshot);
    };
  }, [agent, sessionId]);

  // Rewind the server-side conversation to before `messageId`: the DO aborts
  // any in-flight turn, then deletes the message and everything after it. Sync
  // the local view from the server afterwards rather than slicing locally —
  // an aborted turn may have persisted (or removed) more than we can see, and
  // on Think setMessages is local-only, so this is a pure view update.
  const rewindTo = async (messageId: string) => {
    const response = await fetch(`/agents/sam-chat/${sessionId}/rewind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId }),
    });
    if (!response.ok) return false;
    const fresh = await fetch(
      `/agents/sam-chat/${sessionId}/get-messages`,
    ).then((res) => (res.ok ? res.json() : null));
    if (Array.isArray(fresh)) setMessages(fresh);
    return true;
  };

  const undoFrom = (messageId: string) => void rewindTo(messageId);
  const editAndResend = async (messageId: string, newText: string) => {
    if (await rewindTo(messageId)) sendText(newText);
  };

  // The DO names the session from its first message during the turn, so refresh
  // the side-panel once the turn settles (busy -> idle) to pick up the title.
  const wasBusyRef = useRef(false);
  useEffect(() => {
    if (isBusy) {
      wasBusyRef.current = true;
      return;
    }
    if (wasBusyRef.current) {
      wasBusyRef.current = false;
      invalidateSamSessions(projectId);
    }
  }, [isBusy, projectId]);

  // Pin to the bottom while the user follows along. Decoupled via rAF to prevent
  // layout thrashing during high-frequency assistant streams.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, status]);

  const lastMessage = messages[messages.length - 1];
  const showTyping =
    isBusy &&
    (lastMessage?.role !== "assistant" ||
      !lastMessage.parts.some(
        (part) => part.type === "text" && part.text.trim(),
      ));
  const showSuggestions = messages.length === 0 && !isBusy;

  const showDebugTrace =
    import.meta.env.DEV || import.meta.env.VITE_SAM_DEBUG_TRACE === "1";

  return (
    <div dir={direction} className="flex min-w-0 flex-1 flex-col">
      {showDebugTrace ? (
        <div className="relative z-10 flex min-h-8 shrink-0 items-center justify-end gap-1 px-3">
          {!tracePanelOpen ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs gap-1 text-base-content/40"
              title="Show SAM Debug Trace"
              onClick={() => {
                setTracePanelOpen(true);
                if (traceFrameRef.current) setTraceFrame(traceFrameRef.current);
              }}
            >
              <Radio className="size-3" />
              Trace
            </button>
          ) : null}
          {import.meta.env.DEV ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs text-base-content/40"
              onClick={() => clearHistory()}
            >
              Clear history (dev)
            </button>
          ) : null}
          {tracePanelOpen ? (
            <div className="pointer-events-none absolute end-3 top-full z-20 flex justify-end">
              <SamDebugTracePanel
                frame={traceFrame}
                live={isBusy}
                onClose={() => setTracePanelOpen(false)}
                onClear={() => {
                  traceFrameRef.current = null;
                  setTraceFrame(null);
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {messages.length === 0 ? (
            <div dir="ltr" className="space-y-2 text-sm text-base-content/80">
              <p>
                Hey, I’m SAM — your in-app SEO agent. I can research keywords,
                size up competitors, read your SERPs, backlinks, rank tracking
                and Search Console, and turn it into next steps for this
                project.
              </p>
              <p>Ask me anything, or start with one of these:</p>
            </div>
          ) : null}

          {showSuggestions ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {WORKFLOW_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className="rounded-full border border-primary/40 bg-primary/5 px-3 py-1.5 text-xs font-medium text-base-content/80 transition-colors hover:border-primary/70 hover:bg-primary/10"
                    onClick={() => sendText(preset.prompt)}
                  >
                    <bdi dir="ltr">{preset.label}</bdi>
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((question) => (
                  <button
                    key={question}
                    type="button"
                    className="rounded-full border border-base-300 bg-base-100 px-3 py-1.5 text-xs font-medium text-base-content/70 transition-colors hover:border-primary/50 hover:text-base-content"
                    onClick={() => sendText(question)}
                  >
                    <bdi dir="ltr">{question}</bdi>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {messages.map((message, index) => (
            <ChatMessage
              key={message.id}
              message={message}
              bidi
              resolveToolLabel={resolveSamToolLabel}
              streaming={
                isBusy &&
                index === messages.length - 1 &&
                message.role === "assistant"
              }
              onUndo={
                // Allowed even mid-turn: rewind aborts the in-flight turn
                // server-side, so undo doubles as "stop and take it back".
                message.role === "user" ? () => undoFrom(message.id) : undefined
              }
              onEdit={
                message.role === "user"
                  ? (newText) => void editAndResend(message.id, newText)
                  : undefined
              }
            />
          ))}

          {showTyping ? (
            <div className="flex items-center gap-2 pt-1 text-base-content/40">
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-current" />
              </span>
            </div>
          ) : null}

          {stopped && !isBusy ? (
            <p
              role="status"
              dir="auto"
              className="text-sm text-base-content/70"
            >
              {arabicFeedback
                ? "أوقفت رد سام. يمكنك طلب المتابعة من النتائج المتاحة."
                : "You stopped SAM's reply. You can ask it to continue from the available results."}
            </p>
          ) : null}

          {status === "error" ? (
            <p role="alert" dir="auto" className="text-sm text-error">
              {/* The server normalizes provider failures into one curated,
                  secret-free message (auth / data policy / rate limit / …)
                  and delivers it as the terminal error body — at the turn
                  hook AND the stream boundary. safeSamErrorMessage is
                  defense-in-depth: if a raw provider payload ever reaches
                  this seam anyway, it degrades to the generic curated
                  message instead of rendering vendor text. */}
              {safeSamErrorMessage(error?.message)}
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex-shrink-0 border-t border-base-300 px-5 py-3">
        <div className="mx-auto w-full max-w-2xl">
          {isBusy && !stopped ? (
            <button
              type="button"
              className="btn btn-ghost btn-xs mb-1"
              onClick={stopTurn}
            >
              {direction === "rtl" ? "إيقاف الرد" : "Stop response"}
            </button>
          ) : null}
          <ChatComposer
            busy={isBusy}
            onSend={sendText}
            placeholderDirection={direction}
            placeholder={
              direction === "rtl"
                ? "اطلب من سام البحث أو التحليل أو المتابعة…"
                : "Ask SAM to research, analyze, or track anything…"
            }
          />
        </div>
      </div>
    </div>
  );
}
