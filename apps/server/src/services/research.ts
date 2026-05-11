import { prisma } from '../lib/db';
import { Prisma } from '../generated/prisma/client';
import { generateAssistantText, type TracingContext } from './ai';
import { sendResearchCompleteEmail } from './email';
import { DEFAULT_MODEL_ID, isSupportedModel } from './models';
import type { LLMMessage } from './context';
import {
  createSearchService,
  SearchBudgetExhaustedError,
  SearchProviderError,
  type SearchResult,
  type SearchService,
} from './search';
import { createResearchTrace } from './tracing';

const activeResearchUsers = new Set<string>();

export function isResearchActiveForUser(userId: string): boolean {
  return activeResearchUsers.has(userId);
}

// Exposed for tests to reset state between cases.
export function _resetActiveResearch(): void {
  activeResearchUsers.clear();
}

// Exposed for tests to hold the mutex without running the pipeline.
export function _acquireActiveResearch(userId: string): void {
  activeResearchUsers.add(userId);
}

export const CLARIFYING_QUESTION_COUNT = 4;
export const MIN_SOURCES_REQUIRED = 3;
export const MAX_SEARCH_QUERIES = 5;

const DEFAULT_MAX_RESEARCH_ITERATIONS = 5;
const DEFAULT_MAX_LLM_CALLS_PER_RESEARCH = 10;
const DEFAULT_MAX_FACT_CHECK_CLAIMS = 8;

export function getMaxResearchIterations(): number {
  const raw = process.env.MAX_RESEARCH_ITERATIONS;
  if (!raw) return DEFAULT_MAX_RESEARCH_ITERATIONS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RESEARCH_ITERATIONS;
}

export function getMaxLlmCallsPerResearch(): number {
  const raw = process.env.MAX_LLM_CALLS_PER_RESEARCH;
  if (!raw) return DEFAULT_MAX_LLM_CALLS_PER_RESEARCH;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_LLM_CALLS_PER_RESEARCH;
}

export function getMaxFactCheckClaims(): number {
  const raw = process.env.MAX_FACT_CHECK_CLAIMS_PER_ITERATION;
  if (!raw) return DEFAULT_MAX_FACT_CHECK_CLAIMS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FACT_CHECK_CLAIMS;
}

export const PASS_SCORE_THRESHOLD = 4;
export const CONVERGENCE_SIMILARITY_THRESHOLD = 0.95;
export const CRITIQUE_CRITERIA = [
  'factual_accuracy',
  'completeness',
  'source_coverage',
  'coherence',
  'scope_alignment',
] as const;
export type CritiqueCriterion = (typeof CRITIQUE_CRITERIA)[number];
export type CritiqueScores = Record<CritiqueCriterion, number>;

export type FactCheckStatus = 'verified' | 'unverified' | 'not_checked';

export interface FactCheckResult {
  claim: string;
  status: FactCheckStatus;
  supportingUrls: string[];
}

export interface FactCheckSummary {
  results: FactCheckResult[];
  claimsExtracted: number;
  searchesUsed: number;
  budgetExhausted: boolean;
}

export interface CritiqueIterationRecord {
  iteration: number;
  scores: CritiqueScores;
  critique: string;
  weakest: CritiqueCriterion[];
  revised: boolean;
  factCheck?: FactCheckSummary;
}

export type ResearchExitReason =
  | 'all_passed'
  | 'converged'
  | 'iterations_exhausted'
  | 'budget_exhausted'
  | 'critique_parse_failed';

const CLARIFYING_SYSTEM_PROMPT = `You are a research planning assistant. The user has just given you a research topic. Your job is to ask ${CLARIFYING_QUESTION_COUNT} concise clarifying questions covering scope, depth, focus, and intended audience or use case. Number the questions 1-${CLARIFYING_QUESTION_COUNT}. Do not start the research yet - only ask the questions. Do not include any preamble.`;

const PROCESS_ANSWERS_SYSTEM_PROMPT = `You are a research planning assistant. You previously asked clarifying questions about a research topic. The user has now answered.

Decide whether you have enough information to begin in-depth research. Respond in EXACTLY one of these two formats and nothing else:

READY: <one-sentence summary of the agreed research scope>

or

QUESTIONS:
1. <follow-up question>
2. <follow-up question>
3. <follow-up question>

Use READY only if the answers fully cover scope, depth, and focus. Otherwise ask up to 3 sharper follow-up questions. Do not include other commentary.`;

export type StartResearchOutcome =
  | { kind: 'ok'; userMessage: Awaited<ReturnType<typeof prisma.message.create>>; assistantMessage: Awaited<ReturnType<typeof prisma.message.create>>; conversation: Awaited<ReturnType<typeof prisma.conversation.update>> }
  | { kind: 'not-found' }
  | { kind: 'wrong-mode' }
  | { kind: 'wrong-status' }
  | { kind: 'ai-error' };

export type ProcessAnswerOutcome =
  | {
      kind: 'questions';
      userMessage: Awaited<ReturnType<typeof prisma.message.create>>;
      assistantMessage: Awaited<ReturnType<typeof prisma.message.create>>;
      conversation: Awaited<ReturnType<typeof prisma.conversation.update>>;
    }
  | {
      kind: 'ready';
      userMessage: Awaited<ReturnType<typeof prisma.message.create>>;
      assistantMessage: Awaited<ReturnType<typeof prisma.message.create>>;
      conversation: Awaited<ReturnType<typeof prisma.conversation.update>>;
    };

function modelIdFor(preferredModel: string | null | undefined): string {
  if (preferredModel && isSupportedModel(preferredModel)) return preferredModel;
  return DEFAULT_MODEL_ID;
}

export function parseClarifyingQuestions(text: string): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const questions: string[] = [];
  const numbered = /^\s*(?:\d+[.)]|[-*•])\s*(.+)$/;
  for (const line of lines) {
    const match = line.match(numbered);
    if (match) {
      questions.push(match[1].trim());
    }
  }
  if (questions.length === 0) {
    return lines.slice(0, CLARIFYING_QUESTION_COUNT);
  }
  return questions;
}

export interface ProcessAnswerParseResult {
  ready: boolean;
  text: string;
  questions: string[];
  summary?: string;
}

export function parseProcessAnswerResponse(text: string): ProcessAnswerParseResult {
  const trimmed = text.trim();
  const readyMatch = trimmed.match(/^READY:\s*(.+)/is);
  if (readyMatch) {
    return {
      ready: true,
      text: trimmed,
      questions: [],
      summary: readyMatch[1].trim(),
    };
  }
  const questions = parseClarifyingQuestions(
    trimmed.replace(/^QUESTIONS:\s*/i, '').trim(),
  );
  return { ready: false, text: trimmed, questions };
}

