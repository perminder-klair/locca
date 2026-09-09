import { openAgentStore } from '../../src/agent-store.js';

export function sessionWorkspace(id: string): string {
  const store = openAgentStore();
  try {
    const session = store.session(id);
    if (!session) throw new Error('This session has no attached Locca workspace.');
    return session.workspace;
  } finally {
    store.close();
  }
}
