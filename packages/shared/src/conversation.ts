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

export type MessageMetadata =
  | { kind: 'clarifying_questions'; questions: string[] }
  | { kind: 'research_ready'; summary?: string }
  | { kind: string; [key: string]: unknown };

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
