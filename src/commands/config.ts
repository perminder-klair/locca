import { existsSync } from 'node:fs';
import { CONFIG_FILE, loadConfig, saveConfig } from '../config.js';
import type { Config } from '../types.js';
import { exitIfCancelled, p, pc } from '../ui.js';
import { autoThreads, expandHome } from '../util.js';

/**
 * Schema for every user-editable key in `Config`. Keep this in sync with
 * `src/types.ts` — it's the single source of truth for the `config` command,
 * and (eventually) anywhere else that wants to render a settings UI.
 *
 * `kind` controls the prompt and the parser used by `config set <k> <v>`.
 * `optional: true` means an empty value clears the override (key is removed
 * from the on-disk config so `defaults()` takes over again).
 */
type Kind = 'string' | 'path' | 'number' | 'boolean';

interface Field {
  key: keyof Config;
  label: string;
  kind: Kind;
  optional?: boolean;
  hint?: string;
}

const SCHEMA: Field[] = [
  {
    key: 'modelsDir',
    label: 'Models directory',
    kind: 'path',
    hint: 'where .gguf files live',
  },
  { key: 'defaultPort', label: 'Default server port', kind: 'number' },
  { key: 'defaultCtx', label: 'Default context size', kind: 'number' },
  {
    key: 'defaultThreads',
    label: 'CPU threads',
    kind: 'number',
    hint: `auto = ${autoThreads()}`,
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
    key: 'serverUrl',
    label: 'External server URL',
    kind: 'string',
    optional: true,
    hint: 'set to use a remote llama.cpp instead of spawning one',
  },
  {
    key: 'vramBudgetMB',
    label: 'VRAM budget (MB)',
    kind: 'number',
    optional: true,
    hint: 'caps auto-picked context window',
  },
  {
    key: 'piSkillDir',
    label: 'Pi skill directory',
    kind: 'path',
    optional: true,
  },
  { key: 'piSkills', label: 'Enable pi skills', kind: 'boolean' },
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

  const placeholder =
    current === undefined || current === null ? '' : String(current);
  const v = await p.text({
    message: field.optional
      ? `${field.label} ${pc.dim('(empty to clear)')}`
      : field.label,
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
    console.log(
      `  ${pc.cyan(f.key.padEnd(width))}  ${formatValue(cfg[f.key], f)}`,
    );
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
  }
}

function formatValue(v: unknown, field: Field): string {
  if (v === undefined || v === null) return pc.dim('<unset>');
  if (field.kind === 'boolean') return v ? pc.green('true') : pc.red('false');
  return String(v);
}
