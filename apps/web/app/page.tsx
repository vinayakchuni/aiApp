'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  Conversation,
  ConversationWithMessages,
  Message,
  UserResponse,
} from '@ai-app/shared';
import { apiDelete, apiGet, apiPatch, apiPost, readSseEvents } from '../lib/api';

const DEFAULT_CONVERSATION_TITLE = 'New conversation';
const AUTO_TITLE_MAX_LENGTH = 50;

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
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    apiGet('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.user) setUser(data.user);
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
      return;
    }

    apiGet(`/api/conversations/${activeId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setActiveConversation(data.conversation as ConversationWithMessages);
        }
      })
      .catch(console.error);
  }, [activeId]);

  const lastMessageContent =
    activeConversation?.messages[activeConversation.messages.length - 1]?.content;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.messages.length, lastMessageContent]);

  async function handleNewConversation() {
    const res = await apiPost('/api/conversations', {});
    const data = await res.json();
    if (data.success) {
      const conversation = data.conversation as Conversation;
      setConversations((prev) => [conversation, ...prev]);
      setActiveId(conversation.id);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || !activeId || isSending) return;

    setIsSending(true);
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

    try {
      const res = await apiPost(`/api/conversations/${activeId}/messages`, { content });

      if (!res.ok) {
        removeOptimistic();
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
          removeOptimistic();
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
      console.error(err);
      removeOptimistic();
    } finally {
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

  async function handleLogout() {
    setIsLoggingOut(true);
    try {
      await apiPost('/api/auth/logout');
      window.location.href = '/login';
    } catch {
      setIsLoggingOut(false);
    }
  }

  return (
    <main className="flex h-screen bg-gray-50">
      <aside className="flex w-72 flex-col border-r border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Conversations</h2>
          <button
            onClick={handleNewConversation}
            className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white shadow-sm hover:bg-blue-500"
          >
            + New
          </button>
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
                      onClick={() => setActiveId(c.id)}
                      className={`flex-1 truncate px-4 py-3 text-left text-sm ${
                        c.id === activeId
                          ? 'font-medium text-blue-700'
                          : 'text-gray-700'
                      }`}
                    >
                      {c.title}
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
            <header className="border-b border-gray-200 bg-white px-6 py-3">
              <h1 className="text-sm font-semibold text-gray-900">{activeConversation.title}</h1>
            </header>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <ul className="mx-auto flex max-w-3xl flex-col gap-3">
                {activeConversation.messages.length === 0 ? (
                  <li className="py-8 text-center text-sm text-gray-500">
                    Send a message to start the conversation.
                  </li>
                ) : (
                  activeConversation.messages.map((m) => {
                    const isStreaming = m.id === streamingId;
                    const isEmptyStreaming = isStreaming && m.content.length === 0;
                    return (
                      <li
                        key={m.id}
                        className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-4 py-2 text-sm ${
                            m.role === 'user'
                              ? 'bg-blue-600 text-white'
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
            <form
              onSubmit={handleSend}
              className="border-t border-gray-200 bg-white px-6 py-4"
            >
              <div className="mx-auto flex max-w-3xl gap-2">
                <input
                  type="text"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Type a message..."
                  disabled={isSending}
                  className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={isSending || draft.trim().length === 0}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSending ? 'Sending...' : 'Send'}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <p className="text-sm text-gray-600">No conversation selected.</p>
              <button
                onClick={handleNewConversation}
                className="mt-3 rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-blue-500"
              >
                Start a new conversation
              </button>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
