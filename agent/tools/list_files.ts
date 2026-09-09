import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { listWorkspace } from '../../src/workspace.js';
import { sessionWorkspace } from '../lib/workspace.js';

export default defineTool({
  description: 'List files and directories in the attached workspace.',
  inputSchema: z.object({ path: z.string().default('.') }),
  execute: ({ path }, ctx) => listWorkspace(sessionWorkspace(ctx.session.id), path),
});