export async function startResearch(
  userId: string,
  conversationId: string,
  topic: string,
): Promise<StartResearchOutcome> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      userId: true,
      mode: true,
      researchStatus: true,
      user: { select: { preferredModel: true } },
    },
  });
  if (!conversation || conversation.userId !== userId) {
    return { kind: 'not-found' };
  }
  if (conversation.mode !== 'research') {
    return { kind: 'wrong-mode' };
  }
  if (conversation.researchStatus !== 'idle') {
    return { kind: 'wrong-status' };
  }

  const userMessage = await prisma.message.create({
    data: {
      conversationId,
      role: 'user',
      content: topic,
    },
  });

  const llmMessages: LLMMessage[] = [
    { role: 'system', content: CLARIFYING_SYSTEM_PROMPT },
    { role: 'user', content: topic },
  ];

  let questionsText: string;
  try {
    questionsText = await generateAssistantText(
      llmMessages,
      modelIdFor(conversation.user?.preferredModel),
    );
  } catch (err) {
    console.error('Clarifying-questions LLM call failed:', err);
    return { kind: 'ai-error' };
  }

  const questions = parseClarifyingQuestions(questionsText);
  const assistantMessage = await prisma.message.create({
    data: {
      conversationId,
      role: 'assistant',
      content: questionsText,
      metadata: { kind: 'clarifying_questions', questions },
    },
  });

  const updatedConversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { researchStatus: 'clarifying', updatedAt: new Date() },
  });

  return {
    kind: 'ok',
    userMessage,
    assistantMessage,
    conversation: updatedConversation,
  };
}

export async function processClarifyingAnswer(
  userId: string,
  conversationId: string,
  content: string,
): Promise<
  | ProcessAnswerOutcome
  | { kind: 'not-found' }
  | { kind: 'wrong-mode' }
  | { kind: 'wrong-status' }
  | { kind: 'ai-error' }
> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      userId: true,
      mode: true,
      researchStatus: true,
      user: { select: { preferredModel: true } },
    },
  });
  if (!conversation || conversation.userId !== userId) {
    return { kind: 'not-found' };
  }
  if (conversation.mode !== 'research') {
    return { kind: 'wrong-mode' };
  }
  if (conversation.researchStatus !== 'clarifying') {
    return { kind: 'wrong-status' };
  }

  const userMessage = await prisma.message.create({
    data: {
      conversationId,
      role: 'user',
      content,
    },
  });

  const history = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  });

  const llmMessages: LLMMessage[] = [
    { role: 'system', content: PROCESS_ANSWERS_SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];

  let responseText: string;
  try {
    responseText = await generateAssistantText(
      llmMessages,
      modelIdFor(conversation.user?.preferredModel),
    );
  } catch (err) {
    console.error('Process-answer LLM call failed:', err);
    return { kind: 'ai-error' };
  }

  const parsed = parseProcessAnswerResponse(responseText);

  if (parsed.ready) {
    const assistantMessage = await prisma.message.create({
      data: {
        conversationId,
        role: 'assistant',
        content: responseText,
        metadata: { kind: 'research_ready', summary: parsed.summary },
      },
    });
    const updatedConversation = await prisma.conversation.update({
      where: { id: conversationId },
      data: { researchStatus: 'researching', updatedAt: new Date() },
    });
    return {
      kind: 'ready',
      userMessage,
      assistantMessage,
      conversation: updatedConversation,
    };
  }

  const assistantMessage = await prisma.message.create({
    data: {
      conversationId,
      role: 'assistant',
      content: responseText,
      metadata: { kind: 'clarifying_questions', questions: parsed.questions },
    },
  });

  const updatedConversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });

  return {
    kind: 'questions',
    userMessage,
    assistantMessage,
    conversation: updatedConversation,
  };
}

// ------- Phase 2: research pipeline -------

const SEARCH_QUERY_GEN_PROMPT = `You are a research planning assistant. The user has provided a topic and answered clarifying questions. Generate 3 to ${MAX_SEARCH_QUERIES} distinct, high-signal web search queries that, when combined, will surface the most relevant sources for the agreed research scope.

If document summaries are supplied, you may ALSO request the full text of any document that looks essential by emitting "READ_FILE: <filename>" on its own line. Only request files whose summary suggests they're directly relevant; otherwise rely on the summary.

Respond with one search query per line. No numbering, no quotes, no preamble. Place any READ_FILE lines at the end.`;

const DRAFT_SYSTEM_PROMPT = `You are a research analyst writing a balanced, evidence-based first draft. Use the supplied web sources AND any supplied document context. Cite web sources inline using bracketed numbers like [1], [2] that correspond to the numbered source list. When you reference an uploaded document, name it explicitly (e.g., "according to the uploaded document foo.pdf"). Aim for 500-800 words. Structure the draft with: a one-paragraph introduction, 3-5 key findings as a bulleted or numbered list with citations, and a brief conclusion. Do not invent facts; if the supplied material is silent on a sub-question, say so.`;

const CRITIQUE_SYSTEM_PROMPT = `You are a senior research editor critiquing a draft research report. Evaluate the draft on EXACTLY these five criteria, each scored from 1 (poor) to 5 (excellent):

1. factual_accuracy — are the claims well-supported by the supplied sources?
2. completeness — does the draft cover the agreed scope thoroughly?
3. source_coverage — are the supplied sources used and cited appropriately?
4. coherence — is the writing clear, well-organized, and free of contradictions?
5. scope_alignment — does the draft stay within the agreed research scope?

Respond in EXACTLY this format and nothing else:

SCORES:
factual_accuracy: <integer 1-5>
completeness: <integer 1-5>
source_coverage: <integer 1-5>
coherence: <integer 1-5>
scope_alignment: <integer 1-5>

CRITIQUE:
<2-4 sentences identifying the most important issues to fix, focused on the lowest-scored criteria. Be specific.>`;

const REVISE_SYSTEM_PROMPT = `You are the research analyst who wrote the previous draft. A senior editor has critiqued it, and a fact checker has verified specific claims. Rewrite the entire draft, addressing every issue raised in the critique AND correcting or removing any claim flagged as unverified. Keep the same structure (one-paragraph intro, 3-5 findings with citations, brief conclusion) and the same numbered citation style ([1], [2], etc.) referring to the same source list. Do not invent new sources. Do not include the critique, scores, or fact-check annotations in your output — only the revised draft prose. Aim for 500-800 words.`;

const CLAIM_EXTRACT_SYSTEM_PROMPT = `You are a fact checker preparing to verify a research draft. Read the draft and extract up to {{MAX_CLAIMS}} of the most important specific, verifiable factual claims (numbers, dates, named entities, attributed statements). Skip subjective opinions, obvious truisms, and meta-commentary. Output ONE claim per line in plain text. No numbering, no bullets, no quotes, no preamble. If the draft contains no verifiable claims, output the single token NO_CLAIMS.`;

