import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reduceEvents } from '../../web/events.js';

test('replayed events deduplicate and completed text replaces provisional output', () => {
  const event = { type: 'message.appended', meta: { id: 'a' }, data: { turnId: 't', stepIndex: 0, messageDelta: 'Hello' } };
  const result = reduceEvents([event, event, { type: 'message.completed', data: { turnId: 't', stepIndex: 0, message: 'Hello world' } }]);
  assert.deepEqual(result.items, [{ kind: 'assistant', text: 'Hello world' }]);
});

test('pending approvals survive waiting boundaries and clear only on authoritative resolution', () => {
  const events = [{ type: 'input.requested', data: { requests: [{ requestId: 'r', prompt: 'Approve?' }] } }, { type: 'session.waiting' }];
  assert.equal(reduceEvents(events).pending.length, 1);
  events.push({ type: 'input.resolved', data: { resolutions: [{ requestId: 'r' }] } });
  assert.equal(reduceEvents(events).pending.length, 0);
});
