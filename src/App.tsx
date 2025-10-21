import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AgentClient, type AgentState } from "./agent/wsClient";
import { ToolCard, type ToolUI } from "./components/chat/ToolCard";
import { WeatherWidget } from "./components/chat/WeatherWidget";
import type { WeatherResult } from "../worker/tools/getWeather"; // <- use the worker's type
import "./index.css";
import "./App.css";

type ToolUIProgress = Extract<ToolUI, { kind: "progress" }>;

/* ---------------------------- tiny markdown ---------------------------- */

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Small, safe-ish markdown renderer */
function mdToHtml(input: string): string {
  let s = input.replace(/\r\n/g, "\n");
  s = escapeHtml(s);

  // fenced code blocks
  s = s.replace(/```([\s\S]*?)```/g, (_m, code) => {
    const body = code.replace(/^\n+|\n+$/g, "");
    return `<pre><code>${body}</code></pre>`;
  });

  // headings
  s = s.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  s = s.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // links
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, `<a href="$2" target="_blank" rel="noreferrer">$1</a>`);

  // inline code
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");

  // emphasis
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // simple lists
  s = s.replace(/(?:^|\n)([-*]\s.+)(?=\n[^-*]|\n?$)/gs, (block) => {
    const items = block
      .trim()
      .split("\n")
      .map((ln) => ln.replace(/^[-*]\s+/, "").trim())
      .map((it) => `<li>${it}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  });

  // paragraphs
  s = s
    .split(/\n{2,}/)
    .map((para) => {
      if (/^<\/?(h\d|pre|ul|ol)/.test(para)) return para;
      return `<p>${para.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");

  return s;
}

/* ----------------------------- UI types -------------------------------- */

// Chat union now supports:
//  - plain user/assistant bubbles
//  - progress/generic tool cards (ToolUI)
//  - a dedicated weather widget message (separate from ToolUI)
export type ChatMessage =
  | { id: string; role: "user" | "assistant"; content: string }
  | { id: string; role: "tool"; toolUI: ToolUI }
  | { id: string; role: "tool"; weather: WeatherResult };

/** Tool event shape coming from the server */
type ToolEvent =
  | { type: "tool"; tool: "getWeather"; status: "started"; message?: string }
  | { type: "tool"; tool: "getWeather"; status: "step"; message?: string }
  | { type: "tool"; tool: "getWeather"; status: "done"; message?: string; result: WeatherResult }
  | { type: "tool"; tool: "getWeather"; status: "error"; message: string };

/* ------------------------- Type guards / helpers ------------------------ */

type ServerMsgRow = { role: string; content: string; ts: number };
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function hasStr<K extends string>(obj: Record<string, unknown>, key: K): obj is Record<K, string> {
  return key in obj && typeof obj[key] === "string";
}
function hasNum<K extends string>(obj: Record<string, unknown>, key: K): obj is Record<K, number> {
  return key in obj && typeof obj[key] === "number";
}
function isServerMsgRow(v: unknown): v is ServerMsgRow {
  return isRecord(v) && hasStr(v, "role") && hasStr(v, "content") && hasNum(v, "ts");
}
function isToolEvent(v: unknown): v is ToolEvent {
  if (!isRecord(v)) return false;
  if ((v as { type?: unknown }).type !== "tool") return false;
  if ((v as { tool?: unknown }).tool !== "getWeather") return false;
  const status = (v as { status?: unknown }).status;
  return status === "started" || status === "step" || status === "done" || status === "error";
}
function isWeatherResult(v: unknown): v is WeatherResult {
  if (!isRecord(v) || typeof v.ok !== "boolean") return false;
  if (v.ok === false) return hasStr(v, "error");
  return isRecord(v.place) && isRecord(v.units) && Array.isArray(v.daily);
}

/* --------------------------- Progress helpers --------------------------- */

type StepState = "idle" | "active" | "done" | "error";

function initialWeatherProgress(): ToolUI {
  return {
    kind: "progress",
    title: "Weather",
    progress: {
      tool: "getWeather",
      phase: "running",
      steps: [
        { key: "plan",  label: "Plan intent",       state: "active" as StepState },
        { key: "fetch", label: "Fetch from Open-Meteo API",    state: "idle"   as StepState },
        { key: "parse", label: "Parse forecast",    state: "idle"   as StepState },
        { key: "final", label: "Finalize",          state: "idle"   as StepState },
      ],
    },
  };
}
function setStepState(ui: ToolUI, key: string, state: StepState): ToolUI {
  if (ui.kind !== "progress" || !ui.progress) return ui;
  const steps = ui.progress.steps.map((s) => (s.key === key ? { ...s, state } : s));
  return { ...ui, progress: { ...ui.progress, steps } };
}
function markSequence(ui: ToolUI, activate: string, doneKeys: string[]): ToolUI {
  let next = ui;
  for (const k of doneKeys) next = setStepState(next, k, "done");
  next = setStepState(next, activate, "active");
  return next;
}
// IMPORTANT: return an explicit "progress" object (don’t spread a possibly-generic base)
function finalizeProgress(ui?: ToolUI): ToolUI {
  // Pin to the "progress" variant so .progress is guaranteed to exist
  const base: ToolUIProgress =
    ui && ui.kind === "progress" ? ui : (initialWeatherProgress() as ToolUIProgress);

  const steps = base.progress.steps.map((s) =>
    s.state === "done" ? s : { ...s, state: "done" as StepState }
  );

  return {
    kind: "progress",
    title: base.title,
    subtitle: base.subtitle,
    progress: { ...base.progress, phase: "done", steps },
  };
}

function errorProgress(ui?: ToolUI, msg?: string): ToolUI {
  const base: ToolUIProgress =
    ui && ui.kind === "progress" ? ui : (initialWeatherProgress() as ToolUIProgress);

  // Mark whichever step is currently "active" as "error", others unchanged
  const steps = base.progress.steps.map((s) =>
    s.state === "active" ? { ...s, state: "error" as const } : s
  );

  return {
    kind: "progress",
    title: base.title,
    subtitle: base.subtitle,
    progress: {
      ...base.progress,
      phase: "error",
      error: msg ?? "Something went wrong",
      steps,
    },
  };
}
function upsertWeatherProgress(
  mutator: (prev?: ToolUI) => ToolUI,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
) {
  setMessages((prev) => {
    const next = [...prev];
    const revIdx = [...next].reverse().findIndex(
      (m) => m.role === "tool" && "toolUI" in m && m.toolUI.kind === "progress" && m.toolUI.progress?.tool === "getWeather"
    );
    if (revIdx === -1) {
      next.push({ id: crypto.randomUUID(), role: "tool", toolUI: mutator(undefined) });
      return next;
    }
    const idx = next.length - 1 - revIdx;
    const cur = (next[idx] as Extract<ChatMessage, { role: "tool"; toolUI: ToolUI }>).toolUI;
    next[idx] = { ...(next[idx] as Extract<ChatMessage, { role: "tool"; toolUI: ToolUI }>), toolUI: mutator(cur) };
    return next;
  });
}

/* --------------------------- Chat components ---------------------------- */

function MessageBubble(props: { role: "user" | "assistant"; children?: ReactNode; pending?: boolean }) {
  const isUser = props.role === "user";
  const base = "w-fit max-w-[85%] md:max-w-[75%] rounded-2xl px-3 py-2 text-sm leading-6";
  const cls = isUser ? `bubble-user ${base}` : `bubble-assistant ${base}`;

  const render = () => {
    if (props.pending) return <span className="opacity-60">…</span>;
    if (!props.children) return null;
    if (!isUser && typeof props.children === "string") {
      const __html = mdToHtml(props.children);
      return <div className="md" dangerouslySetInnerHTML={{ __html }} />;
    }
    return <div className="md">{props.children}</div>;
  };

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={cls}>{render()}</div>
    </div>
  );
}

function ChatInput(props: { onSend: (t: string) => void; disabled?: boolean }) {
  const [v, setV] = useState("");
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const t = v.trim();
        if (!t) return;
        props.onSend(t);
        setV("");
      }}
    >
      <input
        className="flex-1 rounded-md border border-neutral-300 bg-white/70 p-2 text-sm dark:border-neutral-700 dark:bg-neutral-900/60"
        placeholder="Send a message…"
        value={v}
        onChange={(e) => setV(e.target.value)}
        disabled={props.disabled}
      />
      <button
        className="rounded-md bg-black px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
        disabled={props.disabled}
      >
        Send
      </button>
    </form>
  );
}

