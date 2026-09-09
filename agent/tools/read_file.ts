import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { readWorkspace } from '../../src/workspace.js';
import { sessionWorkspace } from '../lib/workspace.js';

export default defineTool({
  description: 'Read a text file in the attached workspace. Paths are relative to the workspace.',
  inputSchema: z.object({
    path: z.string(),
    startLine: z.number().int().min(1).default(1),
    lines: z.number().int().min(1).max(400).default(200),
  }),
  execute: async ({ path, startLine, lines }, ctx) => {
    const content = await readWorkspace(sessionWorkspace(ctx.session.id), path);
    const all = content.split('\n');
    const selected = all.slice(startLine - 1, startLine - 1 + lines).join('\n');
    return {
      content: selected.slice(0, 24_000),
      startLine,
      totalLines: all.length,
      truncated: selected.length > 24_000 || startLine - 1 + lines < all.length,
    };
  },
});