const REPORT_SYSTEM_PROMPT = `You are a research editor producing the final structured report. You will be given the topic, agreed scope, the numbered sources, and the final revised draft. Re-organize the draft into a clean, well-structured report. Do not invent new facts. Preserve the existing [1], [2], ... citation numbers that reference the supplied source list.

Respond in EXACTLY this format and NOTHING ELSE:

EXECUTIVE_SUMMARY:
<2-4 sentence high-level summary suitable as a TL;DR>

KEY_FINDINGS:
- <finding 1, one sentence with citation(s) if relevant>
- <finding 2>
- <finding 3>
- <optional finding 4>
- <optional finding 5>

DETAILED_ANALYSIS:
<the main body of the report, organized into 2-5 paragraphs. Use the citations and the supplied sources. Do NOT repeat the executive summary verbatim. Do NOT list the sources here — they appear separately. Aim for 300-700 words.>`;

export function parseSearchQueries(text: string): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const numbered = /^\s*(?:\d+[.)]|[-*•])\s*(.+)$/;
  const queries: string[] = [];
  for (const line of lines) {
    if (/^READ_FILE\s*:/i.test(line)) continue;
    const match = line.match(numbered);
    const value = (match ? match[1] : line).trim();
    const stripped = value.replace(/^["'`]+|["'`]+$/g, '').trim();
    if (stripped.length > 0) queries.push(stripped);
  }
  return queries.slice(0, MAX_SEARCH_QUERIES);
}

export function parseRequestedFiles(text: string): string[] {
  const out: string[] = [];
  const re = /^READ_FILE\s*:\s*(.+)$/gim;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const name = match[1].trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    if (name.length > 0) out.push(name);
  }
  return out;
}

interface ResearchFile {
  id: string;
  originalName: string;
  summary: string | null;
  extractedText: string;
}

function buildFileSummaryBlock(files: ResearchFile[]): string {
  if (files.length === 0) return '';
  const entries = files.map((f) => {
    const body = f.summary && f.summary.length > 0 ? f.summary : '(summary pending)';
    return `- ${f.originalName}: ${body}`;
  });
  return `\n\nUPLOADED DOCUMENT SUMMARIES:\n${entries.join('\n')}`;
}

function buildFullFileBlock(files: ResearchFile[]): string {
  if (files.length === 0) return '';
  const entries = files.map(
    (f) =>
      `[Uploaded file: ${f.originalName}]\n${f.extractedText}\n[End of file: ${f.originalName}]`,
  );
  return `\n\nFULL UPLOADED DOCUMENTS:\n${entries.join('\n\n')}`;
}

function buildDraftUserPrompt(
  topic: string,
  summary: string,
  sources: SearchResult[],
  files: ResearchFile[],
  fullTextFiles: ResearchFile[],
): string {
  const sourceBlock = sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title}\n    URL: ${s.url}\n    SNIPPET: ${s.snippet}`,
    )
    .join('\n\n');
  return `TOPIC: ${topic}\nSCOPE: ${summary}\n\nNUMBERED SOURCES:\n${sourceBlock}${buildFileSummaryBlock(files)}${buildFullFileBlock(fullTextFiles)}\n\nWrite the first draft now.`;
}

export function matchRequestedFiles(
  requested: string[],
  files: ResearchFile[],
): ResearchFile[] {
  const matched: ResearchFile[] = [];
  const seen = new Set<string>();
  for (const name of requested) {
    const needle = name.toLowerCase();
    const hit = files.find(
      (f) =>
        !seen.has(f.id) &&
        (f.originalName.toLowerCase() === needle ||
          f.originalName.toLowerCase().includes(needle)),
    );
    if (hit) {
      matched.push(hit);
      seen.add(hit.id);
    }
  }
  return matched;
}

export type ResearchProgressStage =
  | 'generating_queries'
  | 'searching'
  | 'analyzing_sources'
  | 'writing_draft'
  | 'critiquing'
  | 'fact_checking'
  | 'revising'
  | 'finalizing';

export interface ResearchProgress {
  stage: ResearchProgressStage;
  detail?: string;
  query?: string;
  sourcesFound?: number;
  iteration?: number;
  maxIterations?: number;
  weakestCriteria?: CritiqueCriterion[];
  scores?: CritiqueScores;
  claimsExtracted?: number;
  claimsVerified?: number;
}

export interface CritiqueParseResult {
  scores: CritiqueScores;
  critique: string;
}

export function parseCritique(text: string): CritiqueParseResult | null {
  const scores: Partial<Record<CritiqueCriterion, number>> = {};
  for (const criterion of CRITIQUE_CRITERIA) {
    const re = new RegExp(`^\\s*${criterion}\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)`, 'im');
    const match = text.match(re);
    if (!match) return null;
    const n = Number.parseFloat(match[1]);
    if (!Number.isFinite(n)) return null;
    const clamped = Math.max(1, Math.min(5, Math.round(n)));
    scores[criterion] = clamped;
  }
  const critiqueMatch = text.match(/CRITIQUE\s*:\s*([\s\S]*)$/i);
  const critique = critiqueMatch
    ? critiqueMatch[1].trim()
    : text
        .split('\n')
        .filter((l) => !/^\s*(?:factual_accuracy|completeness|source_coverage|coherence|scope_alignment|scores)\s*:/i.test(l))
        .join('\n')
        .trim();
  return {
    scores: scores as CritiqueScores,
    critique,
  };
}

export function weakestCriteria(
  scores: CritiqueScores,
  threshold: number = PASS_SCORE_THRESHOLD,
): CritiqueCriterion[] {
  return CRITIQUE_CRITERIA.filter((c) => scores[c] < threshold);
}

export function allCriteriaPassed(
  scores: CritiqueScores,
  threshold: number = PASS_SCORE_THRESHOLD,
): boolean {
  return CRITIQUE_CRITERIA.every((c) => scores[c] >= threshold);
}

export function parseClaims(text: string, max: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0 || /^no_?claims$/i.test(trimmed)) return [];
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  const claims: string[] = [];
  const seen = new Set<string>();
  const numbered = /^\s*(?:\d+[.)]|[-*•])\s*(.+)$/;
  for (const line of lines) {
    if (/^no_?claims$/i.test(line)) continue;
    const match = line.match(numbered);
    const value = (match ? match[1] : line).trim();
    const stripped = value.replace(/^["'`]+|["'`]+$/g, '').trim();
    if (stripped.length === 0) continue;
    const key = stripped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    claims.push(stripped);
    if (claims.length >= max) break;
  }
  return claims;
}

export function buildClaimExtractPrompt(draft: string, max: number): LLMMessage[] {
  return [
    {
      role: 'system',
      content: CLAIM_EXTRACT_SYSTEM_PROMPT.replace('{{MAX_CLAIMS}}', String(max)),
    },
    {
      role: 'user',
      content: `DRAFT:\n${draft}\n\nList the most important verifiable claims, one per line.`,
    },
  ];
}