/* -------------------------------- App ---------------------------------- */

export default function App() {
  const hydratedRef = useRef(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const clientRef = useRef<AgentClient | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Theme (self-contained)
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("theme");
      if (stored === "light" || stored === "dark") return stored;
      if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark";
    }
    return "light";
  });
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", theme === "dark");
    root.classList.toggle("light", theme === "light");
  }, [theme]);

  // Connect once
  useEffect(() => {
    if (!clientRef.current) clientRef.current = new AgentClient();
    const client = clientRef.current;

    client.onReady = (s: AgentState) => {
      if (!hydratedRef.current) {
        const restored: ChatMessage[] = [];
        const rowsUnknown = Array.isArray(s.messages) ? (s.messages as unknown[]) : [];
        for (const r of rowsUnknown) {
          if (!isServerMsgRow(r)) continue;

          if (r.role === "tool") {
            // Tool rows are JSON-encoded by the worker
            try {
              const payload = JSON.parse(r.content) as unknown;
              if (
                isRecord(payload) &&
                (payload as { tool?: unknown }).tool === "getWeather" &&
                isWeatherResult((payload as { result?: unknown }).result)
              ) {
                // Show: finished progress then weather widget
                restored.push({
                  id: crypto.randomUUID(),
                  role: "tool",
                  toolUI: finalizeProgress(initialWeatherProgress()),
                });
                restored.push({
                  id: crypto.randomUUID(),
                  role: "tool",
                  weather: (payload as { result: WeatherResult }).result,
                });
                continue;
              }
            } catch {
              // ignore; fall through to neutral card
            }
            restored.push({
              id: crypto.randomUUID(),
              role: "tool",
              toolUI: { kind: "generic", title: "Tool", subtitle: "Result available" },
            });
            continue;
          }

          // user/assistant
          restored.push({ id: crypto.randomUUID(), role: r.role as "user" | "assistant", content: r.content });
        }
        if (restored.length) setMessages(restored);
        hydratedRef.current = true;
      }
    };

    client.onDelta = (t) => {
      setPending(true);
      setMessages((m) => {
        const last = m[m.length - 1];
        if (!last || last.role !== "assistant") {
          return [...m, { id: crypto.randomUUID(), role: "assistant", content: t }];
        }
        const updated = [...m];
        updated[updated.length - 1] = { ...last, content: last.content + t };
        return updated;
      });
    };

    client.onDone = () => setPending(false);
    client.onCleared = () => {
      hydratedRef.current = false;
      setMessages([]);
    };

    // Tool events (weather)
    client.onTool = (raw: unknown) => {
      if (!isToolEvent(raw)) return;
      const evt = raw;

      if (evt.status === "started") {
        setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "tool", toolUI: initialWeatherProgress() }]);
      } else if (evt.status === "step") {
        const msg = (evt.message ?? "").toLowerCase();
        upsertWeatherProgress((prev) => {
          const base = prev && prev.kind === "progress" ? prev : initialWeatherProgress();
          if (msg.includes("fetch")) return markSequence(base, "fetch", ["plan"]);
          if (msg.includes("pars")) return markSequence(base, "parse", ["plan", "fetch"]);
          if (msg.includes("final")) return markSequence(base, "final", ["plan", "fetch", "parse"]);
          return base;
        }, setMessages);
      } else if (evt.status === "done") {
        upsertWeatherProgress((prev) => finalizeProgress(prev ?? initialWeatherProgress()), setMessages);
        if (isWeatherResult(evt.result)) {
          setMessages((prev) => [
            ...prev,
            { id: crypto.randomUUID(), role: "tool", weather: evt.result },
          ]);
        }
      } else if (evt.status === "error") {
        upsertWeatherProgress((prev) => errorProgress(prev ?? initialWeatherProgress(), evt.message), setMessages);
      }
    };

    (async () => {
      if (client.isOpen?.() || client.isConnecting?.()) return;
      try {
        await client.connect();
      } catch (e) {
        console.log("[ws] connect error", e);
      }
    })();

    return () => { /* keep WS open */ };
  }, []);

  // auto-scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  // actions
  function send(text: string) {
    setMessages((m) => [...m, { id: crypto.randomUUID(), role: "user", content: text }]);
    setPending(true);
    clientRef.current?.chat(text);
  }
  function resetChat() {
    clientRef.current?.reset?.();
    setMessages([]);
  }

  const canReset = useMemo(() => messages.length > 0, [messages]);

  // render
  return (
    <div className="bg-app text-neutral-900 dark:text-neutral-50 min-h-svh transition-colors duration-300">
      <div className="mx-auto grid min-h-svh w-full place-items-center p-4">
        <div className="w-full max-w-3xl">
          <header className="mb-3 flex items-center justify-between gap-3">
            <a href="/" className="flex items-center gap-2 text-lg font-semibold">
              <img
                src={theme === "dark" ? "/logo-dark-theme.png" : "/logo-light-theme.png"}
                alt="Logo"
                className="h-6 w-6 rounded-lg"
                loading="eager"
                decoding="async"
              />
              <span>Chat Agent</span>
            </a>
            <div className="flex items-center gap-3">
              <button
                className="btn"
                aria-label="toggle theme"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                title="Toggle theme"
              >
                {theme === "dark" ? "☀️" : "🌙"}
              </button>
              <button className="btn" onClick={resetChat} disabled={!canReset} title="Reset chat">
                Reset
              </button>
            </div>
          </header>

          <section className="rounded-2xl border border-neutral-200 bg-white/80 p-3 dark:border-neutral-800 dark:bg-neutral-900/60 h-[min(84svh,900px)]">
            <div className="flex h-full flex-col">
              <div ref={scrollRef} className="flex-1 overflow-y-auto px-1 py-2">
                {messages.length === 0 ? (
                  <div className="grid h-full place-items-center">
                    <div className="max-w-xl text-center leading-relaxed">
                      <h2 className="mt-10 mb-1 text-2xl font-semibold">Cloudflare Chat Agent Starter</h2>
                      <p className="mb-10 text-neutral-600 dark:text-neutral-300">
                        Minimal chat UI powered by <strong>Agents SDK</strong> + <strong>Workers AI</strong> with streaming and persistence.
                      </p>
                      <p className="mt-10 text-sm text-neutral-500 dark:text-neutral-400">Start typing below to get started!</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {messages.map((m) => {
                      if (m.role === "tool") {
                        // Render either the widget or a progress/generic card
                        return "weather" in m ? (
                          <div key={m.id} className="px-1">
                            <WeatherWidget result={m.weather} />
                          </div>
                        ) : (
                          <div key={m.id} className="px-1">
                            <ToolCard ui={(m as Extract<ChatMessage, { toolUI: ToolUI }>).toolUI} />
                          </div>
                        );
                      }
                      return (
                        <div key={m.id} className="px-1">
                          <MessageBubble role={m.role}>{m.content}</MessageBubble>
                        </div>
                      );
                    })}
                    {(() => {
                      const last = messages[messages.length - 1];
                      const showPending = pending && (!last || last.role !== "assistant");
                      return showPending ? <MessageBubble role="assistant" pending /> : null;
                    })()}
                  </div>
                )}
              </div>

              <div className="mt-2">
                <ChatInput onSend={send} disabled={pending} />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
