/// <reference lib="webworker" />
import { Agent, type Connection, type ConnectionContext } from "agents";

/** Local shape for the Workers AI binding (narrow enough for chat) */
type WorkersAiBinding = {
  run: (
    model: string,
    input: {
      messages: { role: "system" | "user" | "assistant"; content: string }[];
      stream?: boolean;
      tools?: unknown;
      temperature?: number;
      max_tokens?: number;
    }
  ) => Promise<ReadableStream<Uint8Array> | unknown>;
};

/** Extend the ambient Env (from worker-configuration.d.ts) with our AI binding */
type EnvWithAI = Env & { AI: WorkersAiBinding };

/** Minimal AI chat message type for Workers AI input (no ts here) */
type AiChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** Single row we store (and mirror in state) */
type Msg = { role: "user" | "assistant" | "tool"; content: string; ts: number };

/** Durable Object state */
type State = {
  model: string;
  messages: Msg[]; // persisted rows (include ts)
  createdAt: number;
  expiresAt: number;
};

const DAY = 86_400_000;
const DEFAULT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

/** Helpers */
function isReadableStream(x: unknown): x is ReadableStream<Uint8Array> {
  return !!x && typeof (x as { getReader?: unknown }).getReader === "function";
}
function isUserOrAssistant(m: Msg): m is { role: "user" | "assistant"; content: string; ts: number } {
  return m.role === "user" || m.role === "assistant";
}

export default class AIAgent extends Agent<EnvWithAI, State> {
  // NOTE: do NOT redeclare `env`; the generic <EnvWithAI, ...> already types it.

  initialState: State = {
    model: DEFAULT_MODEL,
    messages: [],
    createdAt: Date.now(),
    expiresAt: Date.now() + DAY,
  };

  async onConnect(conn: Connection, ctx: ConnectionContext) {
    console.log("[agent] connect", { name: this.name, url: ctx.request.url });

    await this.#schema();
    if (!this.state.messages?.length) {
      const rows = await this.sql<Msg>`SELECT role, content, ts FROM messages ORDER BY ts ASC`;
      this.setState({
        ...this.state,
        messages: rows,
        expiresAt: Date.now() + DAY,
      });
    }

    conn.send(JSON.stringify({ type: "ready", state: this.state }));
  }

  async onMessage(conn: Connection, message: string | ArrayBuffer | ArrayBufferView) {
    if (typeof message !== "string") return;

    let data: { type?: "chat" | "reset" | "model"; text?: string; model?: string } | null = null;
    try { data = JSON.parse(message); } catch { /* ignore */ }
    if (!data?.type) return;

    if (data.type === "model" && data.model) {
      this.setState({ ...this.state, model: data.model, expiresAt: Date.now() + DAY });
      console.log("[agent] model set", { model: data.model });
      return;
    }

    if (data.type === "reset") {
        await this.sql`DELETE FROM messages`;
        this.setState({
          model: this.state.model,
          messages: [],
          createdAt: Date.now(),
          expiresAt: Date.now() + 86_400_000,
        });
        conn.send(JSON.stringify({ type: "cleared" }));
        return;
    }

    if (data.type === "chat") {
      const userText = (data.text || "").trim();
      if (!userText) return;

      // Persist user row (our Msg includes ts)
      const now = Date.now();
      await this.sql`INSERT INTO messages (role, content, ts) VALUES ('user', ${userText}, ${now})`;
      const userMsg: Msg = { role: "user", content: userText, ts: now };

      this.setState({
        ...this.state,
        messages: [...this.state.messages, userMsg],
        expiresAt: Date.now() + DAY,
      });

      // Build short AI history as AiChatMessage[] (no ts)
      const recentUA = this.state.messages.slice(-40).filter(isUserOrAssistant);
      const history: AiChatMessage[] = recentUA.map(({ role, content }) => ({ role, content }));
      const system = "You are a helpful, concise chat agent. Keep replies short unless the user requests detail.";

      const payload: AiChatMessage[] = [
        { role: "system", content: system },
        ...history,
        { role: "user", content: userText },
      ];

      await this.#streamAssistant(conn, payload);
    }
  }

  // ---------------------- Streaming chat ------------------------------------

  async #streamAssistant(conn: Connection, messages: AiChatMessage[]) {
    let full = "";
    try {
      const ai = (this.env as EnvWithAI).AI;
      const out = await ai.run(this.state.model || DEFAULT_MODEL, {
        messages,
        stream: true,
      });

      const stream = isReadableStream(out) ? out : null;
      if (!stream) {
        const text = typeof out === "string" ? out : "[no response]";
        await this.#saveAssistant(conn, text);
        return;
      }

      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          for (const line of frame.replace(/\r\n/g, "\n").split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trimStart();
            if (!payload || payload === "[DONE]") continue;

            try {
              const json = JSON.parse(payload) as { response?: string };
              const piece = typeof json?.response === "string" ? json.response : "";
              if (piece) {
                full += piece;
                conn.send(JSON.stringify({ type: "delta", text: piece }));
              }
            } catch {
              full += payload;
              conn.send(JSON.stringify({ type: "delta", text: payload }));
            }
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log("[agent] stream error:", msg);
      full = full || "_(stream error)_";
    } finally {
      conn.send(JSON.stringify({ type: "done" }));
    }

    await this.#saveAssistant(conn, full);
  }

  // ---------------------- Persistence helpers -------------------------------

  async #saveAssistant(_conn: Connection, text: string) {
    const ts = Date.now();
    await this.sql`INSERT INTO messages (role, content, ts) VALUES ('assistant', ${text}, ${ts})`;
    this.setState({
      ...this.state,
      messages: [...this.state.messages, { role: "assistant", content: text, ts }],
      expiresAt: Date.now() + DAY,
    });
  }

  async #schema() {
    await this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        role    TEXT    NOT NULL,
        content TEXT    NOT NULL,
        ts      INTEGER NOT NULL
      )`;
  }
}
