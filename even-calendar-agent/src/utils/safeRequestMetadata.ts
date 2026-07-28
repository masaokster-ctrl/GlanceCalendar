import type { Request } from 'express';

const KNOWN_TOP_LEVEL_FIELDS = new Set(['model', 'messages', 'stream', 'user']);

export interface SafeRequestMetadata {
  timestamp: string;
  method: string;
  path: string;
  contentType: string | null;
  hasAuthorizationHeader: boolean;
  isBearerScheme: boolean;
  topLevelFields: string[];
  fieldTypes: Record<string, string>;
  hasModel: boolean;
  hasMessages: boolean;
  messageCount: number | null;
  messageRoles: Array<string | null>;
  contentTypes: string[];
  streamValue: unknown;
  hasUserField: boolean;
  unknownFields: string[];
  userAgent: string | null;
  bodyByteLength: number;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * リクエストの「形」だけを記録するための調査用メタデータを組み立てる。
 * 会話本文・APIトークン・Authorizationヘッダーの値そのものは一切含めない。
 */
export function buildSafeRequestMetadata(req: Request, bodyByteLength: number): SafeRequestMetadata {
  const authHeader = req.header('authorization');
  const hasAuthorizationHeader = typeof authHeader === 'string' && authHeader.length > 0;
  const isBearerScheme = hasAuthorizationHeader && /^Bearer\s+/i.test(authHeader);

  const body: unknown = req.body;
  const topLevelFields = isPlainRecord(body) ? Object.keys(body) : [];

  const fieldTypes: Record<string, string> = {};
  for (const key of topLevelFields) {
    fieldTypes[key] = typeOf((body as Record<string, unknown>)[key]);
  }

  const hasModel = topLevelFields.includes('model');
  const hasMessages = topLevelFields.includes('messages');
  const hasUserField = topLevelFields.includes('user');
  const unknownFields = topLevelFields.filter((field) => !KNOWN_TOP_LEVEL_FIELDS.has(field));

  const messagesValue = isPlainRecord(body) ? body.messages : undefined;
  const messagesIsArray = Array.isArray(messagesValue);

  const messageRoles: Array<string | null> = messagesIsArray
    ? messagesValue.map((message: unknown) => {
        if (isPlainRecord(message) && typeof message.role === 'string') {
          return message.role;
        }
        return null;
      })
    : [];

  const contentTypes: string[] = messagesIsArray
    ? messagesValue.map((message: unknown) => {
        if (isPlainRecord(message) && 'content' in message) {
          return typeOf(message.content);
        }
        return 'undefined';
      })
    : [];

  const streamValue = isPlainRecord(body) ? body.stream : undefined;

  return {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    contentType: req.header('content-type') ?? null,
    hasAuthorizationHeader,
    isBearerScheme,
    topLevelFields,
    fieldTypes,
    hasModel,
    hasMessages,
    messageCount: messagesIsArray ? messagesValue.length : null,
    messageRoles,
    contentTypes,
    streamValue,
    hasUserField,
    unknownFields,
    userAgent: req.header('user-agent') ?? null,
    bodyByteLength,
  };
}
