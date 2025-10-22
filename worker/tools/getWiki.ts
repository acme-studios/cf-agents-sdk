// Wikipedia tool - searches and fetches article summaries
export type WikiArgs = {
    /** Free-form query, e.g. "Ada Lovelace", "Rust (programming language)" */
    query: string;
    /** Optional ISO 639-1 language code, defaults to "en" */
    lang?: string;
  };
  
  /** Success result */
  export type WikiOk = {
    ok: true;
    /** Canonical page title (resolved) */
    title: string;
    /** Short description when available, e.g. "English mathematician" */
    description?: string;
    /** Extract/summary paragraph(s) */
    extract: string;
    /** Thumbnail image (when available) */
    thumbnailUrl?: string;
    /** Canonical page URL */
    pageUrl: string;
    /** Language used for the lookup */
    lang: string;
  };
  
  /** Error result */
  export type WikiErr = { ok: false; error: string };
  
  export type WikiResult = WikiOk | WikiErr;
  
  /** Tool schema (Workers AI “function tool” shape) */
  export const getWikiToolSchema = {
    type: "function",
    function: {
      name: "getWiki",
      description:
        "Look up a topic or person on Wikipedia and return a short, factual summary with a link and optional thumbnail.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Topic or person to look up" },
          lang: { type: "string", description: "ISO 639-1 language code (default: en)" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  } as const;
  
  /* ------------------------- tiny type guards ------------------------- */
  
  function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
  }
  function hasString(obj: unknown, key: string): obj is Record<string, string> {
    return isRecord(obj) && typeof obj[key] === "string";
  }
  function getString(obj: unknown, key: string): string | undefined {
    return hasString(obj, key) ? obj[key] : undefined;
  }
  
  /** Opensearch JSON: [searchTerm, titles[], descriptions[], links[]] */
  function parseOpensearchTopTitle(json: unknown): string | undefined {
    if (!Array.isArray(json) || json.length < 2) return undefined;
    const titles = json[1];
    if (!Array.isArray(titles) || titles.length === 0) return undefined;
    const first = titles[0];
    return typeof first === "string" ? first : undefined;
  }
  
  /** Pull nested page URL from REST summary safely */
  function extractPageUrl(json: unknown, lang: string, title: string): string {
    if (isRecord(json) && isRecord(json.content_urls) && isRecord(json.content_urls.desktop)) {
      const page = json.content_urls.desktop.page;
      if (typeof page === "string") return page;
    }
    // Build URL manually if needed
    const slug = title.replace(/\s/g, "_");
    return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(slug)}`;
  }
  
  // Extract thumbnail URL if available
  function extractThumb(json: unknown): string | undefined {
    if (isRecord(json) && isRecord(json.thumbnail) && typeof json.thumbnail.source === "string") {
      return json.thumbnail.source;
    }
    return undefined;
  }
  
  /* ----------------------------- tool impl ----------------------------- */
  
  /**
   * Resolve a title via Opensearch, then fetch the REST summary.
   * No API key required. Returns a compact, UI-friendly payload.
   */
  export async function getWiki(args: WikiArgs): Promise<WikiResult> {
    const query = (args.query || "").trim();
    const lang = (args.lang || "en").toLowerCase();
  
    if (!query) return { ok: false, error: "Missing query." };
    // Validate language code
    if (!/^[a-z]{2}(-[a-z]{2})?$/i.test(lang)) {
      return { ok: false, error: `Invalid language: ${lang}` };
    }
  
    // Search for the page title
    const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&namespace=0&search=${encodeURIComponent(
        query
    )}`;
  
    let title = query;
try {
  const sr = await fetch(searchUrl, {
    headers: {
      Accept: "application/json",
      // User agent for Wikimedia
      "User-Agent": "cf-chat-agent-starter/1.0 (+https://developers.cloudflare.com/)",
    },
  });
  if (sr.ok) {
    const j = (await sr.json()) as unknown;
    title = parseOpensearchTopTitle(j) || query;
  } else {
    // If search fails, use query as-is
    title = query;
  }
} catch {
  // On error, use query as-is
  title = query;
}
  
    // Fetch article summary
    const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  
    try {
      const r = await fetch(summaryUrl, {
        headers: {
          Accept: "application/json; charset=utf-8",
          "User-Agent": "cf-chat-agent-starter/1.0 (+https://developers.cloudflare.com/)",
        },
      });
  
      if (r.status === 404) return { ok: false, error: "No page found." };
      if (!r.ok) return { ok: false, error: `Summary failed (${r.status})` };
  
      const j = (await r.json()) as unknown;
  
      const pageTitle = getString(j, "title") || title;
      const extract = getString(j, "extract") || "";
      const description = getString(j, "description");
  
      if (!extract) return { ok: false, error: "No summary available." };
  
      const pageUrl = extractPageUrl(j, lang, pageTitle);
      const thumbnailUrl = extractThumb(j);
  
      return {
        ok: true,
        title: pageTitle,
        description,
        extract,
        thumbnailUrl,
        pageUrl,
        lang,
      };
    } catch {
      return { ok: false, error: "Network error." };
    }
  }
  