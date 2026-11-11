// P2-T02 evidence: mirroring facts for Codex 0.160.0 event_msg item_completed messages vs response_item messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mirroring } from './facts.ts';

const resp = (role: string, text: string, id?: string) => ({ type: 'response_item', payload: { type: 'message', id, role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const item = (type: string, text: string, id?: string) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type, id, content: [{ type: 'Text', text }] } } });

test('every item mirrors an earlier response message of the same role and text; ids compared', () => {
  const m = mirroring([[resp('user', 'hi  there', 'm1'), item('UserMessage', 'hi there', 'm1'), resp('assistant', 'ok', 'm2'), item('AgentMessage', 'ok', 'm2')]]);
  assert.deepEqual(m, {
    itemCompletedMessages: true, userItemsMirrored: true, agentItemsMirrored: true,
    itemAlwaysAfterResponse: true, itemIdEqualsResponseId: true, responseUserWithoutItem: false, responseAssistantWithoutItem: false,
  });
});

test('mirrors are matched within one file only; unmatched and reversed order are reported', () => {
  const m = mirroring([[item('UserMessage', 'a'), resp('user', 'a'), resp('user', 'injected')], [item('AgentMessage', 'b')], [resp('assistant', 'b')]]);
  assert.equal(m.userItemsMirrored, true);
  assert.equal(m.agentItemsMirrored, false, 'the matching response is in another file');
  assert.equal(m.itemAlwaysAfterResponse, false);
  assert.equal(m.itemIdEqualsResponseId, null, 'no ids on either side');
  assert.equal(m.responseUserWithoutItem, true);
});

test('no item_completed messages: nulls, never false', () => {
  assert.deepEqual(mirroring([[resp('user', 'a')]]), {
    itemCompletedMessages: false, userItemsMirrored: null, agentItemsMirrored: null,
    itemAlwaysAfterResponse: null, itemIdEqualsResponseId: null, responseUserWithoutItem: null, responseAssistantWithoutItem: null,
  });
});
