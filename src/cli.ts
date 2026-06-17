import { configExists } from './config.js';

const cmd = process.argv[2];
const rest = process.argv.slice(3);

function printHelp(): void {
  console.log(`Usage: locca [command]

Inference:
  serve [name]  Start API server with a model. With a model name (+ optional
                --port/--ctx/--threads/--yes) it runs non-interactively — no
                prompts. Add -f/--foreground to supervise it in the foreground
                (logs to stdout, exits with the server — for Docker / systemd).
                --idle-timeout <30s|15m|1h> runs a foreground proxy that frees
                VRAM after the model is idle and reloads it on the next request
                (first request after unload pays the cold-start latency).
  embed [name]  Start a dedicated embedding server (separate port)
  pi [name]     Launch pi coding agent with a local model
  switch        Stop current server and start a new model with pi
  stop          Stop running server(s)
  bench         Benchmark a model

  logs [embed]  Tail llama-server log (chat by default, or embed)
  api           Print OpenAI-compatible connection info

Models:
  download    Download model from HuggingFace
  search      Search HuggingFace for GGUF models
  delete      Delete a model

Health:
  doctor      Health check: hardware, llama.cpp, server, models, log, config
  optimise    Have pi review the deployment and suggest tweaks (uses local model)

Setup:
  setup           Run the interactive setup wizard
  install-llama   Download a prebuilt llama.cpp binary into ~/.locca
  config          View / edit settings (get, set, reset, path, list)

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
      await m.serve(rest);
      return;
    }
    case 'embed':
    case 'embeddings': {
      const m = await import('./commands/embed.js');
      await m.embed(rest);
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
    case 'logs':
    case 'log': {
      const m = await import('./commands/logs.js');
      await m.logs(rest);
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
    case 'doctor': {
      const m = await import('./commands/doctor.js');
      await m.doctor();
      return;
    }
    case 'optimise':
    case 'optimize': {
      const m = await import('./commands/optimise.js');
      await m.optimise();
      return;
    }
    case 'install-llama':
    case 'install': {
      const m = await import('./commands/install-llama.js');
      await m.installLlamaCommand(rest);
      return;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error(`Run 'locca help' for usage.`);
      process.exit(1);
  }
}

await dispatch();
