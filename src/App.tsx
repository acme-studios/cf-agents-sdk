import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AgentClient, type AgentState } from "./agent/wsClient";
import "./index.css";
import "./App.css";

/* ---------------------------- tiny markdown ---------------------------- */

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Small, safe-ish markdown renderer:
 *  - paragraphs, #/##/### headings
 *  - **bold**, *italics*, `inline code`, ``` fenced ```
 *  - links [text](https://…)
 *  - very simple lists (- or *)
 */
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

type ChatMessage = { id: string; role: "user" | "assistant"; content: string };

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
  const logoSrc = theme === "dark" ? "/logo-dark-theme.png" : "/logo-light-theme.png";
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
        // Only user/assistant are shown in UI
        const restored: ChatMessage[] = (s.messages || [])
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ id: crypto.randomUUID(), role: m.role as "user" | "assistant", content: m.content }));
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

    (async () => {
      if (client.isOpen?.() || client.isConnecting?.()) return;
      try {
        await client.connect();
      } catch (e) {
        console.log("[ws] connect error", e);
      }
    })();

    return () => {
      /* keep WS open */
    };
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
    // ask the server to clear durable state
    clientRef.current?.reset?.();
    // optional: also clear UI immediately
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
    src={logoSrc}             // ← swap based on theme
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
                    <div className="max-w-md text-center">
                    <div className="grid h-full place-items-center">
                      <div className="max-w-xl text-center leading-relaxed">
                        <h2 className="mt-10 mb-1 text-2xl font-semibold">Cloudflare Chat Agent Starter</h2>
                          <p className="mb-10 text-neutral-600 dark:text-neutral-300">
      Minimal chat UI powered by <strong>Agents SDK</strong> + <strong>Workers AI</strong> with streaming and persistence.
    </p>
    <p className="mt-10 text-sm text-neutral-500 dark:text-neutral-400">Start typing below to get started!</p>
  </div>
</div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {messages.map((m) => (
                      <div key={m.id} className="px-1">
                        <MessageBubble role={m.role}>{m.content}</MessageBubble>
                      </div>
                    ))}
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