export interface FactCheckOptions {
  draft: string;
  maxClaims: number;
  search: SearchService;
  modelId: string;
  generateFn?: typeof generateAssistantText;
  abortSignal?: AbortSignal;
  traceParent?: TracingContext;
  iteration?: number;
}

export interface FactCheckRun {
  summary: FactCheckSummary;
  llmCallsAttempted: number;
}

export async function factCheckDraft(opts: FactCheckOptions): Promise<FactCheckRun> {
  const {
    draft,
    maxClaims,
    search,
    modelId,
    generateFn = generateAssistantText,
    abortSignal,
    traceParent,
    iteration,
  } = opts;

  if (search.remaining() <= 0) {
    return {
      summary: {
        results: [],
        claimsExtracted: 0,
        searchesUsed: 0,
        budgetExhausted: true,
      },
      llmCallsAttempted: 0,
    };
  }

  let claimsText: string;
  try {
    claimsText = await generateFn(buildClaimExtractPrompt(draft, maxClaims), modelId, {
      trace: traceParent,
      generationName: 'claim-extract',
      generationMetadata: iteration !== undefined ? { iteration } : undefined,
    });
  } catch (err) {
    console.error('Claim extraction failed:', err);
    return {
      summary: {
        results: [],
        claimsExtracted: 0,
        searchesUsed: 0,
        budgetExhausted: false,
      },
      llmCallsAttempted: 1,
    };
  }
  const claims = parseClaims(claimsText, maxClaims);

  const results: FactCheckResult[] = [];
  let searchesUsed = 0;
  let budgetExhausted = false;

  for (const claim of claims) {
    if (abortSignal?.aborted) break;
    if (search.remaining() <= 0) {
      budgetExhausted = true;
      results.push({ claim, status: 'not_checked', supportingUrls: [] });
      continue;
    }
    try {
      const hits = await search.search(claim);
      searchesUsed += 1;
      const urls = hits.map((h) => h.url).filter(Boolean).slice(0, 3);
      const status: FactCheckStatus = urls.length > 0 ? 'verified' : 'unverified';
      results.push({ claim, status, supportingUrls: urls });
    } catch (err) {
      if (err instanceof SearchBudgetExhaustedError) {
        budgetExhausted = true;
        results.push({ claim, status: 'not_checked', supportingUrls: [] });
        continue;
      }
      if (err instanceof SearchProviderError) {
        searchesUsed += 1;
        results.push({ claim, status: 'unverified', supportingUrls: [] });
        continue;
      }
      console.error(`Unexpected fact-check error for "${claim}":`, err);
      results.push({ claim, status: 'unverified', supportingUrls: [] });
    }
  }

  return {
    summary: {
      results,
      claimsExtracted: claims.length,
      searchesUsed,
      budgetExhausted,
    },
    llmCallsAttempted: 1,
  };
}

export function countVerifiedClaims(summary: FactCheckSummary): number {
  return summary.results.filter((r) => r.status === 'verified').length;
}

export type SourceReliability = 'verified' | 'unknown';

export interface ReportSource {
  index: number;
  title: string;
  url: string;
  reliability: SourceReliability;
}

export interface ReportFactCheckSummary {
  totalClaimsExtracted: number;
  verifiedClaims: number;
  unverifiedClaims: number;
  notCheckedClaims: number;
}

export interface ReportMethodology {
  queries: string[];
  iterationCount: number;
  finalScores: CritiqueScores | null;
  factCheckSummary: ReportFactCheckSummary;
}

export interface StructuredReport {
  executiveSummary: string;
  keyFindings: string[];
  detailedAnalysis: string;
  sources: ReportSource[];
  methodology: ReportMethodology;
}

export interface ParsedReportSections {
  executiveSummary: string;
  keyFindings: string[];
  detailedAnalysis: string;
}

export function parseStructuredReport(text: string): ParsedReportSections | null {
  const sumMatch = text.match(/EXECUTIVE_SUMMARY\s*:\s*([\s\S]*?)(?=\n\s*KEY_FINDINGS\s*:)/i);
  const findMatch = text.match(/KEY_FINDINGS\s*:\s*([\s\S]*?)(?=\n\s*DETAILED_ANALYSIS\s*:)/i);
  const detMatch = text.match(/DETAILED_ANALYSIS\s*:\s*([\s\S]*)$/i);
  if (!sumMatch || !findMatch || !detMatch) return null;
  const executiveSummary = sumMatch[1].trim();
  const detailedAnalysis = detMatch[1].trim();
  const findingsBlock = findMatch[1].trim();
  const keyFindings: string[] = [];
  const numbered = /^\s*(?:\d+[.)]|[-*•])\s*(.+)$/;
  for (const raw of findingsBlock.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(numbered);
    const value = (m ? m[1] : line).trim();
    if (value.length > 0) keyFindings.push(value);
  }
  if (
    executiveSummary.length === 0 ||
    keyFindings.length === 0 ||
    detailedAnalysis.length === 0
  ) {
    return null;
  }
  return { executiveSummary, keyFindings, detailedAnalysis };
}

