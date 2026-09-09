import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { agentDataDir } from '../agent-store.js';
import { runningAgent, type AgentRuntime } from '../agent-runtime.js';
import { loadConfig } from '../config.js';
import { findMatches, pickModel, scanModels, ctxForModel } from '../models.js';
import { isEmbeddingModelName, serverArgsForModel, mtpArgsForModel } from '../catalog.js';
import {
  launchServer,
  probeServerProps,
  serverStatus,
  stopServer,
  waitReady,
  waitForPortFree,
} from '../server.js';
import { requireLlama } from '../deps.js';
import { refuseIfPortTaken } from '../preflight.js';
import { workspaceRoot } from '../workspace.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
export interface AgentOptions {
  pattern?: string;
  workspace: string;
  port: number;
  open: boolean;
}

export function parseAgentArgs(args: string[]): AgentOptions {
  const options: AgentOptions = { workspace: process.cwd(), port: 3210, open: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-open') options.open = false;
    else if (arg === '--workspace' || arg === '--port') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--workspace') options.workspace = value;
      else {
        options.port = Number(value);
        if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)
          throw new Error('Agent port must be between 1024 and 65535.');
      }
    } else if (arg.startsWith('-') || options.pattern)
      throw new Error(`Unexpected argument: ${arg}`);
    else options.pattern = arg;
  }
  return options;
}

export async function stopAgent(): Promise<void> {
  const running = runningAgent();
  if (!running) {
    console.log('Agent service is stopped.');
    return;
  }
  process.kill(running.pid, 'SIGTERM');
  for (let i = 0; i < 140; i++) {
    if (!runningAgent()) {
      console.log('Agent stopped. Conversations and jobs are saved.');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Agent did not stop within 14 seconds. Inspect `locca agent logs`.');
}

export async function agent(
  args: string[] = [],
  opts: { stopFirst?: boolean } = {},
): Promise<void> {
  if (args[0] === 'stop') return stopAgent();
  if (args[0] === 'status') {
    const running = runningAgent();
    console.log(
      running
        ? `Agent running on http://127.0.0.1:${running.port} with ${running.modelId}`
        : 'Agent service is stopped.',
    );
    return;
  }
  if (args[0] === 'logs') {
    const log = join(agentDataDir(), 'agent.log');
    console.log(
      existsSync(log)
        ? readFileSync(log, 'utf8').split('\n').slice(-100).join('\n')
        : 'No agent log yet.',
    );
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'locca agent [model] [--workspace <directory>] [--port <3210>] [--no-open]\nlocca agent status | stop | logs',
    );
    return;
  }
  const options = parseAgentArgs(args);
  if (opts.stopFirst) await stopAgent();
  const running = runningAgent();
  if (
    running &&
    options.pattern &&
    !running.modelId.toLowerCase().includes(options.pattern.toLowerCase())
  ) {
    throw new Error(
      'Agent is already running with another model. Use `locca switch <model>` to change it.',
    );
  }
  const state = running || (await ensureAgent(options));
  const workspace = await workspaceRoot(options.workspace);
  const url = `http://127.0.0.1:${state.port}/?token=${state.token}&workspace=${encodeURIComponent(workspace)}`;
  console.log(`Locca workspace: ${url}`);
  console.log(
    `Model: ${state.modelId}\nWorkspace: ${workspace}\nRuns in the background. Stop with: locca agent stop`,
  );
  if (options.open) {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
      stdio: 'ignore',
      detached: true,
    });
    child.on('error', () => {});
    child.unref();
  }
}

export async function ensureAgent(options: AgentOptions): Promise<AgentRuntime> {
  const current = runningAgent();
  if (current) return current;
  if (!existsSync(join(packageRoot, '.output/server/index.mjs')))
    throw new Error('Eve runtime is not built. Run `npm run build` in the Locca checkout.');
  const workspace = await workspaceRoot(options.workspace);
  const cfg = loadConfig();
  let status = await serverStatus(cfg);
  if (!status.running || options.pattern) {
    const models = scanModels(cfg.modelsDir).filter((model) => !isEmbeddingModelName(model.name));
    const selected = options.pattern
      ? findMatches(models, options.pattern)[0]
      : models.length === 1
        ? models[0]
        : process.stdin.isTTY
          ? await pickModel(models, 'Pick a model for Locca')
          : null;
    if (!selected)
      throw new Error(
        'Choose a local chat model: `locca agent <model>`. Download one with `locca download`.',
      );
    if (status.running && basename(selected.path) !== status.model) {
      if (status.source === 'attached')
        throw new Error(
          'The attached server has a different model. Stop it with the tool that started it.',
        );
      await stopServer(cfg);
      await waitForPortFree(status.port);
      status = { running: false };
    }
    if (!status.running) {
      requireLlama(cfg);
      await refuseIfPortTaken(cfg.defaultPort);
      const ctx = ctxForModel(selected.name, cfg.vramBudgetMB);
      p.log.info(`Loading ${selected.name}...`);
      const child = launchServer({
        llamaServer: cfg.llamaServer,
        modelPath: selected.path,
        mmprojPath: selected.mmprojPath,
        port: cfg.defaultPort,
        host: '127.0.0.1',
        ctx,
        threads: cfg.defaultThreads,
        parallel: 1,
        detached: true,
        noMmap: cfg.noMmap,
        extraArgs: [
          ...serverArgsForModel(selected.name),
          ...mtpArgsForModel(selected.path, cfg, cfg.llamaServer),
        ],
      });
      if (!(await waitReady(cfg.defaultPort, 120, child.pid))) {
        await stopServer(cfg);
        throw new Error('Model failed to load. See `locca logs`.');
      }
      status = await serverStatus(cfg);
    }
  }
  if (!status.running || !status.model)
    throw new Error('Inference server did not report a model. See `locca doctor`.');
  const props = await probeServerProps(status.url);
  const dir = agentDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const config = {
    port: options.port,
    token: randomBytes(32).toString('hex'),
    modelId: status.model,
    baseUrl: `${status.url}/v1`,
    contextWindow: props.ctx || cfg.defaultCtx,
    workspace,
  };
  const launchFile = join(dir, `launch-${randomUUID()}.json`);
  writeFileSync(launchFile, JSON.stringify(config), { mode: 0o600 });
  const log = openSync(join(dir, 'agent.log'), 'a', 0o600);
  const child = spawn(process.execPath, [join(packageRoot, 'dist/agent-service.js'), launchFile], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, LOCCA_AGENT_DATA_DIR: dir },
  });
  closeSync(log);
  child.unref();
  let spawnError: Error | undefined;
  child.on('error', (error) => {
    spawnError = error;
  });
  for (let i = 0; i < 150; i++) {
    if (spawnError) throw spawnError;
    const ready = runningAgent();
    if (ready) {
      unlinkSync(launchFile);
      return ready;
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  child.kill('SIGTERM');
  try {
    unlinkSync(launchFile);
  } catch {}
  throw new Error('Agent failed to start. Inspect `locca agent logs`.');
}
