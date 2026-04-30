import * as readline from 'node:readline';
import * as p from '@clack/prompts';
import pc from 'picocolors';

export function header(title = 'locca  ·  local inference') {
  console.log();
  console.log(`  ${pc.magenta(pc.bold(title))}`);
  console.log();
}

/**
 * Big magenta `locca` wordmark. Used by setup (with tagline) and the menu
 * (without). Stays plain text so anything that follows — Clack's intro box,
 * a status line — renders cleanly underneath.
 */
export function printBanner(opts: { tagline?: boolean } = {}): void {
  const lines = [
    '',
    `  ${pc.magenta('██╗      ██████╗  ██████╗ ██████╗ █████╗')}`,
    `  ${pc.magenta('██║     ██╔═══██╗██╔════╝██╔════╝██╔══██╗')}`,
    `  ${pc.magenta('██║     ██║   ██║██║     ██║     ███████║')}`,
    `  ${pc.magenta('██║     ██║   ██║██║     ██║     ██╔══██║')}`,
    `  ${pc.magenta('███████╗╚██████╔╝╚██████╗╚██████╗██║  ██║')}`,
    `  ${pc.magenta('╚══════╝ ╚═════╝  ╚═════╝ ╚═════╝╚═╝  ╚═╝')}`,
  ];
  if (opts.tagline) {
    lines.push(
      '',
      `  ${pc.dim('Run open-weight LLMs on your own hardware — llama.cpp, GGUFs,')}`,
      `  ${pc.dim('coding agents. No cloud, no keys, your machine, your weights.')}`,
    );
  }
  lines.push('');
  console.log(lines.join('\n'));
}

export function ok(msg: string) {
  p.log.success(msg);
}

export function warn(msg: string) {
  p.log.warn(msg);
}

export function err(msg: string) {
  p.log.error(msg);
}

export function note(msg: string) {
  p.log.message(pc.dim(msg));
}

export function section(title: string) {
  console.log();
  console.log(`  ${pc.magenta(pc.bold(title))}`);
}

/**
 * Sentinel thrown by `exitIfCancelled` when the user cancels (Esc / Ctrl-C)
 * while inside the interactive menu. The menu loop catches this and re-renders
 * its top-level select instead of killing the whole process.
 *
 * Anywhere outside the menu (direct subcommands like `locca download`), cancel
 * still exits cleanly via `process.exit(0)` — that's what users expect from a
 * one-shot CLI invocation.
 */
export const MENU_BACK = Symbol('locca:menu-back');

let menuMode = false;
type KeypressKey = { name?: string; ctrl?: boolean; sequence?: string };
let escKeypressListener:
  | ((str: string | undefined, key: KeypressKey | undefined) => void)
  | null = null;

/**
 * Toggle menu mode. While on:
 *   1. exitIfCancelled throws MENU_BACK instead of exiting.
 *   2. A `keypress` listener on stdin converts standalone Esc into a
 *      synthetic Ctrl-C keypress — Clack 0.8.x only treats `\x03` as cancel
 *      (verified in node_modules/@clack/core/dist/index.mjs), so without this
 *      Esc reaches the prompt's onKeypress and is ignored.
 *
 * We use `keypress` rather than `data` because Clack subscribes to keypress
 * events emitted by readline's parser, not raw stdin data.
 */
export function setMenuMode(on: boolean): void {
  menuMode = on;
  if (on && !escKeypressListener) {
    // Idempotent: emitKeypressEvents guards against double-binding internally,
    // so it's safe to call alongside Clack's own setup. Raw mode is handled
    // by Clack itself for the duration of each prompt — that's the only time
    // keypress events fire per-key, which is also the only time we care.
    readline.emitKeypressEvents(process.stdin);

    escKeypressListener = (_str, key) => {
      if (!menuMode || !key || key.name !== 'escape') return;
      // Re-emit as Ctrl-C. Clack's onKeypress checks `str === '\x03'`,
      // so we must pass `\x03` as the first arg (str), not in `key.sequence`.
      process.stdin.emit('keypress', '\x03', {
        name: 'c',
        ctrl: true,
        sequence: '\x03',
      });
    };
    process.stdin.on('keypress', escKeypressListener);
  } else if (!on && escKeypressListener) {
    process.stdin.off('keypress', escKeypressListener);
    escKeypressListener = null;
  }
}

export function exitIfCancelled<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    if (menuMode) {
      console.log(pc.dim('  ↩ back to menu'));
      throw MENU_BACK;
    }
    p.cancel('Cancelled');
    process.exit(0);
  }
}

export { p, pc };