export function buildReportUserPrompt(
  topic: string,
  summary: string,
  draft: string,
  sources: SearchResult[],
): string {
  const sourceBlock = sources
    .map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`)
    .join('\n');
  return `TOPIC: ${topic}\nSCOPE: ${summary}\n\nNUMBERED SOURCES:\n${sourceBlock}\n\nFINAL DRAFT TO RESTRUCTURE:\n${draft}\n\nProduce the structured report now.`;
}

export function computeReportSources(
  sources: SearchResult[],
  iterations: CritiqueIterationRecord[],
): ReportSource[] {
  const verifiedUrls = new Set<string>();
  for (const it of iterations) {
    if (!it.factCheck) continue;
    for (const r of it.factCheck.results) {
      if (r.status === 'verified') {
        for (const u of r.supportingUrls) verifiedUrls.add(u);
      }
    }
  }
  return sources.map((s, i) => ({
    index: i + 1,
    title: s.title,
    url: s.url,
    reliability: verifiedUrls.has(s.url) ? 'verified' : 'unknown',
  }));
}

export function computeReportMethodology(
  queries: string[],
  iterations: CritiqueIterationRecord[],
  finalScores: CritiqueScores | null,
): ReportMethodology {
  let total = 0;
  let verified = 0;
  let unverified = 0;
  let notChecked = 0;
  for (const it of iterations) {
    if (!it.factCheck) continue;
    total += it.factCheck.results.length;
    for (const r of it.factCheck.results) {
      if (r.status === 'verified') verified += 1;
      else if (r.status === 'unverified') unverified += 1;
      else notChecked += 1;
    }
  }
  return {
    queries,
    iterationCount: iterations.length,
    finalScores,
    factCheckSummary: {
      totalClaimsExtracted: total,
      verifiedClaims: verified,
      unverifiedClaims: unverified,
      notCheckedClaims: notChecked,
    },
  };
}

const FALLBACK_EXECUTIVE_SUMMARY_SENTENCES = 2;

export function programmaticReportFromDraft(
  draft: string,
  sources: SearchResult[],
  iterations: CritiqueIterationRecord[],
  queries: string[],
  finalScores: CritiqueScores | null,
): StructuredReport {
  const cleaned = draft.trim();
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const executiveSummary =
    sentences.slice(0, FALLBACK_EXECUTIVE_SUMMARY_SENTENCES).join(' ') ||
    cleaned.slice(0, 240);
  const bulletLines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(?:\d+[.)]|[-*•])\s+/.test(l))
    .map((l) => l.replace(/^(?:\d+[.)]|[-*•])\s+/, '').trim());
  const keyFindings =
    bulletLines.length >= 3 ? bulletLines.slice(0, 5) : sentences.slice(0, 5);
  return {
    executiveSummary,
    keyFindings: keyFindings.length > 0 ? keyFindings : [cleaned.slice(0, 200)],
    detailedAnalysis: cleaned,
    sources: computeReportSources(sources, iterations),
    methodology: computeReportMethodology(queries, iterations, finalScores),
  };
}

export interface BuildStructuredReportOptions {
  draft: string;
  topic: string;
  summary: string;
  sources: SearchResult[];
  iterations: CritiqueIterationRecord[];
  queries: string[];
  finalScores: CritiqueScores | null;
  modelId: string;
  generateFn?: typeof generateAssistantText;
  abortSignal?: AbortSignal;
  traceParent?: TracingContext;
}

export interface BuildStructuredReportRun {
  report: StructuredReport;
  llmCallsAttempted: number;
  source: 'llm' | 'programmatic';
}

export async function buildStructuredReport(
  opts: BuildStructuredReportOptions,
): Promise<BuildStructuredReportRun> {
  const {
    draft,
    topic,
    summary,
    sources,
    iterations,
    queries,
    finalScores,
    modelId,
    generateFn = generateAssistantText,
    traceParent,
  } = opts;

  let text: string;
  try {
    text = await generateFn(
      [
        { role: 'system', content: REPORT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildReportUserPrompt(topic, summary, draft, sources),
        },
      ],
      modelId,
      { trace: traceParent, generationName: 'report-generate' },
    );
  } catch (err) {
    console.error('Report generation failed:', err);
    return {
      report: programmaticReportFromDraft(
        draft,
        sources,
        iterations,
        queries,
        finalScores,
      ),
      llmCallsAttempted: 1,
      source: 'programmatic',
    };
  }

  const parsed = parseStructuredReport(text);
  if (!parsed) {
    console.warn('Structured-report parse failed; using programmatic fallback');
    return {
      report: programmaticReportFromDraft(
        draft,
        sources,
        iterations,
        queries,
        finalScores,
      ),
      llmCallsAttempted: 1,
      source: 'programmatic',
    };
  }

  return {
    report: {
      executiveSummary: parsed.executiveSummary,
      keyFindings: parsed.keyFindings,
      detailedAnalysis: parsed.detailedAnalysis,
      sources: computeReportSources(sources, iterations),
      methodology: computeReportMethodology(queries, iterations, finalScores),
    },
    llmCallsAttempted: 1,
    source: 'llm',
  };
}

export function draftSimilarity(a: string, b: string): number {
  const tokensA = new Set(
    a.toLowerCase().split(/\s+/).filter((t) => t.length > 0),
  );
  const tokensB = new Set(
    b.toLowerCase().split(/\s+/).filter((t) => t.length > 0),
  );
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection += 1;
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

function formatCriterion(c: CritiqueCriterion): string {
  return c.replace(/_/g, ' ');
}

function buildCritiqueUserPrompt(
  topic: string,
  summary: string,
  draft: string,
  sources: SearchResult[],
  files: ResearchFile[],
): string {
  const sourceBlock = sources
    .map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`)
    .join('\n');
  return `TOPIC: ${topic}\nSCOPE: ${summary}\n\nNUMBERED SOURCES:\n${sourceBlock}${buildFileSummaryBlock(files)}\n\nDRAFT TO CRITIQUE:\n${draft}\n\nScore the draft now.`;
}

function buildFactCheckBlock(factCheck: FactCheckSummary | undefined): string {
  if (!factCheck || factCheck.results.length === 0) return '';
  const lines = factCheck.results.map((r) => {
    const label =
      r.status === 'verified'
        ? 'VERIFIED'
        : r.status === 'unverified'
          ? 'UNVERIFIED'
          : 'NOT CHECKED (budget exhausted)';
    const support =
      r.supportingUrls.length > 0 ? ` (supporting: ${r.supportingUrls.join(', ')})` : '';
    return `- [${label}] ${r.claim}${support}`;
  });
  return `\n\nFACT-CHECK RESULTS:\n${lines.join('\n')}\n\nWhen revising, remove or qualify any UNVERIFIED claim, prefer wording supported by VERIFIED claims, and flag NOT CHECKED claims as tentative.`;
}

