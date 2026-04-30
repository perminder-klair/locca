import { configExists } from './config.js';

const cmd = process.argv[2];
const rest = process.argv.slice(3);

function printHelp(): void {
  console.log(`Usage: locca [command]

Inference:
  serve       Start API server with a model (detached)
  pi [name]   Launch pi coding agent with a local model
  switch      Stop current server and start a new model with pi
  stop        Stop running server
  bench       Benchmark a model

  logs        Tail llama-server log (pi-started servers)
  api         Print OpenAI-compatible connection info

Models:
  status      Server / llama.cpp / models summary
  download    Download model from HuggingFace
  search      Search HuggingFace for GGUF models
  delete      Delete a model

Setup:
  setup       Run the interactive setup wizard
  config      View / edit settings (get, set, reset, path, list)

Run without arguments for the interactive menu.`);
}

async function dispatch(): Promise<void> {
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    printHelp();
    return;
  }

  if (!cmd) {
    if (!configExists()) {
      const { runSetup } = await import('./setup.js');
      await runSetup();
    }
    const { menu } = await import('./menu.js');
    await menu();
    return;
  }

  switch (cmd) {
    case 'setup': {
      const { runSetup } = await import('./setup.js');
      await runSetup();
      return;
    }
    case 'serve':
    case 'start': {
      const m = await import('./commands/serve.js');
      await m.serve();
      return;
    }
    case 'pi': {
      const m = await import('./commands/pi.js');
      await m.pi(rest);
      return;
    }
    case 'switch':
    case 'swap': {
      const m = await import('./commands/pi.js');
      await m.pi(rest, { stopFirst: true });
      return;
    }
    case 'stop': {
      const m = await import('./commands/stop.js');
      await m.stop();
      return;
    }
    case 'status':
    case 'ls': {
      const m = await import('./commands/status.js');
      await m.status();
      return;
    }
    case 'logs':
    case 'log': {
      const m = await import('./commands/logs.js');
      await m.logs();
      return;
    }
    case 'bench': {
      const m = await import('./commands/bench.js');
      await m.bench();
      return;
    }
    case 'download':
    case 'pull': {
      const m = await import('./commands/download.js');
      await m.download(rest);
      return;
    }
    case 'search':
    case 'find': {
      const m = await import('./commands/search.js');
      await m.searchHF(rest);
      return;
    }
    case 'delete':
    case 'rm': {
      const m = await import('./commands/delete.js');
      await m.del();
      return;
    }
    case 'api': {
      const m = await import('./commands/api.js');
      await m.api();
      return;
    }
    case 'config': {
      const m = await import('./commands/config.js');
      await m.config(rest);
      return;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error(`Run 'locca help' for usage.`);
      process.exit(1);
  }
}

await dispatch();
