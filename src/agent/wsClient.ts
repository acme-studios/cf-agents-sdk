export type AgentState = {
    model: string;
    messages: { role: "user" | "assistant"; content: string; ts: number }[];
  };
  
  export class AgentClient {
    private ws: WebSocket | null = null;
  
    onReady: (s: AgentState) => void = () => {};
    onDelta: (t: string) => void = () => {};
    onDone: () => void = () => {};
    onCleared: () => void = () => {};
  
    isOpen() { return this.ws?.readyState === WebSocket.OPEN; }
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
          if (msg?.type === "ready") this.onReady(msg.state as AgentState);
          else if (msg?.type === "delta") this.onDelta(String(msg.text ?? ""));
          else if (msg?.type === "done") this.onDone();
          else if (msg?.type === "cleared") this.onCleared();
        } catch {
          // ignore
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
  