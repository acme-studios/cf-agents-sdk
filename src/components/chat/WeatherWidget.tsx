// src/components/chat/WeatherWidget.tsx

export type WeatherResult = import("../../../worker/tools/getWeather").WeatherResult;

function dayName(iso: string) {
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { weekday: "short" });
  } catch {
    return iso;
  }
}

function pickIcon(pop: number | null | undefined) {
  const p = typeof pop === "number" ? pop : -1;
  if (p >= 60) return "🌧️";
  if (p >= 30) return "⛅";
  return "☀️";
}

export function WeatherWidget({ result }: { result: WeatherResult }) {
  if (!result.ok) {
    return (
      <div className="card-surface max-w-md p-4">
        <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Weather</div>
        <div className="text-xs text-neutral-600 dark:text-neutral-400">Error: {result.error}</div>
      </div>
    );
  }

  const { place, daily, units } = result;
  const title = [place.name, place.region, place.country].filter(Boolean).join(", ") || "Weather";
  const sub = `${place.timezone} • ${daily.length} day${daily.length > 1 ? "s" : ""}`;

  return (
    <div className="card-surface max-w-md p-4">
      <div className="mb-1 text-sm font-semibold text-neutral-900 dark:text-neutral-100">{title}</div>
      <div className="mb-3 text-xs text-neutral-600 dark:text-neutral-400">{sub}</div>

      {/* Responsive compact strip: 2/4/7 columns to prevent cramped tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2 text-center">
        {daily.slice(0, 7).map((d) => (
          <div
            key={d.date}
            className="rounded-xl border border-neutral-200/60 bg-white/70 px-2 py-2 text-xs dark:border-neutral-800/60 dark:bg-neutral-950/40 overflow-hidden min-w-0"
          >
            <div className="mb-1 font-medium text-neutral-800 dark:text-neutral-100 truncate">
              {dayName(d.date)}
            </div>

            <div className="text-lg leading-none select-none"> {pickIcon(d.pop)} </div>

            {/* Temp line: never overflow; gets smaller on narrow screens */}
            <div className="mt-1 tabular-nums text-neutral-800 dark:text-neutral-200 whitespace-nowrap truncate text-[11px] md:text-xs leading-5">
              {Math.round(d.tMax)}{units.temp}
              <span className="mx-1 text-neutral-400">/</span>
              {Math.round(d.tMin)}{units.temp}
            </div>

            {typeof d.pop === "number" && (
              <div className="mt-1 text-[10px] md:text-[11px] text-neutral-500 dark:text-neutral-400 whitespace-nowrap truncate">
                {Math.round(d.pop)}% rain
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
