import { prisma } from '../lib/db';
import { generateAssistantText } from './ai';
import { DEFAULT_MODEL_ID, isSupportedModel } from './models';
import type { LLMMessage } from './context';
import {
  createSearchService,
  SearchBudgetExhaustedError,
  SearchProviderError,
  type SearchResult,
  type SearchService,
} from './search';

export const CLARIFYING_QUESTION_COUNT = 4;
export const MIN_SOURCES_REQUIRED = 3;
export const MAX_SEARCH_QUERIES = 5;

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

const SEARCH_QUERY_GEN_PROMPT = `You are a research planning assistant. The user has provided a topic and answered clarifying questions. Generate 3 to ${MAX_SEARCH_QUERIES} distinct, high-signal web search queries that, when combined, will surface the most relevant sources for the agreed research scope. Respond with one query per line. No numbering, no quotes, no preamble.`;

const DRAFT_SYSTEM_PROMPT = `You are a research analyst writing a balanced, evidence-based first draft. Use ONLY the supplied sources. Cite sources inline using bracketed numbers like [1], [2] that correspond to the numbered source list. Aim for 500-800 words. Structure the draft with: a one-paragraph introduction, 3-5 key findings as a bulleted or numbered list with citations, and a brief conclusion. Do not invent facts; if the sources are silent on a sub-question, say so.`;

export function parseSearchQueries(text: string): string[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const numbered = /^\s*(?:\d+[.)]|[-*•])\s*(.+)$/;
  const queries: string[] = [];
  for (const line of lines) {
    const match = line.match(numbered);
    const value = (match ? match[1] : line).trim();
    const stripped = value.replace(/^["'`]+|["'`]+$/g, '').trim();
    if (stripped.length > 0) queries.push(stripped);
  }
  return queries.slice(0, MAX_SEARCH_QUERIES);
}

function buildDraftUserPrompt(
  topic: string,
  summary: string,
  sources: SearchResult[],
): string {
  const sourceBlock = sources
    .map(
      (s, i) =>
        `[${i + 1}] ${s.title}\n    URL: ${s.url}\n    SNIPPET: ${s.snippet}`,
    )
    .join('\n\n');
  return `TOPIC: ${topic}\nSCOPE: ${summary}\n\nNUMBERED SOURCES:\n${sourceBlock}\n\nWrite the first draft now.`;
}

export type ResearchProgressStage =
  | 'generating_queries'
  | 'searching'
  | 'analyzing_sources'
  | 'writing_draft';

export interface ResearchProgress {
  stage: ResearchProgressStage;
  detail?: string;
  query?: string;
  sourcesFound?: number;
}

export type RunResearchOutcome =
  | {
      kind: 'ok';
      assistantMessage: Awaited<ReturnType<typeof prisma.message.create>>;
      conversation: Awaited<ReturnType<typeof prisma.conversation.update>>;
      sources: SearchResult[];
      queries: string[];
    }
  | { kind: 'not-found' }
  | { kind: 'wrong-status' }
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

async function markFailed(conversationId: string): Promise<void> {
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { researchStatus: 'failed', updatedAt: new Date() },
    });
  } catch (err) {
    console.error('Failed to mark research as failed:', err);
  }
}

export async function runResearchPipeline(
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
      user: { select: { preferredModel: true } },
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

  onProgress?.({ stage: 'generating_queries', detail: 'Planning searches' });

  const planningMessages: LLMMessage[] = [
    { role: 'system', content: SEARCH_QUERY_GEN_PROMPT },
    {
      role: 'user',
      content: `TOPIC: ${topic}\nSCOPE: ${summary}\n\nClarifying answers:\n${
        clarifyingAnswers.length > 0
          ? clarifyingAnswers.map((a) => `- ${a}`).join('\n')
          : '(none provided)'
      }`,
    },
  ];

  let queriesText: string;
  try {
    queriesText = await generateAssistantText(planningMessages, modelId);
  } catch (err) {
    console.error('Search-query planning failed:', err);
    await markFailed(conversationId);
    return { kind: 'ai-error', message: 'Could not plan searches.' };
  }

  if (abortSignal?.aborted) return { kind: 'aborted' };

  const queries = parseSearchQueries(queriesText);
  if (queries.length === 0) {
    await markFailed(conversationId);
    return { kind: 'ai-error', message: 'Could not plan searches.' };
  }

  const search = options.searchService ?? createSearchService();
  const sources: SearchResult[] = [];
  const seenUrls = new Set<string>();
  let providerErrors = 0;

  for (const query of queries) {
    if (abortSignal?.aborted) return { kind: 'aborted' };
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
    await markFailed(conversationId);
    if (providerErrors >= queries.length) {
      return {
        kind: 'search-failed',
        message: 'All web search providers failed. Please try again later.',
      };
    }
    return { kind: 'insufficient-sources', sourcesFound: sources.length };
  }

  onProgress?.({
    stage: 'analyzing_sources',
    detail: `Analyzing ${sources.length} sources`,
    sourcesFound: sources.length,
  });

  if (abortSignal?.aborted) return { kind: 'aborted' };

  onProgress?.({ stage: 'writing_draft', detail: 'Writing first draft' });

  let draftText: string;
  try {
    draftText = await generateAssistantText(
      [
        { role: 'system', content: DRAFT_SYSTEM_PROMPT },
        { role: 'user', content: buildDraftUserPrompt(topic, summary, sources) },
      ],
      modelId,
    );
  } catch (err) {
    console.error('Draft generation failed:', err);
    await markFailed(conversationId);
    return { kind: 'ai-error', message: 'Could not write the draft.' };
  }

  const assistantMessage = await prisma.message.create({
    data: {
      conversationId,
      role: 'assistant',
      content: draftText,
      metadata: {
        kind: 'research_draft',
        queries,
        sources,
      },
    },
  });

  const updatedConversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { researchStatus: 'complete', updatedAt: new Date() },
  });

  return {
    kind: 'ok',
    assistantMessage,
    conversation: updatedConversation,
    sources,
    queries,
  };
}
