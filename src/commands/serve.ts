import * as p from '@clack/prompts';
import { loadConfig } from '../config.js';
import { requireLlama } from '../deps.js';
import { pickModel, scanModels } from '../models.js';
import { launchServer, serverStatus, stopServer, waitReady } from '../server.js';
import type { Model } from '../types.js';
import { exitIfCancelled, pc } from '../ui.js';

export async function serve(): Promise<void> {
  const cfg = loadConfig();

  if (cfg.serverUrl) {
    p.log.error(
      `An external server is configured (serverUrl: ${cfg.serverUrl}). The 'serve' command spawns its own — that would conflict. Run \`pi-llm setup\` to clear serverUrl, or stop using this command.`,
    );
    process.exit(1);
  }

  // Check who's on the port before requiring llama-server — we may bail
  // with a more informative error.
  const status = await serverStatus(cfg);
  if (status.running) {
    if (status.source === 'attached') {
      p.log.error(
        `Something is already responding on port ${status.port} (${status.url}) — pi-llm did not start it. Stop it via its original launcher (e.g. \`docker compose down\`) before running \`pi-llm serve\`.`,
      );
      process.exit(1);
    }
    p.log.warn(`Server already running (pid ${status.pid})`);
    const cont = await p.confirm({
      message: 'Stop it and start a new one?',
      initialValue: false,
    });
    exitIfCancelled(cont);
    if (!cont) return;
    await stopServer(cfg);
    await new Promise((r) => setTimeout(r, 500));
  }

  requireLlama(cfg);

  const models = scanModels(cfg.modelsDir);
  if (models.length === 0) {
    p.log.error(`No models found in ${cfg.modelsDir}`);
    process.exit(1);
  }

  const model = await pickModel(models, 'Pick a model to serve');
  if (!model) return;

  const choice = await p.select({
    message: 'Settings',
    options: [
      { value: 'default', label: `Default (port ${cfg.defaultPort}, ctx ${cfg.defaultCtx})` },
      { value: 'custom', label: 'Custom' },
    ],
  });
  exitIfCancelled(choice);

  let port = cfg.defaultPort;
  let ctx = cfg.defaultCtx;
  let threads = cfg.defaultThreads;

  if (choice === 'custom') {
    const portIn = await p.text({
      message: 'Port',
      placeholder: String(cfg.defaultPort),
      initialValue: String(cfg.defaultPort),
    });
    exitIfCancelled(portIn);
    port = parseInt(portIn, 10) || cfg.defaultPort;

    const ctxIn = await p.text({
      message: 'Context size',
      placeholder: String(cfg.defaultCtx),
      initialValue: String(cfg.defaultCtx),
    });
    exitIfCancelled(ctxIn);
    ctx = parseInt(ctxIn, 10) || cfg.defaultCtx;

    const threadsIn = await p.text({
      message: 'Threads',
      placeholder: String(cfg.defaultThreads),
      initialValue: String(cfg.defaultThreads),
    });
    exitIfCancelled(threadsIn);
    threads = parseInt(threadsIn, 10) || cfg.defaultThreads;
  }

  printStartupBanner(model, port, ctx);

  const child = launchServer({
    llamaServer: cfg.llamaServer,
    modelPath: model.path,
    mmprojPath: model.mmprojPath,
    port,
    ctx,
    threads,
    detached: false,
  });

  // If the user Ctrl-Cs us, stop the server too.
  const onSignal = () => {
    if (child.pid) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // ignore
      }
    }
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const ready = await waitReady(port, 60);
  if (ready) {
    console.log();
    console.log(pc.green(pc.bold(`  Server ready at http://0.0.0.0:${port}/v1`)));
    console.log(`  PID: ${child.pid}  |  Stop with Ctrl-C  |  Or: pi-llm stop`);
  } else if (!child.killed && child.exitCode === null) {
    p.log.warn('Server did not become ready within 60s — check output above.');
  }

  // Stay attached until the child exits.
  await new Promise<void>((resolve) => {
    child.on('exit', () => resolve());
  });
}

function printStartupBanner(model: Model, port: number, ctx: number): void {
  console.log();
  console.log(pc.magenta(pc.bold('  Starting server...')));
  console.log(`  Model:   ${model.name}`);
  console.log(`  Port:    ${port}`);
  console.log(`  Context: ${ctx}`);
  console.log(`  GPU:     Vulkan (all layers)`);
  if (model.mmprojPath) {
    const f = model.mmprojPath.split('/').pop();
    console.log(`  Vision:  ${f}`);
  }
  console.log();
}
