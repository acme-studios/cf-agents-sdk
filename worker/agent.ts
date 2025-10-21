/// <reference lib="webworker" />
import { Agent, type Connection, type ConnectionContext } from "agents";

import {
  getWeather,
  getWeatherToolSchema,
  type WeatherArgs,
  type WeatherResult,
} from "./tools/getWeather";

import {
  getWiki,
  getWikiToolSchema,
  type WikiArgs,
  type WikiResult,
} from "./tools/getWiki";

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
  ) => Promise<ReadableStream<Uint8Array> | object | string | null | undefined>;
};

/** Extend the ambient Env (from worker-configuration.d.ts) with our AI binding */
type EnvWithAI = Env & { AI: WorkersAiBinding };

/** Minimal AI chat message type for Workers AI input (no ts here) */
type AiChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/** Narrow shape for a tool-calling response from Workers AI */
type AiToolCall = {
  function?: { name?: string; arguments?: unknown };
};
type AiPlanResponse = {
  tool_calls?: AiToolCall[];
};

type ToolEvent =
  | { type: "tool"; tool: "getWeather"; status: "started"; message?: string }
  | { type: "tool"; tool: "getWeather"; status: "step"; message?: string }
  | { type: "tool"; tool: "getWeather"; status: "done"; message?: string; result: WeatherResult }
  | { type: "tool"; tool: "getWeather"; status: "error"; message: string }
  | { type: "tool"; tool: "getWiki"; status: "started"; message?: string }
  | { type: "tool"; tool: "getWiki"; status: "step"; message?: string }
  | { type: "tool"; tool: "getWiki"; status: "done"; message?: string; result: WikiResult }
  | { type: "tool"; tool: "getWiki"; status: "error"; message: string };

