'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Conversation,
  ConversationFile,
  ConversationMode,
  ConversationWithMessages,
  Message,
  ResearchCompleteEvent,
  ResearchFailedEvent,
  ResearchProgressEvent,
  UserResponse,
  UserSettingsResponse,
} from '@ai-app/shared';
import { apiDelete, apiGet, apiPatch, apiPost, apiUpload, isRateLimited, RATE_LIMIT_MESSAGE, readSseEvents } from '../lib/api';
import { SettingsModal } from '../components/SettingsModal';
import { MarkdownMessage } from '../components/MarkdownMessage';

const DEFAULT_CONVERSATION_TITLE = 'New conversation';
const AUTO_TITLE_MAX_LENGTH = 50;

interface Toast {
  id: number;
  message: string;
  type: 'error' | 'info';
}

let toastCounter = 0;

function stageLabel(stage: ResearchProgressEvent['stage']): string {
  switch (stage) {
    case 'generating_queries':
      return 'Planning searches...';
    case 'searching':
      return 'Searching the web...';
    case 'analyzing_sources':
      return 'Analyzing sources...';
    case 'writing_draft':
      return 'Writing first draft...';
    case 'critiquing':
      return 'Critiquing the draft...';
    case 'revising':
      return 'Revising the draft...';
  }
}

