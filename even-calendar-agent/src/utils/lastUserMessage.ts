import type { ChatMessage } from '../types/chat.js';

function isChatMessage(value: unknown): value is ChatMessage {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * messages 配列の中から最後の role: "user" のメッセージの content を取得する。
 * 配列でない・見つからない場合は undefined を返し、呼び出し側は固定応答にフォールバックする。
 */
export function getLastUserMessageContent(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message: unknown = messages[i];
    if (isChatMessage(message) && message.role === 'user') {
      return message.content;
    }
  }

  return undefined;
}
