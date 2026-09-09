// Pure event reduction keeps replay and live rendering identical.
export function reduceEvents(events) {
  const items = [];
  const messages = new Map();
  const actions = new Map();
  const pending = new Map();
  const seen = new Set();
  let busy = false;
  let terminal = false;
  let status = 'Ready';
  for (const event of events) {
    if (event.meta?.id && seen.has(event.meta.id)) continue;
    if (event.meta?.id) seen.add(event.meta.id);
    const data = event.data || {};
    const key = `${data.turnId}:${data.stepIndex}`;
    if (event.type === 'turn.started') {
      busy = true;
      status = 'Thinking…';
    }
    if (event.type === 'message.received') items.push({ kind: 'user', text: data.message });
    if (event.type === 'message.appended' || event.type === 'message.completed') {
      let message = messages.get(key);
      if (!message) {
        message = { kind: 'assistant', text: '' };
        messages.set(key, message);
        items.push(message);
      }
      message.text =
        event.type === 'message.completed'
          ? data.message || ''
          : message.text + (data.messageDelta || '');
      status = 'Responding…';
    }
    if (event.type === 'actions.requested')
      for (const action of data.actions || []) {
        const item = {
          kind: 'tool',
          name: action.toolName || action.kind,
          input: action.input,
          status: 'Running',
          output: null,
        };
        actions.set(action.callId, item);
        items.push(item);
        status = `Running ${item.name}…`;
      }
    if (event.type === 'action.result') {
      const action = actions.get(data.result?.callId);
      if (action) {
        action.output = data.result?.output ?? data.result;
        action.status = data.status;
      }
    }
    if (event.type === 'input.requested')
      for (const request of data.requests || []) pending.set(request.requestId, request);
    if (event.type === 'input.resolved')
      for (const resolution of data.resolutions || []) pending.delete(resolution.requestId);
    if (event.type === 'turn.cancelled') {
      pending.clear();
      status = 'Task stopped';
    }
    if (event.type === 'compaction.completed') status = 'Context compacted';
    if (event.type === 'session.waiting') {
      busy = false;
      if (status !== 'Task stopped' && status !== 'Context compacted') status = 'Ready';
    }
    if (event.type === 'session.failed') {
      busy = false;
      terminal = true;
      status = 'Task failed';
      pending.clear();
      items.push({
        kind: 'error',
        text: typeof data.error === 'string' ? data.error : JSON.stringify(data.error || data),
      });
    }
    if (event.type === 'session.completed') {
      busy = false;
      terminal = true;
      status = 'Conversation complete';
      pending.clear();
    }
  }
  if (pending.size) {
    busy = false;
    status = 'Waiting for your response';
  }
  return { items, pending: [...pending.values()], busy, terminal, status };
}
