import * as p from '@clack/prompts';

/**
 * Flags shared by `locca serve` and `locca embed`. Both commands exist for
 * scripts as much as for humans, so parsing is strict: a non-numeric value
 * for a numeric flag or an unrecognised flag is a hard error — silently
 * falling back to config defaults is the worst failure mode for automation.
 */
export interface CommonServeFlags {
  pattern?: string;
  port?: number;
  ctx?: number;
  threads?: number;
  /** Bind host for llama-server. Overrides `cfg.defaultHost`. */
  host?: string;
  /** Passed through as llama-server `--api-key`. */
  apiKey?: string;
  yes: boolean;
}

/**
 * Parse the common flag set. Flags accept both `--flag value` and
 * `--flag=value`. `extra` gets first refusal on anything the common set
 * doesn't recognise (serve's `-f`/`--idle-timeout`); return true to claim it.
 * The first bare word becomes the model pattern; anything else errors.
 */
export function parseCommonServeFlags(
  rest: string[],
  extra?: (arg: string, take: () => string | undefined) => boolean,
): CommonServeFlags {
  const out: CommonServeFlags = { yes: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const take = () => rest[++i];
    if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--port' || a.startsWith('--port=')) out.port = numFlag('--port', a, take);
    else if (a === '--ctx' || a.startsWith('--ctx=')) out.ctx = numFlag('--ctx', a, take);
    else if (a === '--threads' || a.startsWith('--threads='))
      out.threads = numFlag('--threads', a, take);
    else if (a === '--host' || a.startsWith('--host=')) out.host = strFlag('--host', a, take);
    else if (a === '--api-key' || a.startsWith('--api-key='))
      out.apiKey = strFlag('--api-key', a, take);
    else if (extra?.(a, take)) {
      // claimed by the command-specific handler
    } else if (!a.startsWith('-') && out.pattern === undefined) out.pattern = a;
    else if (a.startsWith('-')) fatalFlag(`Unknown flag '${a}'.`);
    else fatalFlag(`Unexpected argument '${a}' — the model pattern is already '${out.pattern}'.`);
  }
  return out;
}

/** Value of a `--flag value` / `--flag=value` pair; errors when missing/empty. */
export function strFlag(name: string, arg: string, take: () => string | undefined): string {
  const raw = arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : take();
  if (raw === undefined || raw === '') fatalFlag(`${name} requires a value.`);
  return raw;
}

/** Like strFlag but parsed as a positive integer; errors on anything else. */
export function numFlag(name: string, arg: string, take: () => string | undefined): number {
  const raw = strFlag(name, arg, take);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    fatalFlag(`${name} expects a positive integer, got '${raw}'.`);
  }
  return n;
}

function fatalFlag(msg: string): never {
  p.log.error(msg);
  process.exit(1);
}
