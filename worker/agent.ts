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

import { getISS, getISSToolSchema, type IssResult } from "./tools/getISS";

// Workers AI binding type - just what we need for chat
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

// Add AI to the base Env type
type EnvWithAI = Env & { AI: WorkersAiBinding };

// Chat message format for the AI model (no timestamp needed)
type AiChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// Tool call response structure from the AI
type AiToolCall = {
  function?: { name?: string; arguments?: unknown };
};
type AiPlanResponse = {
  tool_calls?: AiToolCall[];
};

type ToolEvent =
  | { type: "tool"; tool: "getWeather"; status: "started"; message?: string }
  | { type: "tool"; tool: "getWeather"; status: "step";    message?: string }
  | { type: "tool"; tool: "getWeather"; status: "done";    message?: string; result: WeatherResult }
  | { type: "tool"; tool: "getWeather"; status: "error";   message: string }
  | { type: "tool"; tool: "getWiki";    status: "started"; message?: string }
  | { type: "tool"; tool: "getWiki";    status: "step";    message?: string }
  | { type: "tool"; tool: "getWiki";    status: "done";    message?: string; result: WikiResult }
  | { type: "tool"; tool: "getWiki";    status: "error";   message: string }
  | { type: "tool"; tool: "getISS";     status: "started"; message?: string }
  | { type: "tool"; tool: "getISS";     status: "step";    message?: string }
  | { type: "tool"; tool: "getISS";     status: "done";    message?: string; result: IssResult }
  | { type: "tool"; tool: "getISS";     status: "error";   message: string };

function emitTool(conn: Connection, evt: ToolEvent) {
  conn.send(JSON.stringify(evt));
}

// Message row stored in DB and state
type Msg = { role: "user" | "assistant" | "tool"; content: string; ts: number };

// DO state structure
type State = {
  model: string;
  messages: Msg[]; // all messages with timestamps
  createdAt: number;
  expiresAt: number;
};

const DAY = 86_400_000;
const DEFAULT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";

