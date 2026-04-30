import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as p from '@clack/prompts';
import search from '@inquirer/search';
import { loadConfig } from '../config.js';
import { downloadFile, fileSize, listFiles, parseRepo } from '../hf.js';
import { exitIfCancelled, pc } from '../ui.js';
import { formatGB } from '../util.js';

export async function download(args: string[]): Promise<void> {
  const cfg = loadConfig();
  let repo: string;

  if (args[0]) {
    repo = parseRepo(args[0]);
  } else {
    const input = await p.text({
      message: 'HuggingFace model',
      placeholder: 'user/repo or HuggingFace URL',
    });
    exitIfCancelled(input);
    if (!input) return;
    repo = parseRepo(input);
  }

  console.log();
  console.log(pc.magenta(`Fetching files from ${repo}...`));

  let files: string[];
  try {
    files = await listFiles(repo);
  } catch (e) {
    p.log.error(`Could not fetch model info. ${(e as Error).message}`);
    process.exit(1);
  }

  const ggufs = files
    .filter((f) => f.endsWith('.gguf') && !/(^|\/)mmproj/i.test(f))
    .sort();
  if (ggufs.length === 0) {
    p.log.error(`No GGUF files found in ${repo}`);
    process.exit(1);
  }

  const mmprojFile = files.find((f) => /(^|\/)mmproj.*\.gguf$/i.test(f));
  if (mmprojFile) {
    p.log.success(`Vision projector available: ${mmprojFile}`);
  }

  // Pre-fetch sizes (HEAD per file) so the picker shows them.
  const spinner = p.spinner();
  spinner.start('Reading file sizes...');
  const sized = await Promise.all(
    ggufs.map(async (f) => ({ file: f, size: await fileSize(repo, f) })),
  );
  spinner.stop(`${ggufs.length} GGUF files`);

  const annotated = sized.map((s) => ({ ...s, q: classifyQuant(s.file) }));
  const recommended = pickRecommended(annotated);
  if (recommended) {
    p.log.info(
      `Tip: ${pc.bold('Q4_K_M')} is the usual sweet spot (quality vs. size). ${pc.bold('Q8_0')} is near-lossless but ~2× larger; ${pc.bold('Q2_K/Q3_K')} are smallest but noticeably worse.`,
    );
  }

  // Put the recommended file first so @inquirer/search highlights it by default.
  const ordered = recommended
    ? [
        ...annotated.filter((i) => i.file === recommended),
        ...annotated.filter((i) => i.file !== recommended),
      ]
    : annotated;

  const selected = await search<string>({
    message: 'Select quantization',
    source: async (input) => {
      const q = (input ?? '').toLowerCase();
      return ordered
        .filter(({ file }) => !q || file.toLowerCase().includes(q))
        .map(({ file, size, q: info }) => {
          const star = file === recommended ? pc.green('★ ') : '  ';
          const sizeStr = size != null ? `${formatGB(size)} GB` : '?';
          const tag = info ? pc.dim(`— ${info}`) : '';
          return {
            name: `${star}${file.padEnd(58)}  ${sizeStr.padEnd(9)} ${tag}`,
            value: file,
          };
        });
    },
  });
  if (!selected) return;

  const repoBase = repo.split('/').pop() ?? repo;
  const destDir = join(cfg.modelsDir, repoBase);
  mkdirSync(destDir, { recursive: true });

  console.log();
  console.log(pc.magenta(pc.bold('Downloading...')));
  console.log(`  File: ${selected}`);
  console.log(`  To:   ${destDir}/`);
  console.log();

  await downloadWithProgress(repo, selected, join(destDir, basename(selected)));

  if (mmprojFile) {
    const wantMmproj = await p.confirm({
      message: 'Download vision projector too?',
      initialValue: true,
    });
    exitIfCancelled(wantMmproj);
    if (wantMmproj) {
      await downloadWithProgress(repo, mmprojFile, join(destDir, basename(mmprojFile)));
    }
  }

  console.log();
  p.log.success('Download complete');
}

async function downloadWithProgress(
  repo: string,
  file: string,
  dest: string,
): Promise<void> {
  let last = 0;
  const startTs = Date.now();
  await downloadFile(repo, file, dest, (got, total) => {
    // Throttle redraws to ~10/sec.
    const now = Date.now();
    if (now - last < 100 && got !== total) return;
    last = now;
    if (total > 0) {
      const pct = ((got / total) * 100).toFixed(1);
      const gotGB = formatGB(got);
      const totalGB = formatGB(total);
      const speed = ((got / 1024 / 1024) / Math.max(1, (now - startTs) / 1000)).toFixed(1);
      process.stdout.write(`\r  ${pct.padStart(5)}%  ${gotGB}/${totalGB} GB  ${speed} MB/s   `);
    } else {
      process.stdout.write(`\r  ${formatGB(got)} GB   `);
    }
  });
  process.stdout.write('\n');
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/**
 * Map a GGUF filename to a short human hint based on its quant tag.
 * Returns undefined if no recognisable tag (we don't want to lie).
 */
function classifyQuant(file: string): string | undefined {
  const f = file.toUpperCase();
  if (/\bF32\b/.test(f)) return 'full precision (huge)';
  if (/\b(F16|FP16|BF16)\b/.test(f)) return 'half precision (very large)';
  if (/\bQ8_0\b/.test(f)) return 'near-lossless, ~2× size';
  if (/\bQ6_K\b/.test(f)) return 'high quality, larger';
  if (/\bQ5_K_M\b/.test(f)) return 'high quality';
  if (/\bQ5_K_S\b/.test(f)) return 'high quality, smaller';
  if (/\bQ5_(0|1)\b/.test(f)) return 'legacy 5-bit';
  if (/\bQ4_K_M\b/.test(f)) return 'balanced (recommended)';
  if (/\bQ4_K_S\b/.test(f)) return 'balanced, smaller';
  if (/\bQ4_(0|1)\b/.test(f)) return 'legacy 4-bit';
  if (/\bIQ4_XS\b/.test(f)) return 'small, decent quality';
  if (/\bIQ4_NL\b/.test(f)) return 'small, decent quality';
  if (/\bQ3_K_L\b/.test(f)) return 'small, quality drops';
  if (/\bQ3_K_M\b/.test(f)) return 'small, quality drops';
  if (/\bQ3_K_S\b/.test(f)) return 'very small, quality drops';
  if (/\bIQ3_/.test(f)) return 'very small (imatrix)';
  if (/\bQ2_K\b/.test(f)) return 'smallest, noticeable loss';
  if (/\bIQ2_/.test(f)) return 'tiny (imatrix), lossy';
  if (/\bIQ1_/.test(f)) return 'extreme low-bit, lossy';
  return undefined;
}

/**
 * Pick a sensible default to star in the list. Preference order matches what
 * most users want for general use: Q4_K_M > Q4_K_S > Q5_K_M > Q4_0 > smallest.
 */
function pickRecommended(
  items: Array<{ file: string; size: number | null }>,
): string | undefined {
  const byTag = (re: RegExp) => items.find((i) => re.test(i.file.toUpperCase()))?.file;
  return (
    byTag(/\bQ4_K_M\b/) ??
    byTag(/\bQ4_K_S\b/) ??
    byTag(/\bQ5_K_M\b/) ??
    byTag(/\bQ4_0\b/) ??
    items[0]?.file
  );
}
