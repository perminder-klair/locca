import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { runDoctor } from '../../src/doctor.js';

export default defineTool({
  description: 'Inspect local hardware, models, inference server, and Locca configuration.',
  inputSchema: z.object({}),
  execute: () => runDoctor(),
});
