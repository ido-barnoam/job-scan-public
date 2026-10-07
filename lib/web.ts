import { WEB_SEARCHES } from "../config/settings";

// Web search via Tavily (https://docs.tavily.com). Basic depth is set explicitly:
// it costs 1 credit, and Tavily may otherwise upgrade a search to advanced (2 credits).
export interface WebFind {
  url: string;
  title: string;
  snippet?: string;
  query?: string;
}

export const tavilyUsage = { searches: 0 };

export async function runWebSearches(): Promise<{ finds: WebFind[]; errors: string[] }> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return { finds: [], errors: ["TAVILY_API_KEY is not set"] };
  const finds: WebFind[] = [];
  const errors: string[] = [];
  await Promise.all(
    WEB_SEARCHES.map(async ({ query, domains }) => {
      const label = domains ? `${query} (${domains.join(", ")})` : query;
      try {
        tavilyUsage.searches++;
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query, search_depth: "basic", max_results: 20, include_domains: domains }),
          cache: "no-store",
          signal: AbortSignal.timeout(30000),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`Tavily HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
        for (const r of body.results ?? [])
          if (r?.url && r?.title) finds.push({ url: r.url, title: r.title, snippet: String(r.content ?? "").slice(0, 600), query: label });
      } catch (e) {
        errors.push(`Web search failed for "${label}": ${String(e).slice(0, 200)}`);
      }
    }),
  );
  return { finds, errors };
}
