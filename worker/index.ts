/// <reference types="@cloudflare/workers-types" />
import { routeAgentRequest } from "agents";
export { default as AIAgent } from "./agent";
type AssetsBinding = { fetch(request: Request): Promise<Response> };

export default {
  async fetch(request: Request, env: Cloudflare.Env & { ASSETS: AssetsBinding }, _ctx: ExecutionContext): Promise<Response> {
    void _ctx;
    const url = new URL(request.url);

    // Handle agent WebSocket/HTTP requests
    const routed = await (routeAgentRequest as unknown as (req: Request, env: Env) => Promise<Response | null>)(request, env);
    if (routed) return routed;

    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }

    // Serve static files
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env & { ASSETS: AssetsBinding }>;
