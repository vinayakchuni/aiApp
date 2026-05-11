const DEFAULT_MAX_SEARCHES = 20;
const SEARCH_TIMEOUT_MS = 30_000;
const RESULTS_PER_QUERY = 5;

export function getMaxSearchesPerResearch(): number {
  const raw = process.env.MAX_SEARCHES_PER_RESEARCH;
  if (!raw) return DEFAULT_MAX_SEARCHES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_SEARCHES;
}

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export class SearchBudgetExhaustedError extends Error {
  constructor() {
    super('Search budget exhausted');
    this.name = 'SearchBudgetExhaustedError';
  }
}

export class SearchProviderError extends Error {
  constructor(
    message: string,
    public readonly providersTried: readonly string[],
  ) {
    super(message);
    this.name = 'SearchProviderError';
  }
}

export interface SearchService {
  search(query: string): Promise<SearchResult[]>;
  remaining(): number;
}

export interface CreateSearchServiceOptions {
  budget?: number;
  fetch?: typeof fetch;
}

export function createSearchService(options: CreateSearchServiceOptions = {}): SearchService {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let remaining = options.budget ?? getMaxSearchesPerResearch();

  return {
    async search(query: string) {
      if (remaining <= 0) throw new SearchBudgetExhaustedError();
      remaining -= 1;

      const tried: string[] = [];
      const firecrawlConfigured = Boolean(process.env.FIRECRAWL_API_KEY);
      const braveConfigured = Boolean(process.env.BRAVE_SEARCH_API_KEY);

      if (firecrawlConfigured) {
        tried.push('firecrawl');
        try {
          return await searchFirecrawl(fetchImpl, query);
        } catch (err) {
          console.warn(`Firecrawl search failed for "${query}":`, err);
        }
      }

      if (braveConfigured) {
        tried.push('brave');
        try {
          return await searchBrave(fetchImpl, query);
        } catch (err) {
          console.warn(`Brave search failed for "${query}":`, err);
        }
      }

      if (tried.length === 0) {
        throw new SearchProviderError(
          'No search provider configured (set FIRECRAWL_API_KEY or BRAVE_SEARCH_API_KEY)',
          [],
        );
      }
      throw new SearchProviderError(
        `All configured search providers failed for query: ${query}`,
        tried,
      );
    },
    remaining() {
      return remaining;
    },
  };
}

interface FirecrawlSearchItem {
  title?: string;
  url?: string;
  description?: string;
  markdown?: string;
}

async function searchFirecrawl(
  fetchImpl: typeof fetch,
  query: string,
): Promise<SearchResult[]> {
  const key = process.env.FIRECRAWL_API_KEY!;
  const res = await fetchImpl('https://api.firecrawl.dev/v1/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query, limit: RESULTS_PER_QUERY }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Firecrawl returned ${res.status}`);
  }
  const data = (await res.json()) as { data?: FirecrawlSearchItem[] };
  const items = Array.isArray(data.data) ? data.data : [];
  return normalizeResults(
    items.map((r) => ({
      title: r.title ?? r.url ?? '',
      url: r.url ?? '',
      snippet:
        (typeof r.description === 'string' && r.description) ||
        (typeof r.markdown === 'string' ? r.markdown.slice(0, 500) : ''),
    })),
  );
}

interface BraveSearchItem {
  title?: string;
  url?: string;
  description?: string;
}

async function searchBrave(
  fetchImpl: typeof fetch,
  query: string,
): Promise<SearchResult[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY!;
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(RESULTS_PER_QUERY));
  const res = await fetchImpl(url.toString(), {
    headers: {
      'X-Subscription-Token': key,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Brave returned ${res.status}`);
  }
  const data = (await res.json()) as { web?: { results?: BraveSearchItem[] } };
  const items = data.web?.results ?? [];
  return normalizeResults(
    items.map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
    })),
  );
}

function normalizeResults(rows: SearchResult[]): SearchResult[] {
  return rows
    .filter((r) => r.url.length > 0)
    .slice(0, RESULTS_PER_QUERY)
    .map((r) => ({
      title: r.title.trim() || r.url,
      url: r.url.trim(),
      snippet: r.snippet.trim(),
    }));
}
