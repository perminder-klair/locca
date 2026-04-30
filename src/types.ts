export interface Config {
  modelsDir: string;
  defaultPort: number;
  defaultCtx: number;
  defaultThreads: number;
  llamaServer: string;
  llamaCli: string;
  llamaBench: string;
  piSkillDir?: string;
  /**
   * Optional URL of an externally-managed llama.cpp server (e.g. one you
   * started yourself, or one on another machine on your LAN). When set,
   * pi-llm uses this URL instead of spawning its own server. Commands
   * like `serve`, `stop`, `logs` are disabled in this mode.
   */
  serverUrl?: string;
}

export interface Model {
  name: string;
  path: string;
  dir: string;
  sizeBytes: number;
  sizeGB: number;
  hasVision: boolean;
  mmprojPath?: string;
}