export default function Home() {
  const [user, setUser] = useState<UserResponse | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] =
    useState<ConversationWithMessages | null>(null);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [settings, setSettings] = useState<UserSettingsResponse | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [conversationFull, setConversationFull] = useState(false);
  const [researchProgress, setResearchProgress] = useState<ResearchProgressEvent | null>(null);
  const [expandedSummaryIds, setExpandedSummaryIds] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const researchAbortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const userScrolledUpRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // --- Toast helpers ---
  const addToast = useCallback((message: string, type: 'error' | 'info' = 'error') => {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // --- Smart auto-scroll ---
  const scrollToBottom = useCallback(() => {
    if (!userScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    userScrolledUpRef.current = distanceFromBottom > 80;
  }, []);

  useEffect(() => {
    apiGet('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.user) setUser(data.user);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    apiGet('/api/users/settings')
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setSettings(data.settings as UserSettingsResponse);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    apiGet('/api/conversations')
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setConversations(data.conversations as Conversation[]);
          if (data.conversations.length > 0) {
            setActiveId((current) => current ?? data.conversations[0].id);
          }
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (!activeId) {
      setActiveConversation(null);
      setConversationFull(false);
      return;
    }

    apiGet(`/api/conversations/${activeId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setActiveConversation(data.conversation as ConversationWithMessages);
          setConversationFull(false);
        }
      })
      .catch(console.error);
  }, [activeId]);

  const lastMessageContent =
    activeConversation?.messages[activeConversation.messages.length - 1]?.content;

  useEffect(() => {
    scrollToBottom();
  }, [activeConversation?.messages.length, lastMessageContent, scrollToBottom]);

  // Poll for file summaries while there are unanalyzed files in a research conversation.
  useEffect(() => {
    if (!activeId || !activeConversation) return;
    if (activeConversation.mode !== 'research') return;
    const pending = activeConversation.files.some((f) => f.summary === null);
    if (!pending) return;
    const handle = window.setTimeout(() => {
      apiGet(`/api/conversations/${activeId}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.success) {
            setActiveConversation((prev) =>
              prev && prev.id === activeId
                ? { ...prev, files: (data.conversation as ConversationWithMessages).files }
                : prev,
            );
          }
        })
        .catch(console.error);
    }, 3000);
    return () => window.clearTimeout(handle);
  }, [activeId, activeConversation]);

  function handleStopGenerating() {
    abortControllerRef.current?.abort();
  }

  async function handleNewConversation(mode: ConversationMode = 'chat') {
    const res = await apiPost('/api/conversations', mode === 'chat' ? {} : { mode });
    const data = await res.json();
    if (data.success) {
      const conversation = data.conversation as Conversation;
      setConversations((prev) => [conversation, ...prev]);
      setActiveId(conversation.id);
      setSidebarOpen(false);
    }
  }

  async function toggleResearchMode() {
    if (!activeId || !activeConversation) return;
    if (activeConversation.messages.length > 0) return;
    const nextMode: ConversationMode =
      activeConversation.mode === 'research' ? 'chat' : 'research';
    const previous = activeConversation;
    setActiveConversation((prev) =>
      prev && prev.id === activeId ? { ...prev, mode: nextMode, researchStatus: 'idle' } : prev,
    );
    const res = await apiPatch(`/api/conversations/${activeId}`, { mode: nextMode });
    if (!res.ok) {
      setActiveConversation(previous);
      const data = await res.json().catch(() => ({}));
      addToast(data?.error || 'Could not change mode.');
      return;
    }
    const data = await res.json();
    if (data.success && data.conversation) {
      const updated = data.conversation as Conversation;
      setActiveConversation((prev) =>
        prev && prev.id === activeId
          ? { ...prev, mode: updated.mode, researchStatus: updated.researchStatus }
          : prev,
      );
      setConversations((prev) =>
        prev.map((c) => (c.id === activeId ? { ...c, mode: updated.mode, researchStatus: updated.researchStatus } : c)),
      );
    }
  }

  async function handleSendResearchTopic(topic: string) {
    if (!activeId) return;
    const optimisticId = `optimistic-user-${Date.now()}`;
    const optimisticMessage: Message = {
      id: optimisticId,
      conversationId: activeId,
      role: 'user',
      content: topic,
      createdAt: new Date().toISOString(),
    };
    setActiveConversation((prev) =>
      prev ? { ...prev, messages: [...prev.messages, optimisticMessage] } : prev,
    );
    setDraft('');
    setIsSending(true);
    try {
      const res = await apiPost(`/api/conversations/${activeId}/research`, { topic });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setActiveConversation((prev) =>
          prev ? { ...prev, messages: prev.messages.filter((m) => m.id !== optimisticId) } : prev,
        );
        addToast(data?.error || 'Could not start research.');
        return;
      }
      const userMessage = data.userMessage as Message;
      const assistantMessage = data.assistantMessage as Message;
      const updatedConv = data.conversation as Conversation;
      setActiveConversation((prev) =>
        prev
          ? {
              ...prev,
              mode: updatedConv.mode,
              researchStatus: updatedConv.researchStatus,
              messages: [
                ...prev.messages.filter((m) => m.id !== optimisticId),
                userMessage,
                assistantMessage,
              ],
            }
          : prev,
      );
      setConversations((prev) => {
        const others = prev.filter((c) => c.id !== activeId);
        const current = prev.find((c) => c.id === activeId);
        if (!current) return prev;
        const nextTitle =
          current.title === DEFAULT_CONVERSATION_TITLE
            ? topic.slice(0, AUTO_TITLE_MAX_LENGTH) || current.title
            : current.title;
        return [
          {
            ...current,
            title: nextTitle,
            mode: updatedConv.mode,
            researchStatus: updatedConv.researchStatus,
            updatedAt: new Date().toISOString(),
          },
          ...others,
        ];
      });
    } catch (err) {
      console.error(err);
      setActiveConversation((prev) =>
        prev ? { ...prev, messages: prev.messages.filter((m) => m.id !== optimisticId) } : prev,
      );
      addToast('Network error. Please try again.');
    } finally {
      setIsSending(false);
    }
  }

  async function runResearchPipeline(conversationId: string) {
    if (researchAbortRef.current) return;
    const abortController = new AbortController();
    researchAbortRef.current = abortController;
    setResearchProgress({ stage: 'generating_queries', detail: 'Planning searches' });

    const placeholderId = `research-placeholder-${Date.now()}`;
    const placeholder: Message = {
      id: placeholderId,
      conversationId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    };
    setActiveConversation((prev) =>
      prev && prev.id === conversationId
        ? { ...prev, messages: [...prev.messages, placeholder] }
        : prev,
    );

    const removePlaceholder = () =>
      setActiveConversation((prev) =>
        prev && prev.id === conversationId
          ? { ...prev, messages: prev.messages.filter((m) => m.id !== placeholderId) }
          : prev,
      );

    try {
      const res = await apiPost(
        `/api/conversations/${conversationId}/research/run`,
        undefined,
        abortController.signal,
      );

      if (!res.ok) {
        removePlaceholder();
        addToast('Could not start research. Please try again.');
        setResearchProgress(null);
        return;
      }

      let assistantMessage: Message | null = null;
      let updatedConversation: Conversation | null = null;
      let receivedFailure = false;

      for await (const evt of readSseEvents(res)) {
        if (evt.event === 'research-progress') {
          setResearchProgress(evt.data as ResearchProgressEvent);
        } else if (evt.event === 'research-complete') {
          const payload = evt.data as ResearchCompleteEvent;
          assistantMessage = payload.assistantMessage;
          updatedConversation = payload.conversation;
        } else if (evt.event === 'research-failed') {
          receivedFailure = true;
          const payload = evt.data as ResearchFailedEvent;
          addToast(payload.message || 'Research failed.');
        }
      }

      if (assistantMessage && !receivedFailure) {
        const finalAssistant = assistantMessage;
        setActiveConversation((prev) =>
          prev && prev.id === conversationId
            ? {
                ...prev,
                ...(updatedConversation
                  ? {
                      mode: updatedConversation.mode,
                      researchStatus: updatedConversation.researchStatus,
                    }
                  : {}),
                messages: prev.messages.map((m) =>
                  m.id === placeholderId ? finalAssistant : m,
                ),
              }
            : prev,
        );
        if (updatedConversation) {
          setConversations((prev) =>
            prev.map((c) =>
              c.id === conversationId
                ? {
                    ...c,
                    mode: updatedConversation!.mode,
                    researchStatus: updatedConversation!.researchStatus,
                    updatedAt: new Date().toISOString(),
                  }
                : c,
            ),
          );
        }
      } else {
        removePlaceholder();
        if (!receivedFailure) {
          addToast('Research ended unexpectedly. Please try again.');
        }
        // Refresh conversation so status reflects server-side 'failed'
        try {
          const refreshed = await apiGet(`/api/conversations/${conversationId}`)
            .then((r) => r.json())
            .catch(() => null);
          if (refreshed?.success) {
            setActiveConversation(refreshed.conversation as ConversationWithMessages);
          }
        } catch (err) {
          console.error(err);
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        removePlaceholder();
      } else {
        console.error(err);
        removePlaceholder();
        addToast('Network error during research. Please try again.');
      }
    } finally {
      researchAbortRef.current = null;
      setResearchProgress(null);
    }
  }

  async function handleSendClarifyingAnswer(content: string) {
    if (!activeId) return;
    const optimisticId = `optimistic-user-${Date.now()}`;
    const optimisticMessage: Message = {
      id: optimisticId,
      conversationId: activeId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    setActiveConversation((prev) =>
      prev ? { ...prev, messages: [...prev.messages, optimisticMessage] } : prev,
    );
    setDraft('');
    setIsSending(true);
    try {
      const res = await apiPost(
        `/api/conversations/${activeId}/messages?stream=false`,
        { content },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setActiveConversation((prev) =>
          prev ? { ...prev, messages: prev.messages.filter((m) => m.id !== optimisticId) } : prev,
        );
        addToast(data?.error || 'Could not send answer.');
        return;
      }
      const userMessage = data.userMessage as Message;
      const assistantMessage = data.assistantMessage as Message;
      const updatedConv = data.conversation as Conversation | undefined;
      const conversationId = activeId;
      setActiveConversation((prev) =>
        prev
          ? {
              ...prev,
              ...(updatedConv
                ? { mode: updatedConv.mode, researchStatus: updatedConv.researchStatus }
                : {}),
              messages: [
                ...prev.messages.filter((m) => m.id !== optimisticId),
                userMessage,
                assistantMessage,
              ],
            }
          : prev,
      );
      if (data.kind === 'ready' && conversationId) {
        void runResearchPipeline(conversationId);
      }
    } catch (err) {
      console.error(err);
      setActiveConversation((prev) =>
        prev ? { ...prev, messages: prev.messages.filter((m) => m.id !== optimisticId) } : prev,
      );
      addToast('Network error. Please try again.');
    } finally {
      setIsSending(false);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !activeId || isSending) return;

    if (activeConversation?.mode === 'research') {
      if (activeConversation.researchStatus === 'idle') {
        await handleSendResearchTopic(content);
        return;
      }
      if (activeConversation.researchStatus === 'clarifying') {
        await handleSendClarifyingAnswer(content);
        return;
      }
    }

    setIsSending(true);
    setConversationFull(false);
    const ts = Date.now();
    const optimisticUserId = `optimistic-user-${ts}`;
    const streamingAssistantId = `streaming-assistant-${ts}`;
    const optimisticUserMessage: Message = {
      id: optimisticUserId,
      conversationId: activeId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    const streamingAssistantMessage: Message = {
      id: streamingAssistantId,
      conversationId: activeId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    };
    setActiveConversation((prev) =>
      prev
        ? {
            ...prev,
            messages: [...prev.messages, optimisticUserMessage, streamingAssistantMessage],
          }
        : prev,
    );
    setStreamingId(streamingAssistantId);
    setDraft('');
    userScrolledUpRef.current = false;

    const removeOptimistic = () =>
      setActiveConversation((prev) =>
        prev
          ? {
              ...prev,
              messages: prev.messages.filter(
                (m) => m.id !== optimisticUserId && m.id !== streamingAssistantId,
              ),
            }
          : prev,
      );

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const useStream = settings?.streamingEnabled ?? true;
      const url = useStream
        ? `/api/conversations/${activeId}/messages?stream=true`
        : `/api/conversations/${activeId}/messages?stream=false`;
      const res = await apiPost(url, { content }, abortController.signal);

      if (!res.ok) {
        removeOptimistic();
        const data = await res.json().catch(() => ({}));

        if (data.code === 'CONVERSATION_FULL') {
          setConversationFull(true);
        } else if (isRateLimited(res.status)) {
          addToast(RATE_LIMIT_MESSAGE);
        } else {
          addToast(data.error || 'Something went wrong. Please try again.');
        }
        return;
      }

      if (!useStream) {
        const data = await res.json();
        if (data.success) {
          setActiveConversation((prev) =>
            prev
              ? {
                  ...prev,
                  messages: prev.messages.map((m) => {
                    if (m.id === optimisticUserId) return data.userMessage as Message;
                    if (m.id === streamingAssistantId) return data.assistantMessage as Message;
                    return m;
                  }),
                }
              : prev,
          );
          setConversations((prev) => {
            const updated = prev.filter((c) => c.id !== activeId);
            const current = prev.find((c) => c.id === activeId);
            if (!current) return prev;
            const nextTitle =
              current.title === DEFAULT_CONVERSATION_TITLE
                ? content.slice(0, AUTO_TITLE_MAX_LENGTH) || current.title
                : current.title;
            return [
              { ...current, title: nextTitle, updatedAt: new Date().toISOString() },
              ...updated,
            ];
          });
          setActiveConversation((prev) =>
            prev && prev.title === DEFAULT_CONVERSATION_TITLE
              ? { ...prev, title: content.slice(0, AUTO_TITLE_MAX_LENGTH) || prev.title }
              : prev,
          );
        } else {
          removeOptimistic();
          addToast(data.error || 'Failed to send message.');
        }
        return;
      }

      let receivedError = false;

      for await (const evt of readSseEvents(res)) {
        if (evt.event === 'user-message') {
          const { userMessage } = evt.data as { userMessage: Message };
          setActiveConversation((prev) =>
            prev
              ? {
                  ...prev,
                  messages: prev.messages.map((m) =>
                    m.id === optimisticUserId ? userMessage : m,
                  ),
                }
              : prev,
          );
        } else if (evt.event === 'chunk') {
          const { text } = evt.data as { text: string };
          setActiveConversation((prev) =>
            prev
              ? {
                  ...prev,
                  messages: prev.messages.map((m) =>
                    m.id === streamingAssistantId
                      ? { ...m, content: m.content + text }
                      : m,
                  ),
                }
              : prev,
          );
        } else if (evt.event === 'done') {
          const { assistantMessage } = evt.data as { assistantMessage: Message };
          setActiveConversation((prev) =>
            prev
              ? {
                  ...prev,
                  messages: prev.messages.map((m) =>
                    m.id === streamingAssistantId ? assistantMessage : m,
                  ),
                }
              : prev,
          );
        } else if (evt.event === 'error') {
          receivedError = true;
          const { message } = evt.data as { message?: string };
          removeOptimistic();
          addToast(message || 'AI provider error. Please try again.');
        }
      }

      if (!receivedError) {
        setConversations((prev) => {
          const updated = prev.filter((c) => c.id !== activeId);
          const current = prev.find((c) => c.id === activeId);
          if (!current) return prev;
          const nextTitle =
            current.title === DEFAULT_CONVERSATION_TITLE
              ? content.slice(0, AUTO_TITLE_MAX_LENGTH) || current.title
              : current.title;
          return [
            { ...current, title: nextTitle, updatedAt: new Date().toISOString() },
            ...updated,
          ];
        });
        setActiveConversation((prev) =>
          prev && prev.title === DEFAULT_CONVERSATION_TITLE
            ? { ...prev, title: content.slice(0, AUTO_TITLE_MAX_LENGTH) || prev.title }
            : prev,
        );
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User clicked "Stop generating" — keep partial content visible
        setStreamingId(null);
        return;
      }
      console.error(err);
      removeOptimistic();
      addToast('Network error. Please check your connection and try again.');
    } finally {
      abortControllerRef.current = null;
      setStreamingId(null);
      setIsSending(false);
    }
  }

  function startEditing(conversation: Conversation) {
    setEditingId(conversation.id);
    setEditingTitle(conversation.title);
  }

  function cancelEditing() {
    setEditingId(null);
    setEditingTitle('');
  }

  async function commitRename(conversationId: string) {
    const next = editingTitle.trim();
    const current = conversations.find((c) => c.id === conversationId);
    if (!next || !current || next === current.title) {
      cancelEditing();
      return;
    }

    const previousConversations = conversations;
    setConversations((prev) =>
      prev.map((c) => (c.id === conversationId ? { ...c, title: next } : c)),
    );
    setActiveConversation((prev) =>
      prev && prev.id === conversationId ? { ...prev, title: next } : prev,
    );
    cancelEditing();

    const res = await apiPatch(`/api/conversations/${conversationId}`, { title: next });
    if (!res.ok) {
      setConversations(previousConversations);
      setActiveConversation((prev) =>
        prev && prev.id === conversationId ? { ...prev, title: current.title } : prev,
      );
    }
  }

  async function handleDelete(conversation: Conversation) {
    if (!window.confirm(`Delete "${conversation.title}"? This cannot be undone.`)) {
      return;
    }

    const previousConversations = conversations;
    const wasActive = activeId === conversation.id;
    setConversations((prev) => prev.filter((c) => c.id !== conversation.id));
    if (wasActive) {
      setActiveId(null);
      setActiveConversation(null);
    }

    const res = await apiDelete(`/api/conversations/${conversation.id}`);
    if (!res.ok) {
      setConversations(previousConversations);
      if (wasActive) {
        setActiveId(conversation.id);
      }
    }
  }

  async function handleUploadFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0 || !activeId) return;
    setUploadError(null);
    setIsUploading(true);
    try {
      for (const file of Array.from(fileList)) {
        const res = await apiUpload(`/api/conversations/${activeId}/files`, file);
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          const errorMsg = data?.error ?? 'Upload failed';
          setUploadError(errorMsg);
          addToast(errorMsg);
          break;
        }
        const uploaded = data.file as ConversationFile;
        setActiveConversation((prev) =>
          prev && prev.id === activeId
            ? { ...prev, files: [...prev.files, uploaded] }
            : prev,
        );
      }
    } catch (err) {
      console.error(err);
      setUploadError('Upload failed');
      addToast('File upload failed. Please try again.');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleRemoveFile(file: ConversationFile) {
    if (!activeId) return;
    const previousFiles = activeConversation?.files ?? [];
    setActiveConversation((prev) =>
      prev && prev.id === activeId
        ? { ...prev, files: prev.files.filter((f) => f.id !== file.id) }
        : prev,
    );
    const res = await apiDelete(`/api/conversations/${activeId}/files/${file.id}`);
    if (!res.ok) {
      setActiveConversation((prev) =>
        prev && prev.id === activeId ? { ...prev, files: previousFiles } : prev,
      );
    }
  }

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await apiPost('/api/auth/logout');
      window.location.href = '/login';
    } catch {
      setIsLoggingOut(false);
    }
  }

  function selectConversation(id: string) {
    setActiveId(id);
    setSidebarOpen(false);
  }

  const isStreaming = streamingId !== null;

  return (
    <main className="flex h-screen bg-gray-50">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-gray-200 bg-white transition-transform duration-200 md:static md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Conversations</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleNewConversation('chat')}
              className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white shadow-sm hover:bg-blue-500"
            >
              + Chat
            </button>
            <button
              onClick={() => void handleNewConversation('research')}
              title="Start a new research conversation"
              className="rounded-md bg-purple-600 px-2 py-1 text-xs font-medium text-white shadow-sm hover:bg-purple-500"
            >
              + Research
            </button>
            <button
              onClick={() => setSidebarOpen(false)}
              className="rounded p-1 text-gray-500 hover:bg-gray-100 md:hidden"
              aria-label="Close sidebar"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <ul className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <li className="px-4 py-3 text-xs text-gray-500">
              No conversations yet. Click &quot;New&quot; to start one.
            </li>
          ) : (
            conversations.map((c) => (
              <li key={c.id} className="group relative">
                {editingId === c.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void commitRename(c.id);
                    }}
                    className="px-3 py-2"
                  >
                    <input
                      type="text"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onBlur={() => void commitRename(c.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          cancelEditing();
                        }
                      }}
                      autoFocus
                      maxLength={100}
                      className="w-full rounded-md border border-blue-400 px-2 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </form>
                ) : (
                  <div
                    className={`flex items-center ${
                      c.id === activeId ? 'bg-blue-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <button
                      onClick={() => selectConversation(c.id)}
                      className={`flex-1 truncate px-4 py-3 text-left text-sm ${
                        c.id === activeId
                          ? 'font-medium text-blue-700'
                          : 'text-gray-700'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        {c.mode === 'research' && (
                          <span
                            title="Research conversation"
                            className="inline-flex h-4 items-center rounded-sm bg-purple-100 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700"
                          >
                            Research
                          </span>
                        )}
                        <span className="truncate">{c.title}</span>
                      </span>
                    </button>
                    <div className="flex items-center gap-1 pr-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={() => startEditing(c)}
                        aria-label={`Rename ${c.title}`}
                        title="Rename"
                        className="rounded p-1 text-xs text-gray-500 hover:bg-gray-200 hover:text-gray-900"
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(c)}
                        aria-label={`Delete ${c.title}`}
                        title="Delete"
                        className="rounded p-1 text-xs text-gray-500 hover:bg-red-100 hover:text-red-700"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))
          )}
        </ul>
        <div className="border-t border-gray-200 px-4 py-3">
          {user ? (
            <div className="space-y-2">
              <p className="truncate text-xs text-gray-600">{user.email}</p>
              <button
                onClick={() => setIsSettingsOpen(true)}
                disabled={!settings}
                className="w-full rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-50"
              >
                Settings
              </button>
              <button
                onClick={handleLogout}
                disabled={isLoggingOut}
                className="w-full rounded-md bg-gray-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {isLoggingOut ? 'Logging out...' : 'Log out'}
              </button>
            </div>
          ) : (
            <p className="text-xs text-gray-400">Loading...</p>
          )}
        </div>
      </aside>

      <section className="flex flex-1 flex-col">
        {activeConversation ? (
          <>
            <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3 md:px-6">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="rounded p-1 text-gray-500 hover:bg-gray-100 md:hidden"
                  aria-label="Open sidebar"
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </button>
                <h1 className="truncate text-sm font-semibold text-gray-900">{activeConversation.title}</h1>
                {activeConversation.mode === 'research' && (
                  <span
                    title={`Research status: ${activeConversation.researchStatus}`}
                    className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700"
                  >
                    Research
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {activeConversation.messages.length === 0 && (
                  <button
                    type="button"
                    onClick={() => void toggleResearchMode()}
                    title={
                      activeConversation.mode === 'research'
                        ? 'Switch to regular chat'
                        : 'Switch to research mode'
                    }
                    className={`rounded-md border px-2 py-1 text-xs font-medium ${
                      activeConversation.mode === 'research'
                        ? 'border-purple-300 bg-purple-50 text-purple-700 hover:bg-purple-100'
                        : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {activeConversation.mode === 'research' ? 'Research: ON' : 'Research: OFF'}
                  </button>
                )}
                {settings ? (
                  <button
                    type="button"
                    onClick={() => setIsSettingsOpen(true)}
                    title="Change model or streaming preference"
                    className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100"
                  >
                    {settings.models.find((m) => m.id === settings.preferredModel)?.label ??
                      settings.preferredModel}
                  </button>
                ) : null}
              </div>
            </header>
            <div
              ref={scrollContainerRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto px-4 py-4 md:px-6"
            >
              <ul className="mx-auto flex max-w-3xl flex-col gap-3">
                {activeConversation.messages.length === 0 ? (
                  <li className="py-8 text-center text-sm text-gray-500">
                    {activeConversation.mode === 'research' ? (
                      <>
                        Research mode is on. Enter a topic to begin — the agent will ask
                        clarifying questions before kicking off research.
                      </>
                    ) : (
                      <>Send a message to start the conversation.</>
                    )}
                  </li>
                ) : (
                  activeConversation.messages.map((m) => {
                    const isCurrentlyStreaming = m.id === streamingId;
                    const isEmptyStreaming = isCurrentlyStreaming && m.content.length === 0;
                    return (
                      <li
                        key={m.id}
                        className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                            m.role === 'user'
                              ? 'whitespace-pre-wrap bg-blue-600 text-white'
                              : 'bg-white text-gray-900 shadow'
                          }`}
                        >
                          {isEmptyStreaming ? (
                            <span
                              aria-label="Assistant is typing"
                              className="inline-flex gap-1"
                            >
                              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.3s]" />
                              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.15s]" />
                              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
                            </span>
                          ) : m.role === 'assistant' ? (
                            <MarkdownMessage content={m.content} />
                          ) : (
                            m.content
                          )}
                        </div>
                      </li>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </ul>
            </div>

            {/* Stop generating button */}
            {isStreaming && (
              <div className="flex justify-center border-t border-gray-100 bg-gray-50 py-2">
                <button
                  type="button"
                  onClick={handleStopGenerating}
                  className="rounded-md border border-gray-300 bg-white px-4 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
                >
                  Stop generating
                </button>
              </div>
            )}

            {/* Research progress banner */}
            {researchProgress && (
              <div className="border-t border-purple-200 bg-purple-50 px-4 py-3 md:px-6">
                <div className="mx-auto flex max-w-3xl items-center gap-3 text-sm text-purple-800">
                  <span
                    aria-label="Research in progress"
                    className="inline-flex gap-1"
                  >
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-purple-400 [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-purple-400 [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-purple-400" />
                  </span>
                  <span className="flex-1">
                    {researchProgress.detail ?? stageLabel(researchProgress.stage)}
                  </span>
                </div>
              </div>
            )}

            {/* Conversation full banner */}
            {conversationFull && (
              <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-center md:px-6">
                <p className="text-sm text-amber-800">
                  This conversation has reached the message limit.{' '}
                  <button
                    type="button"
                    onClick={() => void handleNewConversation('chat')}
                    className="font-semibold underline hover:text-amber-900"
                  >
                    Start a new conversation
                  </button>{' '}
                  to continue.
                </p>
              </div>
            )}

            <form
              onSubmit={handleSend}
              className="border-t border-gray-200 bg-white px-4 py-4 md:px-6"
            >
              <div className="mx-auto flex max-w-3xl flex-col gap-2">
                {activeConversation.files.length > 0 && (
                  <ul className="flex flex-col gap-2">
                    {activeConversation.files.map((f) => {
                      const isResearch = activeConversation.mode === 'research';
                      const isAnalyzing = isResearch && f.summary === null;
                      const hasSummary =
                        isResearch && typeof f.summary === 'string' && f.summary.length > 0;
                      const isExpanded = expandedSummaryIds.has(f.id);
                      return (
                        <li
                          key={f.id}
                          className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700"
                        >
                          <div className="flex items-center gap-2">
                            <span className="max-w-[12rem] truncate" title={f.originalName}>
                              {f.originalName}
                            </span>
                            {isAnalyzing && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700">
                                <span
                                  aria-hidden
                                  className="h-1 w-1 animate-pulse rounded-full bg-purple-500"
                                />
                                Analyzing document...
                              </span>
                            )}
                            {hasSummary && (
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedSummaryIds((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(f.id)) next.delete(f.id);
                                    else next.add(f.id);
                                    return next;
                                  })
                                }
                                className="rounded border border-purple-200 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700 hover:bg-purple-50"
                              >
                                {isExpanded ? 'Hide summary' : 'View summary'}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleRemoveFile(f)}
                              aria-label={`Remove ${f.originalName}`}
                              title="Remove"
                              className="ml-auto rounded-full px-1 text-gray-500 hover:bg-gray-200 hover:text-gray-900"
                            >
                              x
                            </button>
                          </div>
                          {hasSummary && isExpanded && (
                            <p className="mt-2 whitespace-pre-wrap rounded bg-white p-2 text-xs leading-relaxed text-gray-800">
                              {f.summary}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {uploadError && (
                  <p role="alert" className="text-xs text-red-600">
                    {uploadError}
                  </p>
                )}
                <div className="flex gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                    onChange={(e) => void handleUploadFiles(e.target.files)}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading || isSending || conversationFull}
                    title="Attach a PDF, Word, or text file"
                    className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isUploading ? 'Uploading...' : 'Attach'}
                  </button>
                  <input
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={
                      conversationFull
                        ? 'Message limit reached'
                        : researchProgress
                          ? 'Researching...'
                          : activeConversation.mode === 'research' &&
                              activeConversation.researchStatus === 'idle'
                            ? 'Enter your research topic...'
                            : activeConversation.mode === 'research' &&
                                activeConversation.researchStatus === 'clarifying'
                              ? 'Answer the clarifying questions...'
                              : 'Type a message...'
                    }
                    disabled={isSending || conversationFull || researchProgress !== null}
                    className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                  />
                  <button
                    type="submit"
                    disabled={
                      isSending ||
                      draft.trim().length === 0 ||
                      conversationFull ||
                      researchProgress !== null
                    }
                    className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isSending ? 'Sending...' : 'Send'}
                  </button>
                </div>
              </div>
            </form>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <button
                onClick={() => setSidebarOpen(true)}
                className="mb-4 rounded p-1 text-gray-500 hover:bg-gray-100 md:hidden"
                aria-label="Open sidebar"
              >
                <svg className="mx-auto h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <p className="text-sm text-gray-600">No conversation selected.</p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <button
                  onClick={() => void handleNewConversation('chat')}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
                >
                  New chat
                </button>
                <button
                  onClick={() => void handleNewConversation('research')}
                  className="rounded-md bg-purple-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-purple-500"
                >
                  New research
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="alert"
              className={`flex items-start gap-2 rounded-lg px-4 py-3 text-sm shadow-lg ${
                t.type === 'error'
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-800 text-white'
              }`}
            >
              <span className="flex-1">{t.message}</span>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                className="ml-2 flex-shrink-0 text-white/80 hover:text-white"
                aria-label="Dismiss"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      <SettingsModal
        open={isSettingsOpen}
        settings={settings}
        onClose={() => setIsSettingsOpen(false)}
        onSaved={(s) => setSettings(s)}
      />
    </main>
  );
}
