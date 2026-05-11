import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendMock = vi.fn().mockResolvedValue(undefined);
vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(() => ({
    emails: { send: sendMock },
  })),
}));

import {
  renderResearchReportHtml,
  renderResearchReportText,
  sendResearchCompleteEmail,
} from '../services/email';
import type { StructuredReport } from '../services/research';

const SAMPLE_REPORT: StructuredReport = {
  executiveSummary: 'A short overview of the findings.',
  keyFindings: ['Finding one with citation [1].', 'Finding <b>two</b> with citation [2].'],
  detailedAnalysis: 'First paragraph of the analysis.\n\nSecond paragraph references [1] and [3].',
  sources: [
    { index: 1, title: 'Source One', url: 'https://one.example', reliability: 'verified' },
    { index: 2, title: 'Source <Two>', url: 'https://two.example', reliability: 'unknown' },
    { index: 3, title: '', url: 'https://three.example', reliability: 'verified' },
  ],
  methodology: {
    queries: ['climate impacts on agriculture', 'eu policy 2024'],
    iterationCount: 2,
    finalScores: {
      factual_accuracy: 5,
      completeness: 4,
      source_coverage: 5,
      coherence: 4,
      scope_alignment: 5,
    },
    factCheckSummary: {
      totalClaimsExtracted: 4,
      verifiedClaims: 3,
      unverifiedClaims: 1,
      notCheckedClaims: 0,
    },
  },
};

describe('renderResearchReportHtml', () => {
  it('includes every section heading and the conversation deep link', () => {
    const html = renderResearchReportHtml({
      topic: 'Climate impacts on agriculture',
      report: SAMPLE_REPORT,
      conversationUrl: 'https://app.example/?conversation=abc',
    });
    expect(html).toContain('Executive Summary');
    expect(html).toContain('Key Findings');
    expect(html).toContain('Detailed Analysis');
    expect(html).toContain('Sources');
    expect(html).toContain('Methodology');
    expect(html).toContain('Climate impacts on agriculture');
    expect(html).toContain('https://app.example/?conversation=abc');
    expect(html).toContain('A short overview of the findings.');
  });

  it('escapes HTML-unsafe characters in user-supplied content', () => {
    const html = renderResearchReportHtml({
      topic: 'Topic <script>alert(1)</script>',
      report: SAMPLE_REPORT,
      conversationUrl: 'https://app.example/',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    // Key finding with <b> should also be escaped
    expect(html).toContain('Finding &lt;b&gt;two&lt;/b&gt;');
  });

  it('renders the verified badge for verified sources', () => {
    const html = renderResearchReportHtml({
      topic: 't',
      report: SAMPLE_REPORT,
      conversationUrl: 'https://x',
    });
    // The verified label should appear for source 1 and source 3
    const verifiedOccurrences = html.match(/verified/g)?.length ?? 0;
    expect(verifiedOccurrences).toBeGreaterThanOrEqual(2);
  });
});

describe('renderResearchReportText', () => {
  it('produces a plain-text body with all five sections and the link', () => {
    const text = renderResearchReportText({
      topic: 'Topic',
      report: SAMPLE_REPORT,
      conversationUrl: 'https://app.example/?conversation=abc',
    });
    expect(text).toContain('EXECUTIVE SUMMARY');
    expect(text).toContain('KEY FINDINGS');
    expect(text).toContain('DETAILED ANALYSIS');
    expect(text).toContain('SOURCES');
    expect(text).toContain('Open the conversation: https://app.example/?conversation=abc');
  });
});

describe('sendResearchCompleteEmail', () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  it('sends through Resend with html, text and a subject derived from the topic', async () => {
    await sendResearchCompleteEmail({
      email: 'user@example.com',
      conversationId: 'conv-1',
      topic: 'Climate impacts on agriculture',
      report: SAMPLE_REPORT,
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0];
    expect(payload.to).toBe('user@example.com');
    expect(payload.subject).toMatch(/Research ready/);
    expect(payload.subject).toContain('Climate impacts on agriculture');
    expect(payload.html).toContain('Executive Summary');
    expect(payload.text).toContain('EXECUTIVE SUMMARY');
  });

  it('truncates very long topics in the subject', async () => {
    const longTopic = 'x'.repeat(200);
    await sendResearchCompleteEmail({
      email: 'user@example.com',
      conversationId: 'c',
      topic: longTopic,
      report: SAMPLE_REPORT,
    });
    const payload = sendMock.mock.calls[0][0];
    expect(payload.subject.length).toBeLessThanOrEqual(100);
    expect(payload.subject).toContain('...');
  });
});
