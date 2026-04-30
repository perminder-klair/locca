import * as p from '@clack/prompts';
import { loadConfig } from '../config.js';
import { type DoctorReport, type Finding, runDoctor } from '../doctor.js';
import { header, pc } from '../ui.js';
import { formatGB } from '../util.js';

export async function doctor(): Promise<void> {
  const cfg = loadConfig();
  header();

  const spinner = p.spinner();
  spinner.start('Running checks...');
  const report = await runDoctor(cfg);
  spinner.stop('Checks complete.');

  renderDoctor(report);
}

export function renderDoctor(report: DoctorReport): void {
  renderHardware(report);
  console.log();
  renderLlama(report);
  console.log();
  renderServer(report);
  console.log();
  renderModels(report);
  console.log();
  renderPi(report);
  console.log();
  renderLogWarnings(report);
  console.log();
  renderFindings(report.findings);
  console.log();
  renderSummary(report.findings);
  console.log();
}

function renderHardware(r: DoctorReport): void {
  console.log(`  ${pc.magenta(pc.bold('Hardware'))}`);
  console.log(
    `    CPUs         ${r.hw.cpus}  ${pc.dim(`(defaultThreads = ${r.cfg.defaultThreads})`)}`,
  );
  console.log(
    `    RAM          ${(r.hw.ramTotalMB / 1024).toFixed(1)} GiB total  ${pc.dim(`(${(r.hw.ramFreeMB / 1024).toFixed(1)} GiB free)`)}`,
  );
  if (r.hw.gpus.length === 0) {
    console.log(`    GPU          ${pc.yellow('none detected')}`);
    return;
  }
  for (const g of r.hw.gpus) {
    const vram = g.vramTotalMB
      ? `${(g.vramTotalMB / 1024).toFixed(1)} GiB${g.vramFreeMB !== undefined ? ` (${(g.vramFreeMB / 1024).toFixed(1)} GiB free)` : ''}`
      : pc.dim('VRAM unknown');
    console.log(
      `    GPU          ${g.name}  ${pc.dim(`[${g.vendor}, via ${g.source}]`)}`,
    );
    console.log(`                 ${vram}`);
  }
}

function renderLlama(r: DoctorReport): void {
  console.log(`  ${pc.magenta(pc.bold('llama.cpp'))}`);
  if (!r.llamaServerPath) {
    console.log(`    ${pc.red('not in PATH')}  ${pc.dim(`(looking for: ${r.cfg.llamaServer})`)}`);
    return;
  }
  console.log(`    Path         ${r.llamaServerPath}`);
  if (r.llamaServerVersion) {
    const firstLines = r.llamaServerVersion.split('\n').slice(0, 2).join('\n                 ');
    console.log(`    Version      ${firstLines}`);
  }
}

function renderServer(r: DoctorReport): void {
  console.log(`  ${pc.magenta(pc.bold('Server'))}`);
  if (!r.status.running) {
    console.log(`    ${pc.dim('○ not running')}`);
    return;
  }
  const sourceLabel =
    r.status.source === 'pid'
      ? `locca-managed (pid ${r.status.pid})`
      : r.status.source === 'external'
        ? 'external (configured serverUrl)'
        : 'attached (started outside locca)';
  console.log(`    ${pc.green('● running')}  ${pc.dim(sourceLabel)}`);
  console.log(`    Model        ${r.status.model ?? pc.dim('(unknown)')}`);
  console.log(`    URL          ${r.status.url}/v1`);
  if (r.liveCtx) {
    const train = r.liveCtxTrain ? pc.dim(` / ${r.liveCtxTrain.toLocaleString()} train`) : '';
    console.log(`    Context      ${r.liveCtx.toLocaleString()} tokens${train}`);
  }
}

function renderModels(r: DoctorReport): void {
  console.log(`  ${pc.magenta(pc.bold('Models'))}`);
  if (r.models.length === 0) {
    console.log(`    ${pc.dim('(none found in')} ${r.cfg.modelsDir}${pc.dim(')')}`);
    return;
  }
  const totalBytes = r.models.reduce((s, m) => s + m.sizeBytes, 0);
  console.log(`    ${r.cfg.modelsDir}`);
  console.log(
    `    ${pc.dim(`${r.models.length} model${r.models.length === 1 ? '' : 's'}, ${formatGB(totalBytes)} GiB total`)}`,
  );
}

function renderPi(r: DoctorReport): void {
  console.log(`  ${pc.magenta(pc.bold('pi'))}`);
  if (!r.piInstalled) {
    console.log(`    ${pc.dim('not installed (only needed for `locca pi` and `locca optimise`)')}`);
    return;
  }
  console.log(`    Installed    ${pc.green('yes')}`);
  if (!r.piModelsJsonExists) {
    console.log(`    models.json  ${pc.dim('not yet created')}`);
  } else if (!r.piHasLoccaProvider) {
    console.log(`    locca entry  ${pc.yellow('not registered')}`);
  } else {
    console.log(`    locca entry  ${pc.green('registered')}`);
  }
}

function renderLogWarnings(r: DoctorReport): void {
  console.log(`  ${pc.magenta(pc.bold('Server log'))}`);
  if (r.logWarnings.length === 0) {
    console.log(`    ${pc.dim('no known warning patterns matched')}`);
    return;
  }
  for (const w of r.logWarnings) {
    console.log(`    ${pc.yellow('•')} ${w.label}  ${pc.dim(`(×${w.count})`)}`);
    console.log(`      ${pc.dim(w.example)}`);
  }
}

function renderFindings(findings: Finding[]): void {
  console.log(`  ${pc.magenta(pc.bold('Findings'))}`);
  if (findings.length === 0) {
    console.log(`    ${pc.green('✓ nothing to flag')}`);
    return;
  }
  for (const f of findings) {
    const icon =
      f.severity === 'error'
        ? pc.red('✗')
        : f.severity === 'warn'
          ? pc.yellow('!')
          : pc.cyan('i');
    console.log(`    ${icon} ${pc.bold(`[${f.section}]`)} ${f.title}`);
    if (f.detail) console.log(`        ${pc.dim(f.detail)}`);
    if (f.suggestion) console.log(`        ${pc.dim('→')} ${f.suggestion}`);
  }
}

function renderSummary(findings: Finding[]): void {
  if (findings.length === 0) return;
  const counts = { info: 0, warn: 0, error: 0 } as Record<Finding['severity'], number>;
  for (const f of findings) counts[f.severity]++;
  const parts: string[] = [];
  if (counts.error) parts.push(pc.red(`${counts.error} error${counts.error === 1 ? '' : 's'}`));
  if (counts.warn) parts.push(pc.yellow(`${counts.warn} warning${counts.warn === 1 ? '' : 's'}`));
  if (counts.info) parts.push(pc.cyan(`${counts.info} note${counts.info === 1 ? '' : 's'}`));
  console.log(`  ${pc.dim('─'.repeat(50))}`);
  console.log(`  ${parts.join(', ')}`);
  console.log(`  ${pc.dim('Run `locca optimise` for an LLM-driven review.')}`);
}
