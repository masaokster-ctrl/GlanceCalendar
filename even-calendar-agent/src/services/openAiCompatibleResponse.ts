import { randomUUID } from 'node:crypto';
import type { ChatCompletionChunk, ChatCompletionResponse } from '../types/chat.js';

const MODEL_NAME = 'even-calendar-agent-probe';

export function buildChatCompletionResponse(content: string): ChatCompletionResponse {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: MODEL_NAME,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

export function buildChatCompletionChunks(content: string): ChatCompletionChunk[] {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  return [
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model: MODEL_NAME,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model: MODEL_NAME,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model: MODEL_NAME,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];
}
