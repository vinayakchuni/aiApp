import { describe, it, expect } from 'vitest';
import { buildModelMessages, DEFAULT_SYSTEM_PROMPT } from '../services/context';

describe('buildModelMessages', () => {
  it('returns just the system prompt when history is empty', () => {
    const result = buildModelMessages({ history: [] });
    expect(result).toEqual([{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }]);
  });

  it('appends history in chronological order after the system prompt', () => {
    const result = buildModelMessages({
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'how are you?' },
      ],
    });
    expect(result).toEqual([
      { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how are you?' },
    ]);
  });

  it('honors a custom system prompt', () => {
    const result = buildModelMessages({
      systemPrompt: 'You are a pirate.',
      history: [{ role: 'user', content: 'hi' }],
    });
    expect(result[0]).toEqual({ role: 'system', content: 'You are a pirate.' });
    expect(result).toHaveLength(2);
  });
});
