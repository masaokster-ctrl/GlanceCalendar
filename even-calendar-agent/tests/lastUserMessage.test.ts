import { describe, expect, it } from 'vitest';
import { getLastUserMessageContent } from '../src/utils/lastUserMessage.js';

describe('getLastUserMessageContent', () => {
  it('returns the content of the last user message', () => {
    const messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];
    expect(getLastUserMessageContent(messages)).toBe('second');
  });

  it('returns undefined when there is no user message', () => {
    expect(getLastUserMessageContent([{ role: 'assistant', content: 'hi' }])).toBeUndefined();
  });

  it('returns undefined when messages is not an array', () => {
    expect(getLastUserMessageContent(undefined)).toBeUndefined();
    expect(getLastUserMessageContent('not-an-array')).toBeUndefined();
  });

  it('does not throw on malformed message entries', () => {
    expect(() => getLastUserMessageContent([null, 42, 'x', { role: 'user' }])).not.toThrow();
    expect(getLastUserMessageContent([null, 42, 'x', { role: 'user', content: 'ok' }])).toBe('ok');
  });

  it('preserves non-string content types (e.g. array content parts)', () => {
    const content = [{ type: 'text', text: 'hi' }];
    expect(getLastUserMessageContent([{ role: 'user', content }])).toBe(content);
  });
});
