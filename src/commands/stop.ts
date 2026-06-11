import * as p from '@clack/prompts';
import { loadConfig } from '../config.js';
import { stopServer } from '../server.js';

export async function stop(): Promise<void> {
  const cfg = loadConfig();

  // Stop both the chat server and the embedding sidecar (if either is
  // locca-managed). Each stop is independent — one being absent or attached
  // doesn't affect the other.
  const chat = await stopServer(cfg, 'chat');
  const embed = await stopServer(cfg, 'embed');

  let stopped = false;
  if (chat.stopped) {
    p.log.success(`Chat server stopped (pid ${chat.pid})`);
    stopped = true;
  }
  if (embed.stopped) {
    p.log.success(`Embedding server stopped (pid ${embed.pid})`);
    stopped = true;
  }

  if (!stopped) {
    // Neither was locca-managed. Surface the chat reason; mention the embed
    // one too when it differs (e.g. an attached embedding server).
    const chatReason = chat.stopped ? 'no server running' : chat.reason;
    p.log.message(chatReason);
    if (!embed.stopped && embed.reason !== chatReason && embed.reason !== 'no server running') {
      p.log.message(`embedding: ${embed.reason}`);
    }
  }
}
