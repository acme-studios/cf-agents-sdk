// src/components/chat/ToolCard.tsx

/** Progress types */
export type StepState = "idle" | "active" | "done" | "error";
export type ToolProgress = {
    tool: "getWeather" | "getWiki" | "getISS";
    phase: "running" | "done" | "error";
    steps: Array<{ key: string; label: string; state: StepState; note?: string }>;
    error?: string;
  };

/** Agnostic tool UI envelope */
export type ToolUI =
  | {
      kind: "progress";
      title?: string;
      subtitle?: string;
      progress: ToolProgress;
    }
  | {
      kind: "generic";
      title?: string;
      subtitle?: string;
    }
  | {
      // Rendered by the app with <WeatherWidget />
      kind: "weather";
      title?: string;
      subtitle?: string;
      data?: unknown;
    }
  | {
      // Rendered by the app with <WikiWidget />
      kind: "wiki";
      title?: string;
      subtitle?: string;
      data?: unknown;
    };

/** Small status dot */
function StepDot({ state }: { state: StepState }) {
  if (state === "active") {
    return (
      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" className="opacity-25" stroke="currentColor" strokeWidth="4" fill="none" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4A4 4 0 008 12H4z" />
      </svg>
    );
  }
  if (state === "done") {
    return (
      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
        <path d="M16.707 5.293a1 1 0 010 1.414l-7.778 7.778a1 1 0 01-1.414 0L3.293 10.96a1 1 0 111.414-1.414l3.1 3.1 7.07-7.07a1 1 0 011.414 0z" />
      </svg>
    );
  }
  if (state === "error") {
    return (
      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
        <path d="M10 18a8 8 0 110-16 8 8 0 010 16zm1-10V5H9v3h2zm0 2H9v5h2v-5z" />
      </svg>
    );
  }
  return <div className="h-2 w-2 rounded-full bg-neutral-400" />;
}

export function ToolCard({ ui }: { ui: ToolUI }) {
  // PROGRESS card (compact, glassy; uses your card surface + dark tokens)
  if (ui.kind === "progress" && ui.progress) {
    const { steps, phase, error } = ui.progress;
    const isError = phase === "error";

    return (
      <div className="card-surface max-w-md p-4">
        {ui.title && <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{ui.title}</div>}
        {ui.subtitle && (
          <div className="mb-2 text-xs text-neutral-600 dark:text-neutral-400">{ui.subtitle}</div>
        )}

        <ol className="space-y-2">
          {steps.map((s) => (
            <li key={s.key} className="flex items-center gap-2 text-sm">
              <StepDot state={s.state} />
              <span className="text-neutral-900 dark:text-neutral-100">{s.label}</span>
              {s.note && <span className="text-neutral-500 dark:text-neutral-400">— {s.note}</span>}
            </li>
          ))}
        </ol>

        {isError && error && (
          <div className="mt-3 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:border-red-800/40 dark:bg-red-900/20 dark:text-red-200">
            {error}
          </div>
        )}
      </div>
    );
  }

  // GENERIC fallback
  return (
    <div className="card-surface max-w-md p-4">
      {ui.title && <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{ui.title}</div>}
      {ui.subtitle && <div className="text-xs text-neutral-600 dark:text-neutral-400">{ui.subtitle}</div>}
    </div>
  );
}