function emitTool(conn: Connection, evt: ToolEvent) {
  conn.send(JSON.stringify(evt));
}

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
        expiresAt: Date.now() + DAY,
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

      // Deterministic answer for "what tools do you have?"
      if (/\b(what|which)\s+tools?\b.*(have|can\s+you\s+use)|\btools\??$/i.test(userText)) {
        const toolAnswer =
          "I can use two tools:\n\n" +
          "• **getWeather** — fetches a 7-day forecast from Open-Meteo when you ask about weather, temperatures, or rain.\n" +
          "• **getWiki** — looks up a concise summary from Wikipedia for people, places, things, or concepts.";
        conn.send(JSON.stringify({ type: "delta", text: toolAnswer }));
        conn.send(JSON.stringify({ type: "done" }));
        await this.#saveAssistant(conn, toolAnswer);
        return;
      }

      // 1) Try planning a weather call
      const plannedWeather = await this.#tryPlanWeather(history, userText);
      if (plannedWeather) {
        const pre = "Sure — I’ll check the forecast using getWeather…";
        conn.send(JSON.stringify({ type: "delta", text: pre }));
        conn.send(JSON.stringify({ type: "done" }));
        await this.#saveAssistant(conn, pre);

        emitTool(conn, { type: "tool", tool: "getWeather", status: "started", message: "Planning…" });
        emitTool(conn, { type: "tool", tool: "getWeather", status: "step", message: "Fetching forecast from Open-Meteo…" });

        const res = await getWeather(plannedWeather);

        if (!res.ok) {
          emitTool(conn, { type: "tool", tool: "getWeather", status: "error", message: res.error });
          const errMsg = "I couldn't fetch the weather. Please check the location and try again.";
          conn.send(JSON.stringify({ type: "delta", text: errMsg }));
          conn.send(JSON.stringify({ type: "done" }));
          await this.#saveAssistant(conn, errMsg);
          return;
        }

        emitTool(conn, { type: "tool", tool: "getWeather", status: "done", message: "Forecast ready", result: res });

        const toolRow: Msg = {
          role: "tool",
          content: JSON.stringify({ type: "tool_result", tool: "getWeather", result: res }),
          ts: Date.now(),
        };
        await this.sql`INSERT INTO messages (role, content, ts) VALUES ('tool', ${toolRow.content}, ${toolRow.ts})`;
        this.setState({
          ...this.state,
          messages: [...this.state.messages, toolRow],
          expiresAt: Date.now() + DAY,
        });

        const summary = this.#summarizeWeatherIntent(res);
        conn.send(JSON.stringify({ type: "delta", text: summary }));
        conn.send(JSON.stringify({ type: "done" }));
        await this.#saveAssistant(conn, summary);
        return;
      }

      // 2) Try planning a Wikipedia call
      const plannedWiki = await this.#tryPlanWiki(history, userText);
      if (plannedWiki) {
        const pre = "Let me look that up on Wikipedia…";
        conn.send(JSON.stringify({ type: "delta", text: pre }));
        conn.send(JSON.stringify({ type: "done" }));
        await this.#saveAssistant(conn, pre);

        emitTool(conn, { type: "tool", tool: "getWiki", status: "started", message: "Understanding query…" });
        emitTool(conn, { type: "tool", tool: "getWiki", status: "step", message: "Searching Wikipedia…" });

        const res = await getWiki(plannedWiki);

        if (!res.ok) {
          emitTool(conn, { type: "tool", tool: "getWiki", status: "error", message: res.error });
          const errMsg = "I couldn't fetch Wikipedia. Please refine the topic or try another query.";
          conn.send(JSON.stringify({ type: "delta", text: errMsg }));
          conn.send(JSON.stringify({ type: "done" }));
          await this.#saveAssistant(conn, errMsg);
          return;
        }

        emitTool(conn, { type: "tool", tool: "getWiki", status: "done", message: "Found entry", result: res });

        const toolRow: Msg = {
          role: "tool",
          content: JSON.stringify({ type: "tool_result", tool: "getWiki", result: res }),
          ts: Date.now(),
        };
        await this.sql`INSERT INTO messages (role, content, ts) VALUES ('tool', ${toolRow.content}, ${toolRow.ts})`;
        this.setState({
          ...this.state,
          messages: [...this.state.messages, toolRow],
          expiresAt: Date.now() + DAY,
        });

        const summary = this.#summarizeWiki(res);
        conn.send(JSON.stringify({ type: "delta", text: summary }));
        conn.send(JSON.stringify({ type: "done" }));
        await this.#saveAssistant(conn, summary);
        return;
      }

      // 3) Otherwise, plain streaming chat
      const system = "You are a friendly, helpful chat agent. Keep replies concise unless the user requests more details.";
      const payload: AiChatMessage[] = [
        { role: "system", content: system },
        ...history,
        { role: "user", content: userText },
      ];
      await this.#streamAssistant(conn, payload);
    }
  }

  /** Ask the model if we should call getWeather; returns parsed args or null */
  async #tryPlanWeather(
    history: AiChatMessage[],
    userText: string
  ): Promise<WeatherArgs | null> {
    const system =
      "You can call tools. If the user asks about weather/forecast/temperature/precipitation " +
      "for a place or coordinates, call the getWeather tool with the right arguments. " +
      "If a tool is not appropriate, do not call any tool.";

    const messages: AiChatMessage[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userText },
    ];

    const payload: { messages: AiChatMessage[] } & Record<string, unknown> = { messages };
    payload.tools = [getWeatherToolSchema];
    payload.temperature = 0.2;
    payload.max_tokens = 200;

    try {
      const ai = (this.env as EnvWithAI).AI;
      const out = await ai.run(this.state.model || DEFAULT_MODEL, payload);
      if (!out || typeof out !== "object") return null;

      const calls = Array.isArray((out as AiPlanResponse).tool_calls)
        ? (out as AiPlanResponse).tool_calls!
        : [];
      if (!calls.length) return null;

      const call = calls[0];
      const fn = call?.function?.name;
      if (fn !== "getWeather") return null;

      const rawArgs = call?.function?.arguments;
      if (!rawArgs) return {};

      if (typeof rawArgs === "string") {
        try { return JSON.parse(rawArgs) as WeatherArgs; } catch { return {}; }
      }
      if (typeof rawArgs === "object") return rawArgs as WeatherArgs;
      return {};
    } catch (e) {
      console.log("[agent] planner(getWeather) error:", e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  /** Ask the model if we should call getWiki; returns parsed args or null */
  async #tryPlanWiki(
    history: AiChatMessage[],
    userText: string
  ): Promise<WikiArgs | null> {
    const system =
      "You can call tools. If the user asks about a person, place, thing, concept, or 'what is/are ...', " +
      "call the getWiki tool with a concise query. If a tool is not appropriate, do not call any tool.";
  
    const messages: AiChatMessage[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userText },
    ];
  
    const payload: { messages: AiChatMessage[] } & Record<string, unknown> = { messages };
    payload.tools = [getWikiToolSchema];
    payload.temperature = 0.2;
    payload.max_tokens = 200;
  
    try {
      const ai = (this.env as EnvWithAI).AI;
      const out = await ai.run(this.state.model || DEFAULT_MODEL, payload);
      if (!out || typeof out !== "object") return null;
  
      const calls = Array.isArray((out as AiPlanResponse).tool_calls)
        ? (out as AiPlanResponse).tool_calls!
        : [];
      if (!calls.length) return null;
  
      const call = calls[0];
      const fn = call?.function?.name;
      if (fn !== "getWiki") return null;
  
      const rawArgs = call?.function?.arguments;
      if (!rawArgs) return null;
  
      // validate helper: ensure query is a non-empty string
      const validate = (x: unknown): WikiArgs | null => {
        if (!x || typeof x !== "object") return null;
        const q = (x as { query?: unknown }).query;
        if (typeof q === "string" && q.trim()) {
          const langVal = (x as { lang?: unknown }).lang;
          return typeof langVal === "string" && langVal.trim()
            ? { query: q.trim(), lang: langVal.trim() }
            : { query: q.trim() };
        }
        return null;
      };
  
      if (typeof rawArgs === "string") {
        try {
          const parsed = JSON.parse(rawArgs) as unknown;
          return validate(parsed);
        } catch {
          return null;
        }
      }
  
      if (typeof rawArgs === "object") return validate(rawArgs);
      return null;
    } catch (e) {
      console.log("[agent] planner(getWiki) error:", e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  /** Deterministic post-tool summary (no extra model call) */
  #summarizeWeatherIntent(result: WeatherResult): string {
    if (!result.ok) return "I couldn't fetch the weather. Please double-check the location.";

    const { place, daily, units } = result;
    const name = [place.name, place.region, place.country].filter(Boolean).join(", ") || "that location";
    if (!daily.length) return `I couldn't find a daily forecast for ${name}.`;

    const days = daily.slice(0, Math.min(7, daily.length));
    let hi = -Infinity, lo = Infinity, maxPop = -1;
    for (const d of days) {
      if (Number.isFinite(d.tMax) && d.tMax! > hi) hi = d.tMax!;
      if (Number.isFinite(d.tMin) && d.tMin! < lo) lo = d.tMin!;
      if (Number.isFinite(d.pop) && d.pop! > maxPop) maxPop = d.pop!;
    }
    const T = units.temp;
    const hiR = Number.isFinite(hi) ? Math.round(hi) : null;
    const loR = Number.isFinite(lo) ? Math.round(lo) : null;

    const lines: string[] = [];
    if (hiR !== null && loR !== null) {
      lines.push(`In ${name}, highs reach ~${hiR}${T} and lows dip to ~${loR}${T} this week.`);
    } else if (hiR !== null) {
      lines.push(`In ${name}, highs reach ~${hiR}${T} this week.`);
    } else if (loR !== null) {
      lines.push(`In ${name}, lows dip to ~${loR}${T} this week.`);
    } else {
      lines.push(`In ${name}, typical seasonal temperatures this week.`);
    }

    if (maxPop >= 70) {
      lines.push(`Rain is likely (peak chance ~${Math.round(maxPop)}%) — pack rain gear (umbrella or waterproof jacket).`);
    } else if (maxPop >= 40) {
      lines.push(`Some showers possible (peak ~${Math.round(maxPop)}%) — consider a light rain jacket.`);
    } else {
      lines.push(`Low rain risk overall.`);
    }

    if (hiR !== null && hiR >= 30) {
      lines.push(`It’ll feel hot — dress light and use sunscreen.`);
    } else if (hiR !== null && hiR >= 24 && maxPop < 40) {
      lines.push(`Warm and mostly dry — shorts and light layers are fine.`);
    } else if (loR !== null && loR <= 5) {
      lines.push(`Chilly at times — bring warm layers (and gloves/hat if you get cold easily).`);
    } else if (hiR !== null && loR !== null) {
      const range = hiR - loR;
      if (range >= 10) lines.push(`Temps swing through the day — pack layers.`);
      else lines.push(`Mild, steady temps — simple layers should be fine.`);
    }

    if (loR !== null && loR <= 0 && maxPop >= 50) {
      lines.push(`Freezing conditions possible with precipitation — use winter shoes/boots.`);
    }

    return lines.join(" ");
  }

  /** Deterministic post-tool summary for Wiki (no extra model call) */
  #summarizeWiki(result: WikiResult): string {
    if (!result.ok) return `I couldn't fetch Wikipedia: ${result.error}`;
    const title = result.title || "Summary";
    const text = (result.extract || "").trim(); // <-- uses `extract` from WikiOk
    if (!text) return `${title} — summary unavailable.`;
    const snippet = text.length > 480 ? text.slice(0, 480).trimEnd() + "…" : text;
    return `${title} — ${snippet}`;
  }

  // ---------------------- Streaming chat ------------------------------------
  async #streamAssistant(conn: Connection, messages: AiChatMessage[]) {
    let full = "";
    try {
      const ai = (this.env as EnvWithAI).AI;
      const out = await ai.run(this.state.model || DEFAULT_MODEL, { messages, stream: true });

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
