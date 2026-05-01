import * as p from '@clack/prompts';
import { allEntries, type CatalogEntry, defaultBuild } from './catalog.js';
import {
  ctxLabel,
  fitHint,
  highestFittingCtx,
  incompatibilitySummary,
  isCompatible,
  memoryBudget,
} from './compat.js';
import { loadConfig } from './config.js';
import { bench } from './commands/bench.js';
import { config } from './commands/config.js';
import { del } from './commands/delete.js';
import { doctor } from './commands/doctor.js';
import { download, downloadCatalogEntry } from './commands/download.js';
import { logs } from './commands/logs.js';
import { optimise } from './commands/optimise.js';
import { pi } from './commands/pi.js';
import { searchHF } from './commands/search.js';
import { serve } from './commands/serve.js';
import { stop } from './commands/stop.js';
import { probeHardware } from './hardware.js';
import { scanModels } from './models.js';
import { serverStatus } from './server.js';
import { MENU_BACK, exitIfCancelled, pc, printBanner, setMenuMode } from './ui.js';
import { formatGB, have } from './util.js';

type Action =
  | 'pi'
  | 'serve'
  | 'switch'
  | 'doctor'
  | 'optimise'
  | 'bench'
  | 'logs'
  | 'download'
  | 'search'
  | 'delete'
  | 'stop'
  | 'config'
  | 'quit';

