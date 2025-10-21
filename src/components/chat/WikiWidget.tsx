// src/components/chat/WikiWidget.tsx

export type WikiResult = import("../../../worker/tools/getWiki").WikiResult;

export function WikiWidget({ result }: { result: WikiResult }) {
  if (!result.ok) {
    return (
      <div className="card-surface max-w-md p-4">
        <div className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Wikipedia</div>
        <div className="text-xs text-neutral-600 dark:text-neutral-400">Error: {result.error}</div>
      </div>
    );
  }

  const { title, description, extract, pageUrl, thumbnailUrl } = result;
  const snippet = extract.length > 520 ? extract.slice(0, 520).trimEnd() + "…" : extract;

  return (
    <div className="card-surface max-w-md p-4">
      <div className="mb-2 flex items-start gap-3">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt=""
            className="h-12 w-12 flex-none rounded-lg object-cover ring-1 ring-black/5 dark:ring-white/10"
            loading="lazy"
            decoding="async"
          />
        ) : null}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {title || "Wikipedia"}
          </div>
          {description ? (
            <div className="truncate text-xs text-neutral-600 dark:text-neutral-400">{description}</div>
          ) : null}
        </div>
      </div>

      <p className="mb-2 text-sm leading-relaxed text-neutral-900 dark:text-neutral-100">{snippet}</p>

      <a
        href={pageUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-xs underline underline-offset-4 text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white"
      >
        Read on Wikipedia →
      </a>
    </div>
  );
}
