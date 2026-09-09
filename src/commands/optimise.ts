import { runningAgent } from '../agent-runtime.js';
import { runDoctor, summariseForPrompt } from '../doctor.js';
import { ensureAgent } from './agent.js';

export async function optimise(): Promise<void> {
  const state =
    runningAgent() || (await ensureAgent({ workspace: process.cwd(), port: 3210, open: false }));
  const response = await fetch(`http://127.0.0.1:${state.port}/api/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: summariseForPrompt(await runDoctor()),
      title: 'Deployment review',
      workspace: process.cwd(),
    }),
  });
  if (!response.ok) throw new Error(`Could not start review: ${await response.text()}`);
  const session = (await response.json()) as { id: string };
  console.log(
    `Review started. Open http://127.0.0.1:${state.port}/?token=${state.token}#${session.id}`,
  );
}
