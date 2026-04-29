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

  const selected = await search<string>({
    message: 'Select quantization',
    source: async (input) => {
      const q = (input ?? '').toLowerCase();
      return sized
        .filter(({ file }) => !q || file.toLowerCase().includes(q))
        .map(({ file, size }) => ({
          name: `${file.padEnd(60)}  ${size != null ? `${formatGB(size)} GB` : '?'}`,
          value: file,
        }));
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
