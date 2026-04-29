import * as p from '@clack/prompts';
import { api } from './commands/api.js';
import { bench } from './commands/bench.js';
import { chat } from './commands/chat.js';
import { del } from './commands/delete.js';
import { download } from './commands/download.js';
import { info } from './commands/info.js';
import { logs } from './commands/logs.js';
import { pi } from './commands/pi.js';
import { searchHF } from './commands/search.js';
import { serve } from './commands/serve.js';
import { renderServerLine } from './commands/status.js';
import { status } from './commands/status.js';
import { stop } from './commands/stop.js';
import { exitIfCancelled, header } from './ui.js';

type Action =
  | 'pi'
  | 'serve'
  | 'chat'
  | 'switch'
  | 'status'
  | 'bench'
  | 'info'
  | 'api'
  | 'logs'
  | 'download'
  | 'search'
  | 'delete'
  | 'stop'
  | 'quit';

export async function menu(): Promise<void> {
  header();
  await renderServerLine();
  console.log();

  const action = await p.select<Action>({
    message: 'What would you like to do?',
    options: [
      { value: 'pi', label: 'Pi       — coding agent (local)' },
      { value: 'serve', label: 'Serve    — start API server' },
      { value: 'chat', label: 'Chat     — terminal chat' },
      { value: 'switch', label: 'Switch   — swap server to a different model' },
      { value: 'status', label: 'Status   — list models' },
      { value: 'bench', label: 'Bench    — benchmark a model' },
      { value: 'info', label: 'Info     — model details' },
      { value: 'api', label: 'API      — OpenAI-compatible connection info' },
      { value: 'logs', label: 'Logs     — tail server log' },
      { value: 'download', label: 'Download — pull from HuggingFace' },
      { value: 'search', label: 'Search   — find models on HuggingFace' },
      { value: 'delete', label: 'Delete   — remove a model' },
      { value: 'stop', label: 'Stop     — stop server' },
      { value: 'quit', label: 'Quit' },
    ],
  });
  exitIfCancelled(action);

  switch (action) {
    case 'pi':
      await pi([]);
      break;
    case 'serve':
      await serve();
      break;
    case 'chat':
      await chat();
      break;
    case 'switch':
      await pi([], { stopFirst: true });
      break;
    case 'status':
      await status();
      break;
    case 'bench':
      await bench();
      break;
    case 'info':
      await info();
      break;
    case 'api':
      await api();
      break;
    case 'logs':
      await logs();
      break;
    case 'download':
      await download([]);
      break;
    case 'search':
      await searchHF([]);
      break;
    case 'delete':
      await del();
      break;
    case 'stop':
      await stop();
      break;
    case 'quit':
      return;
  }
}
