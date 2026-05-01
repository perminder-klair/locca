import { existsSync } from 'node:fs';
import { cpus } from 'node:os';
import { CONFIG_FILE, loadConfig, saveConfig } from '../config.js';
import type { Config } from '../types.js';
import { exitIfCancelled, p, pc } from '../ui.js';
import { autoThreads, expandHome } from '../util.js';

const TOTAL_CORES = cpus().length;
const AUTO_THREADS = autoThreads();

/**
 * Schema for every user-editable key in `Config`. Keep this in sync with
 * `src/types.ts` — it's the single source of truth for the `config` command,
 * and (eventually) anywhere else that wants to render a settings UI.
 *
 * `kind` controls the prompt and the parser used by `config set <k> <v>`.
 * `optional: true` means an empty value clears the override (key is removed
 * from the on-disk config so `defaults()` takes over again).
 */
type Kind = 'string' | 'path' | 'number' | 'boolean' | 'enum';

interface Field {
  key: keyof Config;
  label: string;
  kind: Kind;
  optional?: boolean;
  hint?: string;
  /** For `kind: 'enum'` — allowed values (with optional hints). */
  choices?: { value: string; label?: string; hint?: string }[];
  /**
   * For `kind: 'number'` — common preset values shown as a select before
   * falling back to text entry. Helps users who don't have a number in mind.
   */
  presets?: { value: number; label: string; hint?: string }[];
}

const SCHEMA: Field[] = [
  {
    key: 'modelsDir',
    label: 'Models directory',
    kind: 'path',
    hint: 'where .gguf files live',
  },
  { key: 'defaultPort', label: 'Default server port', kind: 'number' },
  {
    key: 'defaultCtx',
    label: 'Default context size',
    kind: 'number',
    hint: 'tokens of conversation history the model can see',
    presets: [
      { value: 4096, label: '4k', hint: 'tiny — chat / quick edits, fits anything' },
      { value: 8192, label: '8k', hint: 'small — short tasks, ~1× VRAM baseline' },
      { value: 16384, label: '16k', hint: 'medium — multi-file edits' },
      { value: 32768, label: '32k', hint: 'recommended default — coding agent workloads' },
      { value: 65536, label: '64k', hint: 'large — repo-wide context, needs ≥16 GB unified/VRAM' },
      { value: 131072, label: '128k', hint: 'long-doc / repo summarisation, heavy on KV cache' },
      { value: 262144, label: '256k', hint: 'extreme — only with q8_0 KV cache + lots of RAM' },
    ],
  },
  {
    key: 'defaultThreads',
    label: 'CPU threads',
    kind: 'number',
    hint: `auto = ${AUTO_THREADS} (system has ${TOTAL_CORES} cores)`,
    presets: [
      {
        value: AUTO_THREADS,
        label: `Auto (${AUTO_THREADS})`,
        hint: 'leave 2 cores for the OS — recommended',
      },
      {
        value: Math.max(1, Math.floor(TOTAL_CORES / 2)),
        label: `Half (${Math.max(1, Math.floor(TOTAL_CORES / 2))})`,
        hint: 'good if you keep using the machine while llama runs',
      },
      {
        value: TOTAL_CORES,
        label: `All cores (${TOTAL_CORES})`,
        hint: 'fastest but the system will feel sluggish',
      },
    ],
  },
  {
    key: 'llamaServer',
    label: 'llama-server binary',
    kind: 'string',
    hint: 'name on PATH or absolute path',
  },
  { key: 'llamaCli', label: 'llama-cli binary', kind: 'string' },
  { key: 'llamaBench', label: 'llama-bench binary', kind: 'string' },
  {
    key: 'vramBudgetMB',
    label: 'VRAM budget (MB)',
    kind: 'number',
    optional: true,
    hint: 'caps auto-picked context window so 128k defaults don\'t OOM',
    presets: [
      { value: 6 * 1024, label: '6 GB', hint: 'caps ctx to 8k' },
      { value: 8 * 1024, label: '8 GB', hint: 'caps ctx to 16k' },
      { value: 12 * 1024, label: '12 GB', hint: 'caps ctx to 32k' },
      { value: 16 * 1024, label: '16 GB', hint: 'caps ctx to 64k' },
      { value: 24 * 1024, label: '24 GB', hint: 'caps ctx to 128k' },
      { value: 32 * 1024, label: '32 GB', hint: 'caps ctx to 128k+' },
    ],
  },
  {
    key: 'piSkills',
    label: 'Pi skills mode',
    kind: 'enum',
    choices: [
      { value: 'lazy', label: 'lazy', hint: '/skill:<name> works, descriptions hidden from system prompt' },
      { value: 'on', label: 'on', hint: "pi's default — descriptions in system prompt" },
      { value: 'off', label: 'off', hint: '--no-skills' },
    ],
  },
  { key: 'piExtensions', label: 'Enable pi extensions', kind: 'boolean' },
  { key: 'piContextFiles', label: 'Enable pi context files', kind: 'boolean' },
];

