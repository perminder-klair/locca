import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import * as p from '@clack/prompts';
import { CONFIG_FILE, loadConfig, saveConfig } from './config.js';
import { probeServer } from './server.js';
import { exitIfCancelled, pc } from './ui.js';
import { autoThreads, expandHome, have } from './util.js';

export async function runSetup(): Promise<void> {
  p.intro(pc.magenta(pc.bold('pi-llm setup')));

  const existing = loadConfig();
  const totalCores = autoThreads() + 2; // autoThreads = nproc - 2
  const threadDefault = autoThreads();

  // Models directory
  const modelsDirIn = await p.text({
    message: 'Where do you keep .gguf models?',
    placeholder: existing.modelsDir,
    initialValue: existing.modelsDir,
  });
  exitIfCancelled(modelsDirIn);
  const modelsDir = expandHome(modelsDirIn || existing.modelsDir);

  if (!existsSync(modelsDir)) {
    const create = await p.confirm({
      message: `Directory does not exist. Create ${modelsDir}?`,
      initialValue: true,
    });
    exitIfCancelled(create);
    if (create) {
      mkdirSync(modelsDir, { recursive: true });
      p.log.success(`Created ${modelsDir}`);
    } else {
      p.log.warn('Skipped — pi-llm will fail until this directory exists.');
    }
  }

  // ── llama.cpp source: spawn locally vs use an existing server ───────
  const llamaPresent = have('llama-server');

  const sourceLabel = llamaPresent
    ? 'llama-server is on PATH — pi-llm will spawn it for you'
    : 'llama-server NOT found in PATH';
  p.log.message(sourceLabel);

  type Source = 'local' | 'external';
  const defaultSource: Source = llamaPresent ? 'local' : 'external';
  const source = await p.select<Source>({
    message: 'How should pi-llm reach llama.cpp?',
    initialValue: defaultSource,
    options: [
      {
        value: 'local',
        label: 'Local — pi-llm spawns llama-server when needed',
        hint: llamaPresent ? '' : 'requires llama-server on PATH',
      },
      {
        value: 'external',
        label: 'External — pi-llm connects to a server you already run',
        hint: 'e.g. a docker compose container, another machine on your LAN',
      },
    ],
  });
  exitIfCancelled(source);

  let serverUrl: string | undefined;
  if (source === 'external') {
    serverUrl = await promptForExternalServer(existing.serverUrl);
  }

  // Server defaults (port/ctx/threads — relevant for `local`; for `external`
  // they're still useful as fallbacks but mostly cosmetic).
  const useDefaults = await p.confirm({
    message: `Use sensible defaults? (port 8080, ctx 32768, threads ${threadDefault} of ${totalCores} cores)`,
    initialValue: true,
  });
  exitIfCancelled(useDefaults);

  let port = 8080;
  let ctx = 32768;
  let threads = threadDefault;

  if (!useDefaults) {
    const portIn = await p.text({ message: 'Port', initialValue: '8080' });
    exitIfCancelled(portIn);
    port = parseInt(portIn, 10) || 8080;

    const ctxIn = await p.text({ message: 'Context size', initialValue: '32768' });
    exitIfCancelled(ctxIn);
    ctx = parseInt(ctxIn, 10) || 32768;

    const threadsIn = await p.text({
      message: `CPU threads (system has ${totalCores})`,
      initialValue: String(threadDefault),
    });
    exitIfCancelled(threadsIn);
    threads = parseInt(threadsIn, 10) || threadDefault;
  }

  saveConfig({
    modelsDir,
    defaultPort: port,
    defaultCtx: ctx,
    defaultThreads: threads,
    serverUrl,
  });
  p.log.success(`Wrote ${CONFIG_FILE}`);

  if (source === 'local' && !llamaPresent) {
    p.log.warn('llama-server is not yet on PATH.');
    p.log.message(
      [
        'Install llama.cpp:',
        '  Arch:   sudo pacman -S llama.cpp',
        '  macOS:  brew install llama.cpp',
        '  Other:  build from source — https://github.com/ggml-org/llama.cpp',
        '',
        'Or re-run `pi-llm setup` and pick External to point pi-llm at an',
        'existing server (e.g. docker compose).',
        '',
        'If you build from source, set llamaServer/llamaCli in',
        `${CONFIG_FILE} to absolute paths.`,
      ].join('\n'),
    );
  }

  // pi (coding agent)
  if (have('pi')) {
    p.log.success('pi (coding agent) found');
  } else {
    const installPi = await p.confirm({
      message: "Install 'pi' coding agent now?",
      initialValue: true,
    });
    exitIfCancelled(installPi);
    if (installPi) await tryInstallPi();
  }

  p.outro(pc.green('Setup complete. Run `pi-llm` to get started.'));
}

async function promptForExternalServer(
  existingUrl: string | undefined,
): Promise<string> {
  while (true) {
    const urlIn = await p.text({
      message: 'URL of your llama.cpp server',
      placeholder: existingUrl ?? 'http://localhost:8081',
      initialValue: existingUrl ?? 'http://localhost:8081',
      validate: (v) => {
        if (!v) return 'URL is required';
        try {
          const u = new URL(v);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            return 'URL must be http:// or https://';
          }
        } catch {
          return 'Not a valid URL';
        }
        return undefined;
      },
    });
    exitIfCancelled(urlIn);
    const url = urlIn.trim().replace(/\/$/, '');

    const spinner = p.spinner();
    spinner.start(`Probing ${url}/health ...`);
    const probe = await probeServer(url, 3000);
    if (probe.alive) {
      spinner.stop(
        probe.model
          ? `Server is reachable (loaded model: ${probe.model})`
          : 'Server is reachable',
      );
      return url;
    }
    spinner.stop('Could not reach server');
    const retry = await p.select<'retry' | 'save' | 'cancel'>({
      message: 'How do you want to proceed?',
      options: [
        { value: 'retry', label: 'Try a different URL' },
        { value: 'save', label: 'Save anyway (server may not be up yet)' },
        { value: 'cancel', label: 'Cancel setup' },
      ],
    });
    exitIfCancelled(retry);
    if (retry === 'save') return url;
    if (retry === 'cancel') process.exit(0);
    // else retry loop
  }
}

async function tryInstallPi(): Promise<void> {
  const pkg = '@mariozechner/pi-coding-agent';
  if (have('mise')) {
    const r = spawnSync('mise', ['use', '-g', `npm:${pkg}`], { stdio: 'inherit' });
    if (r.status === 0) {
      p.log.success('Installed pi via mise');
      return;
    }
    p.log.warn('mise install failed, trying npm...');
  }

  if (have('npm')) {
    const r = spawnSync('npm', ['install', '-g', pkg], { stdio: 'inherit' });
    if (r.status === 0) {
      p.log.success('Installed pi via npm');
      return;
    }
    p.log.warn('npm install failed (may need sudo, or use a Node version manager).');
  } else {
    p.log.warn('Neither mise nor npm found.');
  }

  p.log.message(
    [
      'Manual install command:',
      `  npm install -g ${pkg}`,
      '',
      'On Debian/Ubuntu the system nodejs may be too old — consider mise or NodeSource.',
    ].join('\n'),
  );
}