function buildReviseUserPrompt(
  topic: string,
  summary: string,
  previousDraft: string,
  critique: string,
  scores: CritiqueScores,
  sources: SearchResult[],
  files: ResearchFile[],
  fullTextFiles: ResearchFile[],
  factCheck?: FactCheckSummary,
): string {
  const sourceBlock = sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title}\n    URL: ${s.url}\n    SNIPPET: ${s.snippet}`,
    )
    .join('\n\n');
  const scoresBlock = CRITIQUE_CRITERIA.map(
    (c) => `${c}: ${scores[c]}`,
  ).join('\n');
  return `TOPIC: ${topic}\nSCOPE: ${summary}\n\nNUMBERED SOURCES:\n${sourceBlock}${buildFileSummaryBlock(files)}${buildFullFileBlock(fullTextFiles)}\n\nPREVIOUS DRAFT:\n${previousDraft}\n\nEDITOR SCORES (1-5):\n${scoresBlock}\n\nEDITOR CRITIQUE:\n${critique}${buildFactCheckBlock(factCheck)}\n\nRewrite the draft now, addressing every issue raised.`;
}

export type RunResearchOutcome =
  | {
      kind: 'ok';
      assistantMessage: Awaited<ReturnType<typeof prisma.message.create>>;
      conversation: Awaited<ReturnType<typeof prisma.conversation.update>>;
      sources: SearchResult[];
      queries: string[];
      iterations: CritiqueIterationRecord[];
      finalScores: CritiqueScores | null;
      exitReason: ResearchExitReason;
      llmCallsUsed: number;
      report: StructuredReport;
    }
  | { kind: 'not-found' }
  | { kind: 'wrong-status' }
  | { kind: 'busy' }
  | { kind: 'insufficient-sources'; sourcesFound: number }
  | { kind: 'search-failed'; message: string }
  | { kind: 'ai-error'; message: string }
  | { kind: 'aborted' };

export interface RunResearchOptions {
  userId: string;
  conversationId: string;
  onProgress?: (progress: ResearchProgress) => void;
  searchService?: SearchService;
  abortSignal?: AbortSignal;
}

function readyMessageSummary(metadata: unknown): string | null {
  if (metadata && typeof metadata === 'object' && 'kind' in metadata) {
    const m = metadata as { kind?: unknown; summary?: unknown };
    if (m.kind === 'research_ready' && typeof m.summary === 'string') {
      return m.summary;
    }
  }
  return null;
}

async function markFailed(conversationId: string, message?: string): Promise<void> {
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { researchStatus: 'failed', updatedAt: new Date() },
    });
    if (message) {
      await prisma.message
        .create({
          data: {
            conversationId,
            role: 'assistant',
            content: message,
            metadata: {
              kind: 'research_failed',
              reason: message,
            } as Prisma.InputJsonValue,
          },
        })
        .catch((err) => console.error('Failed to persist failure message:', err));
    }
  } catch (err) {
    console.error('Failed to mark research as failed:', err);
  }
}

export async function runResearchPipeline(
  options: RunResearchOptions,
): Promise<RunResearchOutcome> {
  const { userId } = options;

  if (activeResearchUsers.has(userId)) {
    return { kind: 'busy' };
  }
  activeResearchUsers.add(userId);
  try {
    return await runResearchPipelineImpl(options);
  } finally {
    activeResearchUsers.delete(userId);
  }
}

async function runResearchPipelineImpl(
  options: RunResearchOptions,
): Promise<RunResearchOutcome> {
  const { userId, conversationId, onProgress, abortSignal } = options;

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      userId: true,
      mode: true,
      researchStatus: true,
      user: { select: { preferredModel: true, email: true } },
    },
  });
  if (!conversation || conversation.userId !== userId) {
    return { kind: 'not-found' };
  }
  if (conversation.mode !== 'research' || conversation.researchStatus !== 'researching') {
    return { kind: 'wrong-status' };
  }

  if (abortSignal?.aborted) return { kind: 'aborted' };

  const modelId = modelIdFor(conversation.user?.preferredModel);
  const userEmail = conversation.user?.email ?? null;

  const history = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true, metadata: true },
  });

  const firstUser = history.find((m) => m.role === 'user');
  const topic = firstUser?.content?.trim() ?? '';
  if (topic.length === 0) {
    await markFailed(conversationId);
    return { kind: 'wrong-status' };
  }

  let summary = topic;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i];
    if (m.role !== 'assistant') continue;
    const s = readyMessageSummary(m.metadata);
    if (s) {
      summary = s;
      break;
    }
  }

  const clarifyingAnswers: string[] = [];
  let seenFirstUser = false;
  for (const m of history) {
    if (m.role !== 'user') continue;
    if (!seenFirstUser) {
      seenFirstUser = true;
      continue;
    }
    clarifyingAnswers.push(m.content);
  }

  const fileRows = await prisma.file.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, originalName: true, summary: true, extractedText: true },
  });
  const researchFiles: ResearchFile[] = fileRows.map((f) => ({
    id: f.id,
    originalName: f.originalName,
    summary: f.summary,
    extractedText: f.extractedText,
  }));

  const maxIterations = getMaxResearchIterations();
  const maxLlmCalls = getMaxLlmCallsPerResearch();
  let llmCallsUsed = 0;
  const llmCallsRemaining = () => maxLlmCalls - llmCallsUsed;

  const trace = createResearchTrace({
    userId,
    conversationId,
    topic,
    modelId,
    clarifyingAnswers,
    scopeSummary: summary,
  });
  let traceFinalize: {
    output?: unknown;
    metadata?: Record<string, unknown>;
    exitReason?: string;
    error?: string;
  } = {};

  try {
    return await runPipelineBody();
  } finally {
    await trace.finish(traceFinalize);
  }

  async function runPipelineBody(): Promise<RunResearchOutcome> {
  onProgress?.({ stage: 'generating_queries', detail: 'Planning searches' });

  const searchSpan = trace.startSpan('searching', {
    metadata: { stage: 'searching' },
  });

  const planningMessages: LLMMessage[] = [
    { role: 'system', content: SEARCH_QUERY_GEN_PROMPT },
    {
      role: 'user',
      content: `TOPIC: ${topic}\nSCOPE: ${summary}\n\nClarifying answers:\n${
        clarifyingAnswers.length > 0
          ? clarifyingAnswers.map((a) => `- ${a}`).join('\n')
          : '(none provided)'
      }${buildFileSummaryBlock(researchFiles)}`,
    },
  ];

  let queriesText: string;
  try {
    llmCallsUsed += 1;
    queriesText = await generateAssistantText(planningMessages, modelId, {
      trace: searchSpan,
      generationName: 'plan-search-queries',
    });
  } catch (err) {
    console.error('Search-query planning failed:', err);
    searchSpan.end({
      level: 'ERROR',
      statusMessage: 'planning LLM failed',
      metadata: { error: String(err) },
    });
    traceFinalize = { error: 'planning LLM failed', exitReason: 'ai_error' };
    await markFailed(
      conversationId,
      'Research could not start because the AI provider failed while planning searches. Please try again.',
    );
    return { kind: 'ai-error', message: 'Could not plan searches.' };
  }

  if (abortSignal?.aborted) {
    searchSpan.end({ level: 'WARNING', statusMessage: 'aborted' });
    traceFinalize = { exitReason: 'aborted' };
    return { kind: 'aborted' };
  }

  const queries = parseSearchQueries(queriesText);
  const requestedFiles = matchRequestedFiles(
    parseRequestedFiles(queriesText),
    researchFiles,
  );
  if (queries.length === 0) {
    searchSpan.end({
      level: 'ERROR',
      statusMessage: 'no queries produced',
      metadata: { queriesText },
    });
    traceFinalize = { error: 'no queries produced', exitReason: 'ai_error' };
    await markFailed(
      conversationId,
      'Research could not start because the AI provider did not return any search queries. Please rephrase the topic and try again.',
    );
    return { kind: 'ai-error', message: 'Could not plan searches.' };
  }

  const search = options.searchService ?? createSearchService();
  const sources: SearchResult[] = [];
  const seenUrls = new Set<string>();
  let providerErrors = 0;

  for (const query of queries) {
    if (abortSignal?.aborted) {
      searchSpan.end({ level: 'WARNING', statusMessage: 'aborted' });
      traceFinalize = { exitReason: 'aborted' };
      return { kind: 'aborted' };
    }
    onProgress?.({
      stage: 'searching',
      detail: `Searching for: ${query}`,
      query,
    });
    try {
      const results = await search.search(query);
      for (const r of results) {
        if (!seenUrls.has(r.url)) {
          seenUrls.add(r.url);
          sources.push(r);
        }
      }
    } catch (err) {
      if (err instanceof SearchBudgetExhaustedError) break;
      if (err instanceof SearchProviderError) {
        providerErrors += 1;
        console.error(`Search providers failed for "${query}":`, err);
        continue;
      }
      console.error(`Unexpected search error for "${query}":`, err);
      providerErrors += 1;
    }
  }

  if (sources.length < MIN_SOURCES_REQUIRED) {
    if (providerErrors >= queries.length) {
      searchSpan.end({
        level: 'ERROR',
        statusMessage: 'all search providers failed',
        metadata: { queries, providerErrors, sourcesFound: sources.length },
      });
      traceFinalize = {
        error: 'all search providers failed',
        exitReason: 'search_failed',
      };
      await markFailed(
        conversationId,
        'Research failed: every web search provider returned an error. Please try again later.',
      );
      return {
        kind: 'search-failed',
        message: 'All web search providers failed. Please try again later.',
      };
    }
    searchSpan.end({
      level: 'ERROR',
      statusMessage: 'insufficient sources',
      metadata: { queries, providerErrors, sourcesFound: sources.length },
    });
    traceFinalize = {
      error: 'insufficient sources',
      exitReason: 'insufficient_sources',
    };
    await markFailed(
      conversationId,
      `Research could not produce a draft because only ${sources.length} source(s) were gathered. Please rephrase the topic and try again.`,
    );
    return { kind: 'insufficient-sources', sourcesFound: sources.length };
  }

  searchSpan.end({
    metadata: {
      queries,
      sourcesFound: sources.length,
      providerErrors,
      minSourceThreshold: MIN_SOURCES_REQUIRED,
    },
    output: { sources },
  });

  onProgress?.({
    stage: 'analyzing_sources',
    detail: `Analyzing ${sources.length} sources`,
    sourcesFound: sources.length,
  });

  if (abortSignal?.aborted) {
    traceFinalize = { exitReason: 'aborted' };
    return { kind: 'aborted' };
  }

  onProgress?.({ stage: 'writing_draft', detail: 'Writing first draft' });

  const draftingSpan = trace.startSpan('drafting');
  let currentDraft: string;
  try {
    llmCallsUsed += 1;
    currentDraft = await generateAssistantText(
      [
        { role: 'system', content: DRAFT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildDraftUserPrompt(
            topic,
            summary,
            sources,
            researchFiles,
            requestedFiles,
          ),
        },
      ],
      modelId,
      { trace: draftingSpan, generationName: 'draft-generate' },
    );
  } catch (err) {
    console.error('Draft generation failed:', err);
    draftingSpan.end({
      level: 'ERROR',
      statusMessage: 'draft LLM failed',
      metadata: { error: String(err) },
    });
    traceFinalize = { error: 'draft LLM failed', exitReason: 'ai_error' };
    await markFailed(
      conversationId,
      'Research failed: the AI provider could not write the first draft. Please try again.',
    );
    return { kind: 'ai-error', message: 'Could not write the draft.' };
  }
  draftingSpan.end({
    metadata: { draftLength: currentDraft.length, sourcesUsed: sources.length },
  });

  const documentsUsed = researchFiles.map((f) => ({
    id: f.id,
    originalName: f.originalName,
    hadSummary: !!f.summary,
    fullTextIncluded: requestedFiles.some((r) => r.id === f.id),
  }));

  const iterations: CritiqueIterationRecord[] = [];
  let finalScores: CritiqueScores | null = null;
  let exitReason: ResearchExitReason = 'iterations_exhausted';

  for (let i = 1; i <= maxIterations; i += 1) {
    if (abortSignal?.aborted) {
      traceFinalize = { exitReason: 'aborted' };
      return { kind: 'aborted' };
    }

    if (llmCallsRemaining() < 1) {
      exitReason = 'budget_exhausted';
      break;
    }

    onProgress?.({
      stage: 'critiquing',
      detail: `Critique round ${i} of ${maxIterations} — scoring the draft`,
      iteration: i,
      maxIterations,
    });

    const critiqueSpan = trace.startSpan('critiquing', {
      metadata: { iteration: i, maxIterations },
    });
    let critiqueText: string;
    try {
      llmCallsUsed += 1;
      critiqueText = await generateAssistantText(
        [
          { role: 'system', content: CRITIQUE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildCritiqueUserPrompt(
              topic,
              summary,
              currentDraft,
              sources,
              researchFiles,
            ),
          },
        ],
        modelId,
        {
          trace: critiqueSpan,
          generationName: 'critique-generate',
          generationMetadata: { iteration: i },
        },
      );
    } catch (err) {
      console.error(`Critique generation failed at iteration ${i}:`, err);
      critiqueSpan.end({
        level: 'ERROR',
        statusMessage: 'critique LLM failed',
        metadata: { iteration: i, error: String(err) },
      });
      traceFinalize = { error: 'critique LLM failed', exitReason: 'ai_error' };
      await markFailed(
        conversationId,
        'Research failed: the AI provider could not critique the draft. Please try again.',
      );
      return { kind: 'ai-error', message: 'Could not critique the draft.' };
    }

    const parsed = parseCritique(critiqueText);
    if (!parsed) {
      console.error(`Critique parse failed at iteration ${i}: ${critiqueText}`);
      critiqueSpan.end({
        level: 'ERROR',
        statusMessage: 'critique parse failed',
        metadata: { iteration: i },
      });
      exitReason = 'critique_parse_failed';
      break;
    }

    const weakest = weakestCriteria(parsed.scores);
    const record: CritiqueIterationRecord = {
      iteration: i,
      scores: parsed.scores,
      critique: parsed.critique,
      weakest,
      revised: false,
    };
    iterations.push(record);
    finalScores = parsed.scores;
    critiqueSpan.end({
      metadata: { iteration: i, scores: parsed.scores, weakest },
      output: { scores: parsed.scores, critique: parsed.critique },
    });

    if (allCriteriaPassed(parsed.scores)) {
      exitReason = 'all_passed';
      break;
    }

    if (i >= maxIterations) {
      exitReason = 'iterations_exhausted';
      break;
    }

    if (llmCallsRemaining() < 1) {
      exitReason = 'budget_exhausted';
      break;
    }

    if (abortSignal?.aborted) {
      traceFinalize = { exitReason: 'aborted' };
      return { kind: 'aborted' };
    }

    let factCheckSummary: FactCheckSummary | undefined;
    if (search.remaining() > 0) {
      onProgress?.({
        stage: 'fact_checking',
        detail: `Fact-check round ${i} — extracting claims`,
        iteration: i,
        maxIterations,
      });
      const factCheckSpan = trace.startSpan('fact-checking', {
        metadata: { iteration: i },
      });
      const fc = await factCheckDraft({
        draft: currentDraft,
        maxClaims: getMaxFactCheckClaims(),
        search,
        modelId,
        abortSignal,
        traceParent: factCheckSpan,
        iteration: i,
      });
      llmCallsUsed += fc.llmCallsAttempted;
      if (fc.llmCallsAttempted > 0) {
        factCheckSummary = fc.summary;
        record.factCheck = factCheckSummary;
        const verified = countVerifiedClaims(fc.summary);
        onProgress?.({
          stage: 'fact_checking',
          detail: `Fact-check round ${i} — ${verified}/${fc.summary.results.length} claim(s) verified`,
          iteration: i,
          maxIterations,
          claimsExtracted: fc.summary.claimsExtracted,
          claimsVerified: verified,
        });
        factCheckSpan.end({
          metadata: {
            iteration: i,
            claimsExtracted: fc.summary.claimsExtracted,
            claimsVerified: verified,
            searchesUsed: fc.summary.searchesUsed,
            budgetExhausted: fc.summary.budgetExhausted,
          },
          output: { results: fc.summary.results },
        });
      } else {
        factCheckSpan.end({
          metadata: { iteration: i, skipped: true, reason: 'no LLM call made' },
        });
      }

      if (abortSignal?.aborted) {
        traceFinalize = { exitReason: 'aborted' };
        return { kind: 'aborted' };
      }

      if (llmCallsRemaining() < 1) {
        exitReason = 'budget_exhausted';
        break;
      }
    }

    onProgress?.({
      stage: 'revising',
      detail: `Revision ${i} of ${maxIterations - 1} — improving ${weakest
        .map(formatCriterion)
        .join(', ')}`,
      iteration: i,
      maxIterations,
      weakestCriteria: weakest,
      scores: parsed.scores,
    });

    const reviseSpan = trace.startSpan('revising', {
      metadata: { iteration: i, weakest },
    });
    let revisedDraft: string;
    try {
      llmCallsUsed += 1;
      revisedDraft = await generateAssistantText(
        [
          { role: 'system', content: REVISE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: buildReviseUserPrompt(
              topic,
              summary,
              currentDraft,
              parsed.critique,
              parsed.scores,
              sources,
              researchFiles,
              requestedFiles,
              factCheckSummary,
            ),
          },
        ],
        modelId,
        {
          trace: reviseSpan,
          generationName: 'revise-generate',
          generationMetadata: { iteration: i },
        },
      );
    } catch (err) {
      console.error(`Revision generation failed at iteration ${i}:`, err);
      reviseSpan.end({
        level: 'ERROR',
        statusMessage: 'revise LLM failed',
        metadata: { iteration: i, error: String(err) },
      });
      traceFinalize = { error: 'revise LLM failed', exitReason: 'ai_error' };
      await markFailed(
        conversationId,
        'Research failed: the AI provider could not revise the draft. Please try again.',
      );
      return { kind: 'ai-error', message: 'Could not revise the draft.' };
    }

    record.revised = true;
    const similarity = draftSimilarity(currentDraft, revisedDraft);
    currentDraft = revisedDraft;
    reviseSpan.end({
      metadata: { iteration: i, similarity, draftLength: revisedDraft.length },
    });
    if (similarity >= CONVERGENCE_SIMILARITY_THRESHOLD) {
      exitReason = 'converged';
      break;
    }
  }

  const finalizingSpan = trace.startSpan('finalizing', {
    metadata: { exitReason, iterationCount: iterations.length },
  });
  let structuredReport: StructuredReport;
  let reportSource: 'llm' | 'programmatic' = 'programmatic';
  if (llmCallsRemaining() >= 1 && !abortSignal?.aborted) {
    onProgress?.({ stage: 'finalizing', detail: 'Structuring the final report' });
    const reportRun = await buildStructuredReport({
      draft: currentDraft,
      topic,
      summary,
      sources,
      iterations,
      queries,
      finalScores,
      modelId,
      abortSignal,
      traceParent: finalizingSpan,
    });
    llmCallsUsed += reportRun.llmCallsAttempted;
    structuredReport = reportRun.report;
    reportSource = reportRun.source;
  } else {
    structuredReport = programmaticReportFromDraft(
      currentDraft,
      sources,
      iterations,
      queries,
      finalScores,
    );
  }
  finalizingSpan.end({
    metadata: {
      exitReason,
      iterationCount: iterations.length,
      reportSource,
      sourceCount: structuredReport.sources.length,
      keyFindingsCount: structuredReport.keyFindings.length,
    },
  });

  const finalMetadata: Record<string, unknown> = {
    kind: 'research_final',
    queries,
    sources,
    documents: documentsUsed,
    iterations: iterations.map((it) => ({
      iteration: it.iteration,
      scores: it.scores,
      critique: it.critique,
      weakest: it.weakest,
      revised: it.revised,
      ...(it.factCheck ? { factCheck: it.factCheck } : {}),
    })),
    finalScores,
    iterationCount: iterations.length,
    exitReason,
    llmCallsUsed,
    report: structuredReport,
  };

  const assistantMessage = await prisma.message.create({
    data: {
      conversationId,
      role: 'assistant',
      content: currentDraft,
      metadata: finalMetadata as Prisma.InputJsonValue,
    },
  });

  const updatedConversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { researchStatus: 'complete', updatedAt: new Date() },
  });

  const emailTopic = updatedConversation.title || topic;
  if (userEmail) {
    sendResearchCompleteEmail({
      email: userEmail,
      conversationId,
      topic: emailTopic,
      report: structuredReport,
    }).catch((err) => console.error('Research-complete email failed:', err));
  }

  traceFinalize = {
    exitReason,
    output: {
      exitReason,
      iterationCount: iterations.length,
      llmCallsUsed,
      sourceCount: sources.length,
      queriesCount: queries.length,
      finalScores,
    },
    metadata: {
      exitReason,
      iterationCount: iterations.length,
      llmCallsUsed,
      sourceCount: sources.length,
    },
  };

  return {
    kind: 'ok',
    assistantMessage,
    conversation: updatedConversation,
    sources,
    queries,
    iterations,
    finalScores,
    exitReason,
    llmCallsUsed,
    report: structuredReport,
  };
  }
}

export interface ResearchFinalRecord {
  conversationId: string;
  draft: string;
  report: StructuredReport;
  topic: string;
}

export async function getLatestResearchFinal(
  userId: string,
  conversationId: string,
): Promise<ResearchFinalRecord | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, userId: true, title: true },
  });
  if (!conversation || conversation.userId !== userId) return null;

  const messages = await prisma.message.findMany({
    where: { conversationId, role: 'assistant' },
    orderBy: { createdAt: 'desc' },
    select: { content: true, metadata: true },
  });
  for (const m of messages) {
    const md = m.metadata;
    if (!md || typeof md !== 'object') continue;
    const kind = (md as { kind?: unknown }).kind;
    if (kind !== 'research_final') continue;
    const report = (md as { report?: unknown }).report;
    if (!report || typeof report !== 'object') continue;
    return {
      conversationId,
      draft: m.content,
      report: report as StructuredReport,
      topic: conversation.title,
    };
  }
  return null;
}
