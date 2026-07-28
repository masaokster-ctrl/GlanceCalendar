import { describe, expect, it } from 'vitest';
import { InMemoryConversationStateRepository } from '../src/firestore/conversationStateRepository.js';
import type { ConversationStateDoc } from '../src/firestore/models.js';

function buildDoc(overrides: Partial<ConversationStateDoc> = {}): ConversationStateDoc {
  const now = new Date('2026-07-21T01:00:00.000Z');
  return {
    userId: 'single-user',
    state: 'awaiting_confirmation',
    actionType: 'create_event',
    operationId: 'op-1',
    calendarId: 'primary',
    event: {
      summary: '接続テスト予定',
      startDateTime: '2026-07-22T15:00:00+09:00',
      endDateTime: '2026-07-22T16:00:00+09:00',
      timeZone: 'Asia/Tokyo',
      description: 'Even G2から登録',
    },
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
    version: 1,
    ...overrides,
  };
}

describe('InMemoryConversationStateRepository', () => {
  it('returns null when nothing has been saved', async () => {
    const repo = new InMemoryConversationStateRepository();
    expect(await repo.get('single-user')).toBeNull();
  });

  it('saves and retrieves a pending confirmation with a 10-minute expiry', async () => {
    const repo = new InMemoryConversationStateRepository();
    const doc = buildDoc();
    await repo.save(doc);

    const loaded = await repo.get('single-user');
    expect(loaded).not.toBeNull();
    expect(loaded?.state).toBe('awaiting_confirmation');
    expect(loaded?.operationId).toBe('op-1');
    expect(loaded!.expiresAt.getTime() - loaded!.createdAt.getTime()).toBe(10 * 60 * 1000);
  });

  it('replaces an existing pending state when a new one is saved', async () => {
    const repo = new InMemoryConversationStateRepository();
    await repo.save(buildDoc({ operationId: 'op-1' }));
    await repo.save(buildDoc({ operationId: 'op-2' }));

    const loaded = await repo.get('single-user');
    expect(loaded?.operationId).toBe('op-2');
  });

  it('clears the pending state', async () => {
    const repo = new InMemoryConversationStateRepository();
    await repo.save(buildDoc());
    await repo.clear('single-user');
    expect(await repo.get('single-user')).toBeNull();
  });
});
