import { describe, it, expect } from 'vitest';
import { splitParagraphByImages, generateResearchPdf } from '../services/pdf';

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('splitParagraphByImages', () => {
  it('returns a single text segment when no images are present', () => {
    const segs = splitParagraphByImages('hello world');
    expect(segs).toEqual([{ kind: 'text', value: 'hello world' }]);
  });

  it('splits text around a base64 image markdown tag', () => {
    const para = `before ![chart-1-0](data:image/png;base64,${ONE_PIXEL_PNG_BASE64}) after`;
    const segs = splitParagraphByImages(para);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({ kind: 'text', value: 'before ' });
    expect(segs[1]).toEqual({ kind: 'image', base64: ONE_PIXEL_PNG_BASE64 });
    expect(segs[2]).toEqual({ kind: 'text', value: ' after' });
  });

  it('handles multiple images in one paragraph', () => {
    const para = `![a](data:image/png;base64,AAA) middle ![b](data:image/png;base64,BBB)`;
    const segs = splitParagraphByImages(para);
    expect(segs.map((s) => s.kind)).toEqual(['image', 'text', 'image']);
  });
});

describe('generateResearchPdf', () => {
  it('renders a report with an inline base64 chart without throwing', async () => {
    const buf = await generateResearchPdf({
      title: 'Test',
      report: {
        executiveSummary: 'summary',
        keyFindings: ['finding'],
        detailedAnalysis: `Intro paragraph.\n\n![chart-1-0](data:image/png;base64,${ONE_PIXEL_PNG_BASE64})\n\nFollowup paragraph.`,
        sources: [],
        methodology: {
          queries: [],
          iterationCount: 1,
          finalScores: null,
          factCheckSummary: {
            totalClaimsExtracted: 0,
            verifiedClaims: 0,
            unverifiedClaims: 0,
            notCheckedClaims: 0,
          },
        },
      },
    });
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.slice(0, 4).toString('ascii')).toBe('%PDF');
  });
});
