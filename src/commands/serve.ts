import * as p from '@clack/prompts';
import { loadConfig } from '../config.js';
import { requireLlama } from '../deps.js';
import { pickModel, scanModels } from '../models.js';
import { refuseIfPortTaken } from '../preflight.js';
import { launchServer, serverStatus, stopServer, waitReady } from '../server.js';
import type { Model } from '../types.js';
import { exitIfCancelled, pc } from '../ui.js';
import { api } from './api.js';

export async function serve(): Promise<void> {
  const cfg = loadConfig();

  // Check who's on the port before requiring llama-server — we may bail
  // with a more informative error.
  const status = await serverStatus(cfg);
  if (status.running) {
    if (status.source === 'attached') {
      p.log.error(
        `Something is already responding on port ${status.port} (${status.url}) — locca did not start it. Stop it via whatever started it before running \`locca serve\`.`,
      );
      process.exit(1);
    }
    // pid source: locca started it, so just swap — no need to interrogate.
    p.log.info(`Stopping current server (pid ${status.pid}) to start a new one...`);
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

  await refuseIfPortTaken(port);

  printStartupBanner(model, port, ctx);

  launchServer({
    llamaServer: cfg.llamaServer,
    modelPath: model.path,
    mmprojPath: model.mmprojPath,
    port,
    ctx,
    threads,
    // Detached: server keeps running after locca exits. Stop it with
    // `locca stop`. Logs go to the log file (see `locca logs`).
    detached: true,
  });

  const ready = await waitReady(port, 60);
  if (!ready) {
    p.log.warn('Server did not become ready within 60s — run `locca logs` to see output.');
    return;
  }

  // Show the OpenAI-compatible connection info — same output as
  // `locca api`. Includes LAN / Tailscale URLs when bound to 0.0.0.0,
  // model name, endpoints, and a curl quick-test.
  await api();
  console.log(`  ${pc.dim('Stop with: locca stop  |  Logs: locca logs')}`);
  console.log();
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
