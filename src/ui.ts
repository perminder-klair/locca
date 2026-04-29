import * as p from '@clack/prompts';
import pc from 'picocolors';

export function header(title = 'pi-llm  ·  local inference') {
  console.log();
  console.log(`  ${pc.magenta(pc.bold(title))}`);
  console.log();
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

export function exitIfCancelled<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel('Cancelled');
    process.exit(0);
  }
}

export { p, pc };
