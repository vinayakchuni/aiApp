export type MessageRole = 'user' | 'assistant' | 'system';

export type ConversationMode = 'chat' | 'research';

export type ResearchStatus =
  | 'idle'
  | 'clarifying'
  | 'researching'
  | 'drafting'
  | 'critiquing'
  | 'fact_checking'
  | 'finalizing'
  | 'complete'
  | 'failed';

export interface ResearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface ResearchDocumentUsage {
  id: string;
  originalName: string;
  hadSummary: boolean;
  fullTextIncluded: boolean;
}

export type CritiqueCriterion =
  | 'factual_accuracy'
  | 'completeness'
  | 'source_coverage'
  | 'coherence'
  | 'scope_alignment';

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

export type MessageMetadata =
  | { kind: 'clarifying_questions'; questions: string[] }
  | { kind: 'research_ready'; summary?: string }
  | {
      kind: 'research_draft';
      queries: string[];
      sources: ResearchSource[];
      documents?: ResearchDocumentUsage[];
    }
  | {
      kind: 'research_final';
      queries: string[];
      sources: ResearchSource[];
      documents?: ResearchDocumentUsage[];
      iterations: CritiqueIterationRecord[];
      finalScores: CritiqueScores | null;
      iterationCount: number;
      exitReason: ResearchExitReason;
      llmCallsUsed: number;
      report?: StructuredReport;
    }
  | { kind: 'research_failed'; reason: string }
  | { kind: string; [key: string]: unknown };

export type ResearchProgressStage =
  | 'generating_queries'
  | 'searching'
  | 'analyzing_sources'
  | 'writing_draft'
  | 'critiquing'
  | 'fact_checking'
  | 'revising'
  | 'finalizing';

export interface ResearchProgressEvent {
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

export interface ResearchCompleteEvent {
  conversation: Conversation;
  assistantMessage: Message;
}

export interface ResearchFailedEvent {
  code:
    | 'NOT_FOUND'
    | 'WRONG_STATUS'
    | 'RESEARCH_BUSY'
    | 'INSUFFICIENT_SOURCES'
    | 'SEARCH_FAILED'
    | 'AI_ERROR';
  message: string;
  sourcesFound?: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata?: MessageMetadata | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  mode: ConversationMode;
  researchStatus: ResearchStatus;
  createdAt: string;
  updatedAt: string;
}

import type { ConversationFile } from './file';

export interface ConversationWithMessages extends Conversation {
  messages: Message[];
  files: ConversationFile[];
}

export interface CreateConversationRequest {
  title?: string;
  mode?: ConversationMode;
}

export interface UpdateConversationRequest {
  title?: string;
  mode?: ConversationMode;
}

export interface SendMessageRequest {
  content: string;
}

export interface SendMessageResponse {
  success: boolean;
  userMessage: Message;
  assistantMessage: Message;
}

export interface StartResearchRequest {
  topic: string;
}

export interface StartResearchResponse {
  success: boolean;
  conversation: Conversation;
  userMessage: Message;
  assistantMessage: Message;
}
