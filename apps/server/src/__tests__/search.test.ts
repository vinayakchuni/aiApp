import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createSearchService,
  SearchBudgetExhaustedError,
  SearchProviderError,
  getMaxSearchesPerResearch,
} from '../services/search';

function fakeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('search service', () => {
  beforeEach(() => {
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.BRAVE_SEARCH_API_KEY;
    delete process.env.MAX_SEARCHES_PER_RESEARCH;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getMaxSearchesPerResearch', () => {
    it('returns default 20 when env not set', () => {
      expect(getMaxSearchesPerResearch()).toBe(20);
    });

    it('reads from env when valid', () => {
      process.env.MAX_SEARCHES_PER_RESEARCH = '5';
      expect(getMaxSearchesPerResearch()).toBe(5);
    });

    it('falls back to default on invalid env', () => {
      process.env.MAX_SEARCHES_PER_RESEARCH = 'not-a-number';
      expect(getMaxSearchesPerResearch()).toBe(20);
    });
  });

  describe('budget enforcement', () => {
    it('throws SearchBudgetExhaustedError after budget hits 0', async () => {
      process.env.FIRECRAWL_API_KEY = 'k';
      const fetchImpl = vi.fn().mockImplementation(async () =>
        fakeJsonResponse(200, {
          data: [{ title: 't', url: 'https://a.example', description: 's' }],
        }),
      );
      const svc = createSearchService({ budget: 2, fetch: fetchImpl as unknown as typeof fetch });

      await svc.search('q1');
      expect(svc.remaining()).toBe(1);
      await svc.search('q2');
      expect(svc.remaining()).toBe(0);
      await expect(svc.search('q3')).rejects.toBeInstanceOf(SearchBudgetExhaustedError);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('Firecrawl primary path', () => {
    it('parses Firecrawl response into SearchResult[]', async () => {
      process.env.FIRECRAWL_API_KEY = 'fc-key';
      const fetchImpl = vi.fn().mockResolvedValue(
        fakeJsonResponse(200, {
          data: [
            {
              title: 'Climate impacts',
              url: 'https://nature.example/climate',
              description: 'A study on climate.',
            },
            { url: 'https://x.example', markdown: '## hello world' },
          ],
        }),
      );
      const svc = createSearchService({ fetch: fetchImpl as unknown as typeof fetch });
      const out = await svc.search('climate change');
      expect(out).toEqual([
        {
          title: 'Climate impacts',
          url: 'https://nature.example/climate',
          snippet: 'A study on climate.',
        },
        { title: 'https://x.example', url: 'https://x.example', snippet: '## hello world' },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [, init] = fetchImpl.mock.calls[0];
      expect(init.headers.Authorization).toBe('Bearer fc-key');
    });
  });

  describe('Brave fallback', () => {
    it('falls back to Brave when Firecrawl errors', async () => {
      process.env.FIRECRAWL_API_KEY = 'fc';
      process.env.BRAVE_SEARCH_API_KEY = 'br';
      const fetchImpl = vi
        .fn()
        // Firecrawl 500
        .mockResolvedValueOnce(fakeJsonResponse(500, { error: 'boom' }))
        // Brave success
        .mockResolvedValueOnce(
          fakeJsonResponse(200, {
            web: {
              results: [
                {
                  title: 'Brave result',
                  url: 'https://brave.example/a',
                  description: 'desc',
                },
              ],
            },
          }),
        );
      const svc = createSearchService({ fetch: fetchImpl as unknown as typeof fetch });
      const out = await svc.search('x');
      expect(out).toEqual([
        { title: 'Brave result', url: 'https://brave.example/a', snippet: 'desc' },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('throws SearchProviderError when both providers fail', async () => {
      process.env.FIRECRAWL_API_KEY = 'fc';
      process.env.BRAVE_SEARCH_API_KEY = 'br';
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(fakeJsonResponse(500, {}))
        .mockResolvedValueOnce(fakeJsonResponse(401, {}));
      const svc = createSearchService({ fetch: fetchImpl as unknown as typeof fetch });
      await expect(svc.search('x')).rejects.toMatchObject({
        name: 'SearchProviderError',
        providersTried: ['firecrawl', 'brave'],
      });
    });

    it('throws SearchProviderError when nothing is configured', async () => {
      const svc = createSearchService({ budget: 1 });
      await expect(svc.search('x')).rejects.toBeInstanceOf(SearchProviderError);
    });

    it('uses Brave directly when only Brave is configured', async () => {
      process.env.BRAVE_SEARCH_API_KEY = 'br';
      const fetchImpl = vi.fn().mockResolvedValue(
        fakeJsonResponse(200, {
          web: { results: [{ title: 't', url: 'https://b.example', description: 'd' }] },
        }),
      );
      const svc = createSearchService({ fetch: fetchImpl as unknown as typeof fetch });
      const out = await svc.search('q');
      expect(out).toEqual([{ title: 't', url: 'https://b.example', snippet: 'd' }]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url] = fetchImpl.mock.calls[0];
      expect(String(url)).toContain('api.search.brave.com');
    });
  });
});
