import type { PhaseSpan } from './tracing';

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
  search(query: string, parentSpan?: PhaseSpan): Promise<SearchResult[]>;
  remaining(): number;
  total(): number;
  used(): number;
}

export interface CreateSearchServiceOptions {
  budget?: number;
  fetch?: typeof fetch;
}

export function createSearchService(options: CreateSearchServiceOptions = {}): SearchService {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const total = options.budget ?? getMaxSearchesPerResearch();
  let remaining = total;

  return {
    async search(query: string, parentSpan?: PhaseSpan) {
      if (remaining <= 0) throw new SearchBudgetExhaustedError();
      remaining -= 1;

      const span = parentSpan?.startSpan('search-query', {
        input: { query },
        metadata: { query },
      });

      const tried: string[] = [];
      const firecrawlConfigured = Boolean(process.env.FIRECRAWL_API_KEY);
      const braveConfigured = Boolean(process.env.BRAVE_SEARCH_API_KEY);

      if (firecrawlConfigured) {
        tried.push('firecrawl');
        try {
          const results = await searchFirecrawl(fetchImpl, query);
          span?.end({
            metadata: {
              query,
              provider: 'firecrawl',
              providersTried: [...tried],
              fallbackOccurred: false,
              resultCount: results.length,
            },
            output: { results },
          });
          return results;
        } catch (err) {
          console.warn(`Firecrawl search failed for "${query}":`, err);
        }
      }

      if (braveConfigured) {
        tried.push('brave');
        try {
          const results = await searchBrave(fetchImpl, query);
          span?.end({
            metadata: {
              query,
              provider: 'brave',
              providersTried: [...tried],
              fallbackOccurred: tried.length > 1,
              resultCount: results.length,
            },
            output: { results },
          });
          return results;
        } catch (err) {
          console.warn(`Brave search failed for "${query}":`, err);
        }
      }

      if (tried.length === 0) {
        span?.end({
          level: 'ERROR',
          statusMessage: 'no search provider configured',
          metadata: { query, providersTried: [] },
        });
        throw new SearchProviderError(
          'No search provider configured (set FIRECRAWL_API_KEY or BRAVE_SEARCH_API_KEY)',
          [],
        );
      }
      span?.end({
        level: 'ERROR',
        statusMessage: 'all providers failed',
        metadata: {
          query,
          providersTried: [...tried],
          fallbackOccurred: tried.length > 1,
        },
      });
      throw new SearchProviderError(
        `All configured search providers failed for query: ${query}`,
        tried,
      );
    },
    remaining() {
      return remaining;
    },
    total() {
      return total;
    },
    used() {
      return total - remaining;
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