export async function menu(): Promise<void> {
  let firstRender = true;
  while (true) {
    // Show the full banner (with tagline) only on the first render so the
    // "back to menu" loop doesn't keep redrawing two screens of art.
    printBanner({ tagline: firstRender });
    firstRender = false;
    await renderServerLine();
    renderSetupAlerts();
    console.log();

    const action = await p.select<Action>({
      message: 'What would you like to do?',
      options: [
        { value: 'pi', label: 'Pi       — coding agent (local)' },
        { value: 'serve', label: 'Serve    — start API server' },
        { value: 'stop', label: 'Stop     — stop server' },
        {
          value: 'switch',
          label: 'Switch   — swap server to a different model',
        },
        {
          value: 'doctor',
          label: 'Doctor   — health check (hardware, server, log, config)',
        },
        {
          value: 'optimise',
          label: 'Optimise — ask pi to review and suggest tweaks',
        },
        { value: 'bench', label: 'Bench    — benchmark a model' },
        { value: 'logs', label: 'Logs     — tail server log' },
        { value: 'download', label: 'Download — pull from HuggingFace' },
        { value: 'search', label: 'Search   — find models on HuggingFace' },
        { value: 'delete', label: 'Delete   — remove a model' },
        { value: 'config', label: 'Config   — view / edit settings' },
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
    let cancelled = false;
    try {
      await runAction(action);
    } catch (e) {
      if (!isCancelLike(e)) throw e;
      cancelled = true;
    } finally {
      setMenuMode(false);
    }

    // After a normal completion (e.g. `serve` printed connection info,
    // `status` printed a report), pause so the output stays on screen until
    // the user is ready to redraw the menu over it. On Esc/cancel the user
    // already wants out — skip the pause to keep the back-out snappy.
    if (!cancelled) await pauseUntilEnter();
  }
}

/**
 * Block the menu loop until the user presses Enter, so output from the
 * just-finished action (connection info, status table, etc.) doesn't get
 * scrolled off by the next menu redraw.
 *
 * Stdin is in line-buffered mode here (Clack restored it when its prompt
 * closed), so a single `data` event fires per line — Enter is enough.
 */
async function pauseUntilEnter(): Promise<void> {
  if (!process.stdin.isTTY) return;
  await new Promise<void>((resolve) => {
    const onData = () => {
      process.stdin.off('data', onData);
      resolve();
    };
    process.stdin.on('data', onData);
  });
}

/**
 * Compact one-line server summary, shown above the menu so the user sees
 * what (if anything) is currently running before they pick an action.
 */
async function renderServerLine(): Promise<void> {
  const cfg = loadConfig();
  const s = await serverStatus(cfg);
  if (!s.running) {
    console.log(pc.dim('  ○ No server running'));
    return;
  }
  const tag = s.source === 'pid' ? `pid ${s.pid}` : 'attached';
  const bits: string[] = [];
  if (s.model) bits.push(s.model);
  bits.push(s.url);
  bits.push(tag);
  console.log(pc.green(`  ● Running: ${bits.join(', ')}`));
}

/**
 * Highlight missing prerequisites above the menu so users notice before
 * picking an action that will fail. Both llama.cpp and pi are required
 * for locca's core flows; an empty models dir means there's nothing to
 * actually run.
 */
function renderSetupAlerts(): void {
  const cfg = loadConfig();
  const missing: string[] = [];
  if (!have('llama-server')) missing.push('llama.cpp not installed');
  if (!have('pi')) missing.push('pi (coding agent) not installed');
  let modelsEmpty = false;
  try {
    modelsEmpty = scanModels(cfg.modelsDir).length === 0;
  } catch {
    modelsEmpty = true;
  }
  if (modelsEmpty) missing.push('models directory is empty');

  if (missing.length === 0) return;

  const tag = pc.bgYellow(pc.black(pc.bold(' ACTION REQUIRED ')));
  console.log(`  ${tag} ${pc.yellow(missing.join(' · '))}`);
  console.log(pc.dim(`  Run ${pc.cyan('locca setup')} to fix.`));
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
      await switchModel();
      break;
    case 'doctor':
      await doctor();
      break;
    case 'optimise':
      await optimise();
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
    case 'config':
      await config([]);
      break;
  }
}

/**
 * Catalog-aware "switch model" picker. Surfaces:
 *   1. Already-installed .gguf files (always runnable — they're on disk).
 *   2. Catalog entries grouped by family/size with compatibility hints.
 *
 * Picking an installed model swaps the running server to it and launches pi
 * (preserves the legacy `switch = pi --stop-first` UX). Picking a catalog
 * entry downloads it first, then does the same.
 */
async function switchModel(): Promise<void> {
  const cfg = loadConfig();
  const installed = scanModels(cfg.modelsDir);
  const budget = memoryBudget(probeHardware());

  // Map filename → catalog entry so installed rows can borrow nice metadata.
  const catalog = allEntries();
  const byFile = new Map<string, CatalogEntry>();
  for (const e of catalog) byFile.set(e.build.hfFile.toLowerCase(), e);

  type Pick =
    | { kind: 'installed'; path: string; mmproj?: string; name: string }
    | { kind: 'catalog'; entry: CatalogEntry; compatible: boolean }
    | { kind: 'browse' };

  const options: { value: string; label: string; hint?: string }[] = [];
  const picks = new Map<string, Pick>();

  if (installed.length > 0) {
    options.push({
      value: '__installed_header__',
      label: pc.dim('── Installed ──'),
    });
    picks.set('__installed_header__', { kind: 'browse' });
    for (const m of installed) {
      const id = `inst:${m.path}`;
      const tag = m.hasVision ? ' [vision]' : '';
      const hit = byFile.get(`${m.name.toLowerCase()}.gguf`) ?? byFile.get(m.name.toLowerCase());
      // When a catalog entry exists, reuse the same dl/RAM/ctx hint as
      // catalog rows so the user can compare on the same axes. Otherwise we
      // only have file size on disk — show that and the catalog-derived ctx
      // tier if the filename resolves.
      let hint: string;
      if (hit) {
        hint = fitHint(hit, budget);
      } else {
        const tier = hit ? highestFittingCtx(hit, budget) : undefined;
        hint = `${formatGB(m.sizeBytes)} GB${tier ? ` · ${ctxLabel(tier)} ctx` : ''}`;
      }
      options.push({ value: id, label: `${m.name}${tag}`, hint });
      picks.set(id, {
        kind: 'installed',
        path: m.path,
        mmproj: m.mmprojPath,
        name: m.name,
      });
    }
  }

  // Per (family, size) pick the same row we'd show in setup. Skip families
  // whose models are all already installed — no point showing dupes.
  options.push({ value: '__catalog_header__', label: pc.dim('── Catalog ──') });
  picks.set('__catalog_header__', { kind: 'browse' });
  const installedFiles = new Set(installed.map((m) => `${m.name.toLowerCase()}.gguf`));
  for (const row of catalogRows(budget)) {
    if (installedFiles.has(row.entry.build.hfFile.toLowerCase())) continue;
    const id = `cat:${row.entry.id}`;
    options.push({
      value: id,
      label: `${row.entry.family.name} ${row.entry.size.name} ${row.entry.build.quantization}`,
      hint: row.hint,
    });
    picks.set(id, {
      kind: 'catalog',
      entry: row.entry,
      compatible: row.compatible,
    });
  }

  options.push({
    value: '__browse__',
    label: 'Browse HuggingFace…',
    hint: 'search by name',
  });
  picks.set('__browse__', { kind: 'browse' });

  const choice = await p.select<string>({
    message: 'Switch to which model?',
    options,
  });
  exitIfCancelled(choice);
  const pick = picks.get(choice);
  if (!pick) return;

  if (pick.kind === 'browse') {
    if (choice === '__browse__') {
      await searchHF([]);
    } else {
      // Header rows are non-actionable — just bail back to the menu.
      return;
    }
    return;
  }

  if (pick.kind === 'catalog') {
    if (!pick.compatible) {
      const proceed = await p.confirm({
        message: `${pick.entry.family.name} ${pick.entry.size.name} likely won't fit (${incompatibilitySummary(pick.entry, budget) ?? 'too large'}). Download anyway?`,
        initialValue: false,
      });
      exitIfCancelled(proceed);
      if (!proceed) return;
    }
    try {
      await downloadCatalogEntry(pick.entry);
    } catch (e) {
      p.log.error(`Download failed: ${(e as Error).message}`);
      return;
    }
    // Hand off to pi with stopFirst so it spawns the server fresh against
    // the just-downloaded weights. pi() does its own pickModel — pass the
    // exact filename as a positional pattern so it picks deterministically.
    await pi([pick.entry.build.hfFile], { stopFirst: true });
    return;
  }

  // Installed model: ask pi to start it (replaces the old `switch = pi
  // --stop-first` shortcut).
  await pi([pick.name], { stopFirst: true });
}

interface CatalogRow {
  entry: CatalogEntry;
  hint: string;
  compatible: boolean;
}

function catalogRows(budget: ReturnType<typeof memoryBudget>): CatalogRow[] {
  const buckets = new Map<string, CatalogEntry[]>();
  for (const e of allEntries()) {
    const k = `${e.family.name}|${e.size.name}`;
    const list = buckets.get(k);
    if (list) list.push(e);
    else buckets.set(k, [e]);
  }

  const rows: CatalogRow[] = [];
  for (const variants of buckets.values()) {
    const compat = variants.filter((v) => isCompatible(v, budget));
    const pick =
      defaultBuild(compat) ?? [...variants].sort((a, b) => a.build.fileSize - b.build.fileSize)[0]!;
    const compatible = compat.length > 0;
    const hint = compatible
      ? `${pc.green('fits')} — ${fitHint(pick, budget)}`
      : (incompatibilitySummary(pick, budget) ?? 'too large');
    rows.push({ entry: pick, hint, compatible });
  }
  rows.sort((a, b) => {
    if (a.compatible !== b.compatible) return a.compatible ? -1 : 1;
    if (a.entry.family.name !== b.entry.family.name) {
      return a.entry.family.name.localeCompare(b.entry.family.name);
    }
    return a.entry.size.parameterCount - b.entry.size.parameterCount;
  });
  return rows;
}
