/**
 * Even AI の実際のリクエスト形式は未確認のため、既知フィールドのみ型付けし、
 * それ以外の未知フィールドを許容する緩い型にしている。
 */
export interface ChatMessage {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

export interface ChatCompletionRequestBody {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  user?: unknown;
  [key: string]: unknown;
}

export interface ChatCompletionResponseMessage {
  role: 'assistant';
  content: string;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionResponseMessage;
  finish_reason: 'stop';
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: ChatCompletionUsage;
}

export interface ChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: 'stop' | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
}
