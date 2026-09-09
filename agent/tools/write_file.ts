import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { writeWorkspace } from '../../src/workspace.js';
import { sessionWorkspace } from '../lib/workspace.js';

export default defineTool({
  description:
    'Create or replace a text file in the attached workspace. Read existing files before editing.',
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  execute: ({ path, content }, ctx) =>
    writeWorkspace(sessionWorkspace(ctx.session.id), path, content),
});
