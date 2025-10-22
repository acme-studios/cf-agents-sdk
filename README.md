# Cloudflare Chat Agent Starter

A chat agent built on Cloudflare Workers with streaming responses, persistent memory, and tool calling. Includes weather forecasts, Wikipedia lookups, and ISS tracking out of the box.

Built with Workers AI, Durable Objects, and React.

## Quick Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acme-studios/cf-agents-sdk)

## What You Get

**Backend:**
- Streaming chat via WebSocket + Durable Objects
- SQLite persistence (chat history survives refreshes)
- Agentic tool selection (model decides when to use tools)
- Three working tools: Weather, Wikipedia, ISS tracker

**Frontend:**
- Clean React UI with markdown support
- Dark/light theme
- Live tool progress indicators
- Persistent chat history

## Architecture

The agent uses a **unified planner** approach - one model call decides which tool (if any) to use. No regex patterns or hardcoded logic. The model reasons about tool selection based on user intent.

**Tool Flow:**
```
User: "What's the weather in Tokyo?"
  ↓
Model evaluates: [getWeather, getWiki, getISS]
  ↓
Model decides: getWeather
  ↓
Executes: getWeather({ location: "Tokyo" })
  ↓
Returns: 7-day forecast with widget
```

## Project Structure

```
.
├─ src/                    # React frontend
│  ├─ agent/wsClient.ts    # WebSocket connection
│  ├─ components/chat/     # Tool widgets
│  └─ App.tsx              # Main UI
├─ worker/
│  ├─ agent.ts             # DO with chat logic
│  ├─ index.ts             # Worker entry point
│  └─ tools/               # Tool implementations
│     ├─ getWeather.ts     # Open-Meteo API
│     ├─ getWiki.ts        # Wikipedia API
│     └─ getISS.ts         # ISS tracker API
└─ wrangler.jsonc          # Cloudflare config
```

## Local Development

```bash
npm install
npm run dev
```

Open http://localhost:5173

The dev server runs both Vite (frontend) and Wrangler (Workers runtime) locally.

## Deploy to Production

```bash
npm run build
npm run deploy
```

Your agent will be live at `https://cf-chat-agent.YOUR-SUBDOMAIN.workers.dev`

## Adding New Tools

1. Create a new file in `worker/tools/`
2. Export a tool schema and implementation
3. Add it to the unified planner in `agent.ts`
4. Create a widget component in `src/components/chat/`

Example tool structure:

```typescript
// worker/tools/myTool.ts
export const myToolSchema = {
  type: "function",
  function: {
    name: "myTool",
    description: "What this tool does",
    parameters: { /* args */ }
  }
};

export async function myTool(args: MyArgs): Promise<MyResult> {
  // implementation
}
```

## How It Works

**Agentic Decision Making:**
The agent doesn't use regex or keyword matching. Instead, it presents all available tools to the model in a single call. The model decides which tool (if any) is appropriate based on the conversation context.

**Why This Matters:**
- Handles complex queries naturally ("How many titles did Real Madrid win?" → searches Wikipedia for "Real Madrid")
- Adapts to different phrasings
- Can explain its own capabilities when asked
- No maintenance of regex patterns

**Deterministic Summaries:**
After tools execute, we use template-based summaries instead of model generation. This ensures accurate values (the model was hallucinating placeholders like ".°N" instead of "46.61°N").

## Tech Stack

- **Workers AI**: Llama 3.1 8B for chat + tool selection
- **Durable Objects**: Stateful chat sessions with SQLite
- **Agents SDK**: WebSocket scaffolding
- **React + Tailwind**: Frontend UI
- **Vite**: Dev server + bundling

## API Keys

None needed! All APIs used are free and public:
- Open-Meteo (weather)
- Wikipedia REST API
- wheretheiss.at (ISS tracking)

## Monitoring

Use `wrangler tail` to see live logs:

```bash
wrangler tail
```

You'll see tool decisions, execution logs, and any errors.



## Upgrading the Model

To use a different model, update `DEFAULT_MODEL` in `worker/agent.ts`:

```typescript
const DEFAULT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
```

## License

MIT - use it however you want.

**Disclaimer:** This is not an official Cloudflare product. External APIs may change without notice.
