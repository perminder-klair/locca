import { defineTool } from 'eve/tools';
import { always } from 'eve/tools/approval';
import { z } from 'zod';
import { sessionWorkspace } from '../lib/workspace.js';
import { runWorkspaceCommand } from '../../src/workspace-command.js';

export default defineTool({
  description:
    'Run a shell command on the host in the attached workspace. Requires user approval. Use for tests, builds, and git inspection.',
  inputSchema: z.object({
    command: z.string(),
    timeoutSeconds: z.number().int().min(1).max(300).default(60),
  }),
  approval: always(),
  execute: ({ command, timeoutSeconds }, ctx) =>
    runWorkspaceCommand(sessionWorkspace(ctx.session.id), command, timeoutSeconds, ctx.abortSignal),
});