export async function config(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub) return interactive();

  switch (sub) {
    case 'get':
      return getCmd(args[1]);
    case 'set':
      return setCmd(args[1], args.slice(2).join(' '));
    case 'reset':
    case 'unset':
      return resetCmd(args[1]);
    case 'path':
      console.log(CONFIG_FILE);
      return;
    case 'list':
    case 'ls':
      return listCmd();
    case 'help':
    case '-h':
    case '--help':
      printHelp();
      return;
    default:
      console.error(`Unknown 'config' subcommand: ${sub}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`Usage: locca config [subcommand]

  (no args)           Interactive picker — view and edit any key
  list                Print every key and its current value
  get <key>           Print the current value of <key>
  set <key> <value>   Set <key> (empty value clears optional keys)
  reset <key>         Remove <key>; defaults() takes over
  path                Print the path to config.json

Editable keys:
${SCHEMA.map((f) => `  ${f.key}${f.optional ? pc.dim(' (optional)') : ''}`).join('\n')}`);
}

async function interactive(): Promise<void> {
  while (true) {
    const cfg = loadConfig();
    console.log();
    console.log(`  ${pc.magenta(pc.bold('locca config'))}  ${pc.dim(CONFIG_FILE)}`);
    console.log();

    type Pick = keyof Config | '__exit';
    const picked = await p.select<Pick>({
      message: 'Pick a setting to edit',
      options: [
        ...SCHEMA.map((f) => ({
          value: f.key,
          label: `${f.label.padEnd(28)} ${pc.dim(formatValue(cfg[f.key], f))}`,
          hint: f.hint,
        })),
        { value: '__exit', label: 'Done' },
      ],
    });
    exitIfCancelled(picked);
    if (picked === '__exit') return;

    const field = SCHEMA.find((f) => f.key === picked);
    if (!field) continue;
    await editField(field, cfg);
  }
}

async function editField(field: Field, cfg: Config): Promise<void> {
  const current = cfg[field.key];

  if (field.kind === 'boolean') {
    const v = await p.confirm({
      message: field.label,
      initialValue: Boolean(current),
    });
    exitIfCancelled(v);
    saveConfig({ [field.key]: v } as Partial<Config>);
    p.log.success(`${field.key} = ${v}`);
    return;
  }

  if (field.kind === 'enum') {
    const choices = field.choices ?? [];
    const v = await p.select<string>({
      message: field.label,
      initialValue: typeof current === 'string' ? current : choices[0]?.value,
      options: choices.map((c) => ({ value: c.value, label: c.label ?? c.value, hint: c.hint })),
    });
    exitIfCancelled(v);
    saveConfig({ [field.key]: v } as Partial<Config>);
    p.log.success(`${field.key} = ${v}`);
    return;
  }

  if (field.kind === 'number' && field.presets && field.presets.length > 0) {
    const CUSTOM = '__custom__';
    const CLEAR = '__clear__';
    const opts: { value: string; label: string; hint?: string }[] = field.presets.map((preset) => ({
      value: String(preset.value),
      label: preset.label,
      hint: preset.hint,
    }));
    if (field.optional) {
      opts.push({ value: CLEAR, label: 'No cap', hint: 'clear this setting (use defaults)' });
    }
    opts.push({ value: CUSTOM, label: 'Custom…', hint: 'enter an exact value' });

    const initialValue =
      typeof current === 'number' && field.presets.some((preset) => preset.value === current)
        ? String(current)
        : opts[0]?.value;

    const choice = await p.select<string>({
      message: field.label,
      initialValue,
      options: opts,
    });
    exitIfCancelled(choice);

    if (choice === CLEAR) {
      saveConfig({ [field.key]: undefined } as Partial<Config>);
      p.log.success(`${field.key} cleared`);
      return;
    }

    if (choice !== CUSTOM) {
      const parsed = Number(choice);
      saveConfig({ [field.key]: parsed } as Partial<Config>);
      p.log.success(`${field.key} = ${formatValue(parsed, field)}`);
      return;
    }
    // fall through to text entry
  }

  const placeholder = current === undefined || current === null ? '' : String(current);
  const v = await p.text({
    message: field.optional ? `${field.label} ${pc.dim('(empty to clear)')}` : field.label,
    initialValue: placeholder,
    placeholder,
  });
  exitIfCancelled(v);

  const trimmed = v.trim();
  if (trimmed === '') {
    if (field.optional) {
      saveConfig({ [field.key]: undefined } as Partial<Config>);
      p.log.success(`${field.key} cleared`);
    } else {
      p.log.warn(`${field.key} is required — keeping previous value.`);
    }
    return;
  }

  try {
    const parsed = parseValue(trimmed, field);
    saveConfig({ [field.key]: parsed } as Partial<Config>);
    p.log.success(`${field.key} = ${formatValue(parsed, field)}`);
  } catch (e) {
    p.log.warn(`Invalid value: ${(e as Error).message}`);
  }
}

function getCmd(key: string | undefined): void {
  const field = requireField(key);
  const cfg = loadConfig();
  const v = cfg[field.key];
  if (v === undefined || v === null) return;
  console.log(typeof v === 'string' ? v : String(v));
}

function setCmd(key: string | undefined, raw: string): void {
  const field = requireField(key);
  if (raw === '' && !field.optional) {
    console.error(`${field.key} requires a value.`);
    process.exit(1);
  }
  if (raw === '' && field.optional) {
    saveConfig({ [field.key]: undefined } as Partial<Config>);
    console.log(`${field.key} cleared.`);
    return;
  }
  let parsed: unknown;
  try {
    parsed = parseValue(raw, field);
  } catch (e) {
    console.error(`Invalid value for ${field.key}: ${(e as Error).message}`);
    process.exit(1);
  }
  saveConfig({ [field.key]: parsed } as Partial<Config>);
  console.log(`${field.key} = ${formatValue(parsed, field)}`);
}

function resetCmd(key: string | undefined): void {
  const field = requireField(key);
  saveConfig({ [field.key]: undefined } as Partial<Config>);
  console.log(`${field.key} reset.`);
}

function listCmd(): void {
  const cfg = loadConfig();
  const width = Math.max(...SCHEMA.map((f) => f.key.length));
  console.log();
  for (const f of SCHEMA) {
    console.log(`  ${pc.cyan(f.key.padEnd(width))}  ${formatValue(cfg[f.key], f)}`);
  }
  console.log();
  console.log(pc.dim(`  ${CONFIG_FILE}`));
  console.log();
}

function requireField(key: string | undefined): Field {
  if (!key) {
    console.error('Missing key. See `locca config help` for editable keys.');
    process.exit(1);
  }
  const field = SCHEMA.find((f) => f.key === key);
  if (!field) {
    console.error(`Unknown config key: ${key}`);
    console.error(`Editable keys: ${SCHEMA.map((f) => f.key).join(', ')}`);
    process.exit(1);
  }
  return field;
}

function parseValue(raw: string, field: Field): unknown {
  switch (field.kind) {
    case 'string':
      return raw;
    case 'path': {
      const expanded = expandHome(raw);
      if (!existsSync(expanded)) {
        // Don't reject — directories may be created later (mirrors setup).
        // Fall through with the expanded path.
      }
      return expanded;
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`not a number: ${raw}`);
      return n;
    }
    case 'boolean': {
      const v = raw.toLowerCase();
      if (['true', 'yes', 'y', '1', 'on'].includes(v)) return true;
      if (['false', 'no', 'n', '0', 'off'].includes(v)) return false;
      throw new Error(`expected true/false, got: ${raw}`);
    }
    case 'enum': {
      const allowed = (field.choices ?? []).map((c) => c.value);
      if (!allowed.includes(raw)) {
        throw new Error(`expected one of ${allowed.join('|')}, got: ${raw}`);
      }
      return raw;
    }
  }
}

function formatValue(v: unknown, field: Field): string {
  if (v === undefined || v === null) return pc.dim('<unset>');
  if (field.kind === 'boolean') return v ? pc.green('true') : pc.red('false');
  if (field.kind === 'enum') return pc.cyan(String(v));
  return String(v);
}
