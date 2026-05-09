'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  Conversation,
  ConversationWithMessages,
  Message,
  UserResponse,
} from '@ai-app/shared';
import { apiGet, apiPost } from '../lib/api';

export default function Home() {
  const [user, setUser] = useState<UserResponse | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] =
    useState<ConversationWithMessages | null>(null);
  const [draft, setDraft] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConversation?.messages.length]);

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
    const optimisticUserMessage: Message = {
      id: `optimistic-${Date.now()}`,
      conversationId: activeId,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    };
    setActiveConversation((prev) =>
      prev ? { ...prev, messages: [...prev.messages, optimisticUserMessage] } : prev,
    );
    setDraft('');

    try {
      const res = await apiPost(`/api/conversations/${activeId}/messages`, { content });
      const data = await res.json();
      if (data.success) {
        setActiveConversation((prev) => {
          if (!prev) return prev;
          const withoutOptimistic = prev.messages.filter(
            (m) => m.id !== optimisticUserMessage.id,
          );
          return {
            ...prev,
            messages: [...withoutOptimistic, data.userMessage, data.assistantMessage],
          };
        });
        setConversations((prev) => {
          const updated = prev.filter((c) => c.id !== activeId);
          const current = prev.find((c) => c.id === activeId);
          if (!current) return prev;
          return [{ ...current, updatedAt: new Date().toISOString() }, ...updated];
        });
      } else {
        setActiveConversation((prev) =>
          prev
            ? {
                ...prev,
                messages: prev.messages.filter((m) => m.id !== optimisticUserMessage.id),
              }
            : prev,
        );
      }
    } catch (err) {
      console.error(err);
      setActiveConversation((prev) =>
        prev
          ? { ...prev, messages: prev.messages.filter((m) => m.id !== optimisticUserMessage.id) }
          : prev,
      );
    } finally {
      setIsSending(false);
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
              <li key={c.id}>
                <button
                  onClick={() => setActiveId(c.id)}
                  className={`block w-full truncate px-4 py-3 text-left text-sm ${
                    c.id === activeId
                      ? 'bg-blue-50 font-medium text-blue-700'
                      : 'text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {c.title}
                </button>
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
                  activeConversation.messages.map((m) => (
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
                        {m.content}
                      </div>
                    </li>
                  ))
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
