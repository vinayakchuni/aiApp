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

export type MessageMetadata =
  | { kind: 'clarifying_questions'; questions: string[] }
  | { kind: 'research_ready'; summary?: string }
  | {
      kind: 'research_draft';
      queries: string[];
      sources: ResearchSource[];
      documents?: ResearchDocumentUsage[];
    }
  | { kind: string; [key: string]: unknown };

export type ResearchProgressStage =
  | 'generating_queries'
  | 'searching'
  | 'analyzing_sources'
  | 'writing_draft';

export interface ResearchProgressEvent {
  stage: ResearchProgressStage;
  detail?: string;
  query?: string;
  sourcesFound?: number;
}

export interface ResearchCompleteEvent {
  conversation: Conversation;
  assistantMessage: Message;
}

export interface ResearchFailedEvent {
  code:
    | 'NOT_FOUND'
    | 'WRONG_STATUS'
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
