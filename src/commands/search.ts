import * as p from '@clack/prompts';
import search from '@inquirer/search';
import { searchModels } from '../hf.js';
import { exitIfCancelled, pc } from '../ui.js';
import { download } from './download.js';

export async function searchHF(args: string[]): Promise<void> {
  let query = args.join(' ').trim();
  if (!query) {
    const input = await p.text({
      message: 'Search HuggingFace',
      placeholder: 'e.g. gemma uncensored gguf',
    });
    exitIfCancelled(input);
    if (!input) return;
    query = input.trim();
  }

  console.log();
  console.log(pc.magenta(`Searching for '${query}'...`));
  console.log();

  const results = await searchModels(query);
  if (results.length === 0) {
    p.log.message('No results found.');
    return;
  }

  const lines = results.map(
    (r) => `${r.id.padEnd(55)}  ↓${String(r.downloads).padEnd(8)}  ♥ ${r.likes}`,
  );

  const choice = await search<string>({
    message: 'Pick a model',
    source: async (input) => {
      const q = (input ?? '').toLowerCase();
      return results
        .map((r, i) => ({ id: r.id, line: lines[i]! }))
        .filter(({ id }) => !q || id.toLowerCase().includes(q))
        .map(({ id, line }) => ({ name: line, value: id }));
    },
  });
  if (!choice) return;
  await download([choice]);
}