// Helper functions
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

      // Save user message to DB
      const now = Date.now();
      await this.sql`INSERT INTO messages (role, content, ts) VALUES ('user', ${userText}, ${now})`;
      const userMsg: Msg = { role: "user", content: userText, ts: now };

      this.setState({
        ...this.state,
        messages: [...this.state.messages, userMsg],
        expiresAt: Date.now() + DAY,
      });

      // Grab recent messages for context (last 40, no timestamps)
      const recentUA = this.state.messages.slice(-40).filter(isUserOrAssistant);
      const history: AiChatMessage[] = recentUA.map(({ role, content }) => ({ role, content }));

      // Let the model decide what to do - no hardcoded patterns
      // It can call a tool or just chat naturally
      console.log("[agent] phase-3: invoking unified planner for tool selection");
      const toolPlan = await this.#planWithAllTools(history, userText);

      // ISS tool execution
      if (toolPlan?.tool === "getISS") {
        console.log("[agent] phase-3: executing getISS based on model decision");
        const pre = `Let me check the ISS position…`;
        conn.send(JSON.stringify({ type: "delta", text: pre }));
        conn.send(JSON.stringify({ type: "done" }));
        await this.#saveAssistant(conn, pre);

        emitTool(conn, { type: "tool", tool: "getISS", status: "started", message: "Understanding intent…" });
        emitTool(conn, { type: "tool", tool: "getISS", status: "step",    message: "Fetching live position…" });

        const res = await getISS();

        if (!res.ok) {
          emitTool(conn, { type: "tool", tool: "getISS", status: "error", message: res.error });
          const err = `I couldn't fetch the ISS position. Please try again in a moment.`;
          conn.send(JSON.stringify({ type: "delta", text: err }));
          conn.send(JSON.stringify({ type: "done" }));
          await this.#saveAssistant(conn, err);
          return;
        }

        emitTool(conn, { type: "tool", tool: "getISS", status: "done", message: "Position updated", result: res });

        const toolRow: Msg = {
          role: "tool",
          content: JSON.stringify({ type: "tool_result", tool: "getISS", result: res }),
          ts: Date.now(),
        };
        await this.sql`INSERT INTO messages (role, content, ts) VALUES ('tool', ${toolRow.content}, ${toolRow.ts})`;
        this.setState({
          ...this.state,
          messages: [...this.state.messages, toolRow],
          expiresAt: Date.now() + DAY,
        });

        // Use template for summary - model kept hallucinating placeholder values
        console.log("[agent] phase-4: using deterministic summary for ISS (reliable)");
        const summary = this.#summarizeISS(res);
        conn.send(JSON.stringify({ type: "delta", text: summary }));
        conn.send(JSON.stringify({ type: "done" }));
        await this.#saveAssistant(conn, summary);
        return;
      }

      // Weather tool execution
      if (toolPlan?.tool === "getWeather") {
        console.log("[agent] phase-3: executing getWeather based on model decision");
        const plannedWeather = toolPlan.args as WeatherArgs;
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

        // Use template for summary - model kept hallucinating placeholder values
        console.log("[agent] phase-4: using deterministic summary for Weather (reliable)");
        const summary = this.#summarizeWeatherIntent(res);
        conn.send(JSON.stringify({ type: "delta", text: summary }));
        conn.send(JSON.stringify({ type: "done" }));
        await this.#saveAssistant(conn, summary);
        return;
      }

      // Wiki tool execution
      if (toolPlan?.tool === "getWiki") {
        console.log("[agent] phase-3: executing getWiki based on model decision");
        const plannedWiki = toolPlan.args as WikiArgs;
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

        // Use template for summary - model kept hallucinating placeholder values
        console.log("[agent] phase-4: using deterministic summary for Wiki (reliable)");
        const summary = this.#summarizeWiki(res);
        conn.send(JSON.stringify({ type: "delta", text: summary }));
        conn.send(JSON.stringify({ type: "done" }));
        await this.#saveAssistant(conn, summary);
        return;
      }

      // No tool needed, just chat
      console.log("[agent] phase-3: no tool selected, proceeding with regular chat");
      
      // Tell the model what tools it has so it can explain them if asked
      const system = 
        "You are a friendly, helpful chat agent. Keep replies concise unless the user requests more details.\n\n" +
        "You have access to these tools that you can use when appropriate:\n" +
        "- getWeather: Fetch 7-day weather forecasts for any location\n" +
        "- getWiki: Look up information about people, places, things, or concepts from Wikipedia\n" +
        "- getISS: Get the current position of the International Space Station\n\n" +
        "When users ask about your capabilities or what you can do, naturally mention these tools. " +
        "However, you don't need to call these tools right now - just have a conversation.";
      
      const payload: AiChatMessage[] = [
        { role: "system", content: system },
        ...history,
        { role: "user", content: userText },
      ];
      await this.#streamAssistant(conn, payload);
    }
  }

  // Unified tool planner - one model call to decide which tool (if any) to use
  // Replaces the old sequential checking approach with agentic decision making
  // Returns null if no tool is needed, otherwise returns tool name + args
  async #planWithAllTools(
    history: AiChatMessage[],
    userText: string
  ): Promise<{ tool: "getWeather" | "getWiki" | "getISS"; args: unknown } | null> {
    console.log("[agent] unified-planner: evaluating tools for user input:", userText.slice(0, 60));

    const system =
      "You are a helpful assistant with access to tools. Analyze the user's request and decide if any tool is appropriate.\n\n" +
      "Available tools:\n" +
      "- getWeather: Use when user asks about weather, forecast, temperature, or precipitation for a location.\n" +
      "- getWiki: Use when user asks about a person, place, thing, concept, organization, event, or any factual information. " +
      "  For Wikipedia, extract the main subject as the query. Examples:\n" +
      "  * 'How many titles did Real Madrid win?' → query: 'Real Madrid'\n" +
      "  * 'Tell me about Ada Lovelace' → query: 'Ada Lovelace'\n" +
      "  * 'What is machine learning?' → query: 'Machine learning'\n" +
      "- getISS: Use when user asks about the International Space Station location, position, or tracking.\n\n" +
      "If no tool is needed, do not call any tool. Only call one tool at a time.";

    const messages: AiChatMessage[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userText },
    ];

    // Send all tool schemas to the model
    const payload: { messages: AiChatMessage[] } & Record<string, unknown> = { messages };
    payload.tools = [getWeatherToolSchema, getWikiToolSchema, getISSToolSchema];
    payload.temperature = 0.2;
    payload.max_tokens = 200;

    try {
      const ai = (this.env as EnvWithAI).AI;
      const out = await ai.run(this.state.model || DEFAULT_MODEL, payload);

      if (!out || typeof out !== "object") {
        console.log("[agent] unified-planner: no valid response from model");
        return null;
      }

      const calls = Array.isArray((out as AiPlanResponse).tool_calls)
        ? (out as AiPlanResponse).tool_calls!
        : [];

      if (!calls.length) {
        console.log("[agent] unified-planner: no tool_calls in response, no tool needed");
        return null;
      }

      const call = calls[0];
      const toolName = call?.function?.name;

      // Make sure it's a valid tool
      if (!toolName || !["getWeather", "getWiki", "getISS"].includes(toolName)) {
        console.log("[agent] unified-planner: invalid or unknown tool name:", toolName);
        return null;
      }

      const rawArgs = call?.function?.arguments;

      // Log what the model decided
      console.log("[agent] unified-planner: model decided tool:", toolName, "with args:", 
        typeof rawArgs === "string" ? rawArgs.slice(0, 100) : JSON.stringify(rawArgs).slice(0, 100));

      // Parse args and validate per tool
      let parsedArgs: unknown = rawArgs;

      if (typeof rawArgs === "string") {
        try {
          parsedArgs = JSON.parse(rawArgs);
        } catch (e) {
          console.log("[agent] unified-planner: failed to parse args JSON:", e instanceof Error ? e.message : String(e));
          parsedArgs = {};
        }
      }

      // Validate args per tool
      if (toolName === "getWeather") {
        // Weather args are flexible, getWeather handles defaults
        return { tool: "getWeather", args: parsedArgs };
      }

      if (toolName === "getWiki") {
        // Wiki needs a query string
        console.log("[agent] unified-planner: getWiki selected, validating args:", JSON.stringify(parsedArgs));
        if (parsedArgs && typeof parsedArgs === "object") {
          const query = (parsedArgs as { query?: unknown }).query;
          if (typeof query === "string" && query.trim()) {
            console.log("[agent] unified-planner: valid getWiki args with query:", query.slice(0, 50));
            return { tool: "getWiki", args: parsedArgs };
          } else {
            console.log("[agent] unified-planner: getWiki query field missing or invalid, query value:", query);
          }
        } else {
          console.log("[agent] unified-planner: getWiki parsedArgs is not an object:", typeof parsedArgs);
        }
        console.log("[agent] unified-planner: getWiki selected but missing valid query, ignoring");
        return null;
      }

      if (toolName === "getISS") {
        // ISS doesn't need args
        console.log("[agent] unified-planner: valid getISS call (no args needed)");
        return { tool: "getISS", args: {} };
      }

      return null;
    } catch (e) {
      console.log("[agent] unified-planner: exception during planning:", e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  // AGENTIC SYNTHESIS (DISABLED)
  // Tried letting the model generate summaries from tool results, but Llama 3.1 8B
  // keeps hallucinating placeholders like ".°N" instead of actual values like "46.61°N"
  // Keeping this code for when we upgrade to a better model (GPT-4, Claude, etc.)
  
  /* Agentic synthesis - disabled due to model hallucinations */
  /* async #synthesizeToolResponse(
    conn: Connection,
    history: AiChatMessage[],
    userText: string,
    toolName: string,
    toolResult: unknown
  ): Promise<void> {
    console.log("[agent] phase-4: synthesizing agentic response for tool:", toolName);
    console.log("[agent] phase-4: tool result data:", JSON.stringify(toolResult).slice(0, 200));

    // Convert tool result to plain text format (easier for model to parse than JSON)
    let dataText = "";
    
    if (toolName === "getISS" && toolResult && typeof toolResult === "object") {
      const iss = toolResult as IssResult;
      if (iss.ok) {
        dataText = 
          `ISS Location Data:\n` +
          `- Latitude: ${iss.lat.toFixed(2)} degrees\n` +
          `- Longitude: ${iss.lon.toFixed(2)} degrees\n` +
          (iss.altitude_km ? `- Altitude: ${Math.round(iss.altitude_km)} kilometers\n` : "") +
          (iss.velocity_kmh ? `- Velocity: ${Math.round(iss.velocity_kmh)} km/h\n` : "") +
          (iss.visibility ? `- Visibility: ${iss.visibility}\n` : "");
      }
    } else if (toolName === "getWeather" && toolResult && typeof toolResult === "object") {
      const weather = toolResult as WeatherResult;
      if (weather.ok) {
        const loc = [weather.place.name, weather.place.region, weather.place.country].filter(Boolean).join(", ");
        dataText = `Weather Forecast for ${loc}:\n`;
        weather.daily.slice(0, 7).forEach((day, i) => {
          dataText += `Day ${i + 1}: High ${day.tMax}°${weather.units.temp}, Low ${day.tMin}°${weather.units.temp}, Rain chance ${day.pop}%\n`;
        });
      }
    } else if (toolName === "getWiki" && toolResult && typeof toolResult === "object") {
      const wiki = toolResult as WikiResult;
      if (wiki.ok) {
        dataText = `Wikipedia Article: ${wiki.title}\n\nSummary:\n${wiki.extract || "No summary available"}`;
      }
    } else {
      // Fallback to JSON if we can't parse
      dataText = JSON.stringify(toolResult, null, 2);
    }

    console.log("[agent] phase-4: formatted data text:", dataText.slice(0, 200));

    // Build a comprehensive system prompt
    const system =
      "You are a helpful assistant. You just received data from a tool and need to provide a natural response.\n\n" +
      "CRITICAL: Use the EXACT numbers and text provided in the data. Do NOT use placeholders like '.' or ','.\n" +
      "If you see 'Latitude: 46.61 degrees', say '46.61 degrees' - use the actual number.\n" +
      "Be conversational and helpful, but always use real values from the data.";

    const toolResultMessage = 
      `Here is the data I retrieved:\n\n${dataText}\n\n` +
      `User's question was: "${userText}"\n\n` +
      `Please provide a helpful, natural response using the ACTUAL values from the data above.`;

    const messages: AiChatMessage[] = [
      { role: "system", content: system },
      ...history.slice(-4), // Keep last 2 exchanges for context
      { role: "user", content: toolResultMessage },
    ];

    console.log("[agent] phase-4: sending synthesis prompt, message length:", toolResultMessage.length);

    // Stream the synthesized response
    await this.#streamAssistant(conn, messages);
  } */

  // Deterministic summaries - these work reliably with actual values
  // Using templates instead of model generation due to hallucination issues
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

  #summarizeWiki(result: WikiResult): string {
    if (!result.ok) return `I couldn't fetch Wikipedia: ${result.error}`;
    const title = result.title || "Summary";
    const text = (result.extract || "").trim();
    if (!text) return `${title} — summary unavailable.`;
    const snippet = text.length > 480 ? text.slice(0, 480).trimEnd() + "…" : text;
    return `${title} — ${snippet}`;
  }

  #summarizeISS(result: IssResult): string {
    if (!result.ok) return `I couldn't fetch the ISS position: ${result.error}`;
    const lat = result.lat.toFixed(2);
    const lon = result.lon.toFixed(2);
    const alt = typeof result.altitude_km === "number" ? `${Math.round(result.altitude_km)} km` : "unknown";
    const vel = typeof result.velocity_kmh === "number" ? `${Math.round(result.velocity_kmh)} km/h` : "unknown";
    const vis = result.visibility ? result.visibility : "n/a";

    return `The ISS is currently near ${lat}°, ${lon}° at ~${alt}, moving ~${vel} (visibility: ${vis}).`;
  }

  // Stream assistant response
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
