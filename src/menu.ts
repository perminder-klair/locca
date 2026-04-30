import * as p from '@clack/prompts';
import { bench } from './commands/bench.js';
import { del } from './commands/delete.js';
import { download } from './commands/download.js';
import { logs } from './commands/logs.js';
import { pi } from './commands/pi.js';
import { searchHF } from './commands/search.js';
import { serve } from './commands/serve.js';
import { renderServerLine, status } from './commands/status.js';
import { stop } from './commands/stop.js';
import { MENU_BACK, exitIfCancelled, printBanner, setMenuMode } from './ui.js';

type Action =
  | 'pi'
  | 'serve'
  | 'switch'
  | 'status'
  | 'bench'
  | 'logs'
  | 'download'
  | 'search'
  | 'delete'
  | 'stop'
  | 'quit';

export async function menu(): Promise<void> {
  let firstRender = true;
  while (true) {
    // Show the full banner (with tagline) only on the first render so the
    // "back to menu" loop doesn't keep redrawing two screens of art.
    printBanner({ tagline: firstRender });
    firstRender = false;
    await renderServerLine();
    console.log();

    const action = await p.select<Action>({
      message: 'What would you like to do?',
      options: [
        { value: 'pi', label: 'Pi       — coding agent (local)' },
        { value: 'serve', label: 'Serve    — start API server' },
        { value: 'stop', label: 'Stop     — stop server' },
        { value: 'switch', label: 'Switch   — swap server to a different model' },
        { value: 'status', label: 'Status   — server / llama.cpp / models summary' },
        { value: 'bench', label: 'Bench    — benchmark a model' },
        { value: 'logs', label: 'Logs     — tail server log' },
        { value: 'download', label: 'Download — pull from HuggingFace' },
        { value: 'search', label: 'Search   — find models on HuggingFace' },
        { value: 'delete', label: 'Delete   — remove a model' },
        { value: 'quit', label: 'Quit' },
      ],
    });
    // Esc on the top-level select = quit; nothing useful to "go back" to here.
    exitIfCancelled(action);
    if (action === 'quit') return;

    // Inside an action, Esc should bounce back to this menu instead of
    // killing the whole process. setMenuMode flips exitIfCancelled into
    // throw-mode; we catch the sentinel and loop.
    setMenuMode(true);
    try {
      await runAction(action);
    } catch (e) {
      if (!isCancelLike(e)) throw e;
    } finally {
      setMenuMode(false);
    }
  }
}

function isCancelLike(e: unknown): boolean {
  if (e === MENU_BACK) return true;
  // @inquirer/search and friends throw ExitPromptError on Esc / Ctrl-C.
  if (e && typeof e === 'object' && (e as Error).name === 'ExitPromptError') {
    return true;
  }
  return false;
}

async function runAction(action: Exclude<Action, 'quit'>): Promise<void> {
  switch (action) {
    case 'pi':
      await pi([]);
      break;
    case 'serve':
      await serve();
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
  }
}
