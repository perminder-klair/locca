import { configExists } from './config.js';

const cmd = process.argv[2];
const rest = process.argv.slice(3);

function printHelp(): void {
  console.log(`Usage: pi-llm [command]

Inference:
  serve       Start API server with a model
  chat        Interactive terminal chat
  pi [name]   Launch pi coding agent with a local model
  switch      Stop current server and start a new model with pi
  stop        Stop running server
  bench       Benchmark a model

  logs        Tail llama-server log (pi-started servers)
  api         Print OpenAI-compatible connection info

Models:
  status      Show models and server status
  info        Show model details
  download    Download model from HuggingFace
  search      Search HuggingFace for GGUF models
  delete      Delete a model

Setup:
  setup       Run the interactive setup wizard

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
    case 'chat': {
      const m = await import('./commands/chat.js');
      await m.chat();
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
    case 'info': {
      const m = await import('./commands/info.js');
      await m.info();
      return;
    }
    case 'api': {
      const m = await import('./commands/api.js');
      await m.api();
      return;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error(`Run 'pi-llm help' for usage.`);
      process.exit(1);
  }
}

await dispatch();
