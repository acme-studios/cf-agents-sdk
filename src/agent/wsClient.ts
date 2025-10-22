// src/agent/wsClient.ts

export type AgentState = {
  model: string;
  messages: { role: "user" | "assistant"; content: string; ts: number }[];
};

// Type-only imports for tool results (erased at build time)
export type WeatherResult = import("../../worker/tools/getWeather").WeatherResult;
export type WikiResult    = import("../../worker/tools/getWiki").WikiResult;

/** Tool event shape (weather, wiki, iss) */
export type ToolEvent =
  // Weather
  | { type: "tool"; tool: "getWeather"; status: "started"; message?: string }
  | { type: "tool"; tool: "getWeather"; status: "step";    message?: string }
  | { type: "tool"; tool: "getWeather"; status: "done";    message?: string; result: unknown }
  | { type: "tool"; tool: "getWeather"; status: "error";   message: string }
  // Wikipedia
  | { type: "tool"; tool: "getWiki";    status: "started"; message?: string }
  | { type: "tool"; tool: "getWiki";    status: "step";    message?: string }
  | { type: "tool"; tool: "getWiki";    status: "done";    message?: string; result: unknown }
  | { type: "tool"; tool: "getWiki";    status: "error";   message: string }
  // ISS tracker
  | { type: "tool"; tool: "getISS";     status: "started"; message?: string }
  | { type: "tool"; tool: "getISS";     status: "step";    message?: string }
  | { type: "tool"; tool: "getISS";     status: "done";    message?: string; result: unknown }
  | { type: "tool"; tool: "getISS";     status: "error";   message: string };

export class AgentClient {
  private ws: WebSocket | null = null;

  onReady:    (s: AgentState) => void = () => {};
  onDelta:    (t: string) => void     = () => {};
  onDone:     () => void              = () => {};
  onCleared:  () => void              = () => {};
  /** For progress/results cards */
  onTool:     (evt: ToolEvent) => void = () => {};

  isOpen()       { return this.ws?.readyState === WebSocket.OPEN; }
  isConnecting() { return this.ws?.readyState === WebSocket.CONNECTING; }

  async connect(): Promise<void> {
    const sid = this.#getOrCreateSid();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/agents/ai-agent/${sid}`;

    console.log("[ws] connecting", { url, sessionId: sid });
    this.ws = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error("no ws"));
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e: Event) => {
        console.error("[ws] error", e);
        reject(new Error("WebSocket error"));
      };
    });

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);

        if (msg?.type === "ready")   { this.onReady(msg.state as AgentState); return; }
        if (msg?.type === "delta")   { this.onDelta(String(msg.text ?? ""));  return; }
        if (msg?.type === "done")    { this.onDone();                          return; }
        if (msg?.type === "cleared") { this.onCleared();                       return; }
        if (msg?.type === "tool")    { this.onTool(msg as ToolEvent);          return; }
      } catch {
        // ignore malformed frames
      }
    };

    this.ws.onclose = (ev) => {
      console.log("[ws] close", ev.code, ev.reason || "");
    };
    this.ws.onerror = (ev) => {
      console.log("[ws] error", ev);
    };
  }

  chat(text: string) {
    this.ws?.send(JSON.stringify({ type: "chat", text }));
  }
  reset() {
    this.ws?.send(JSON.stringify({ type: "reset" }));
  }
  setModel(model: string) {
    this.ws?.send(JSON.stringify({ type: "model", model }));
  }

  #getOrCreateSid(): string {
    const k = "sessionId";
    let sid = localStorage.getItem(k);
    if (!sid) { sid = crypto.randomUUID(); localStorage.setItem(k, sid); }
    return sid;
  }
}
