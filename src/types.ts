export interface Config {
  modelsDir: string;
  defaultPort: number;
  defaultCtx: number;
  defaultThreads: number;
  llamaServer: string;
  llamaCli: string;
  llamaBench: string;
  /**
   * Skill loading mode for pi:
   *   - `'lazy'` (default): skills are discoverable and `/skill:<name>` slash
   *     commands work, but their descriptions are stripped from the system
   *     prompt to save context on small local models. Implemented via a tiny
   *     bundled pi extension that strips the `<available_skills>` block from
   *     the prompt at `before_agent_start`.
   *   - `'on'`: skills loaded normally (descriptions in system prompt).
   *   - `'off'`: pass `--no-skills`; skills neither auto-invoke nor slash-invoke.
   *
   * Legacy boolean values are coerced on load: `true` → `'on'`, `false` → `'off'`.
   */
  piSkills?: 'off' | 'lazy' | 'on';
  /**
   * Enable pi's extensions. Default true — pi extensions add tooling like
   * project-rule discovery and custom commands without growing the system
   * prompt much.
   */
  piExtensions?: boolean;
  /**
   * Enable pi's AGENTS.md / CLAUDE.md context-file discovery. Default false —
   * locca passes `--no-context-files` so small local models aren't blown out
   * by large project instruction files. Enable for users who want pi's full
   * project-aware surface.
   */
  piContextFiles?: boolean;
  /**
   * Approximate VRAM budget in MB. Caps the context window that
   * `ctxForModel()` auto-picks per model so 128k defaults don't OOM on
   * smaller GPUs. Does NOT override an explicit `defaultCtx` or a ctx
   * the user types into `locca serve`. Leave unset for no cap.
   */
  vramBudgetMB?: number;
  /**
   * Number of concurrent server slots (`--parallel`). Default `1` — the full
   * context window goes to a single slot. Raise it to serve concurrent
   * clients, but note llama-server splits `--ctx-size` evenly across slots,
   * so per-request context shrinks unless `defaultCtx` is raised to match.
   */
  defaultParallel?: number;
  /**
   * Pass `--no-mmap` to llama-server. Default `false` — mmap is faster and
   * lower-memory on dedicated-VRAM GPUs and Apple Silicon. Set `true` only
   * on Strix Halo / Ryzen AI MAX+ where independent measurements report
   * `+22% pp128` and improved stability when mmap is disabled. Not
   * auto-detected: Strix Halo surfaces under several driver names
   * (`Radeon 8050S/8060S`, `Radeon Graphics`, `RADV STRIX_HALO`), so a
   * wrong guess silently degrades. Manual opt-in is honest about the
   * trade-off.
   */
  noMmap?: boolean;
  /**
   * MTP (Multi-Token Prediction) speculative decoding policy.
   *   - `'auto'` (default): enable `--spec-type draft-mtp` whenever *both* the
   *     llama-server build accepts the flag *and* the GGUF actually ships MTP
   *     head tensors. Either gate failing silently skips it — no startup risk.
   *   - `'off'`: never pass the flag.
   * MTP gives a ~1.5–2x single-stream speedup with <10% extra memory and no
   * separate draft model. Legacy configs missing this key default to 'auto'.
   */
  mtp?: 'auto' | 'off';
  /**
   * Max draft tokens per step for MTP (`--spec-draft-n-max`). Sensible range
   * is 2–4; unset means locca uses 3, the common default.
   */
  mtpDraftMax?: number;
  /**
   * Metadata about a locca-managed llama.cpp install (downloaded by
   * `locca install-llama`). When present, llamaServer/llamaCli/llamaBench
   * point into ~/.locca/bin/llama-cpp/<dir>/. Used by doctor to report
   * the source and offer updates, and by install-llama to clean up old
   * versions.
   */
  llamaBundled?: {
    /** Build tag from llama.cpp release, e.g. "b6814". */
    version: string;
    /** Backend label, e.g. "vulkan", "cuda", "metal", "cpu". */
    backend: string;
    /** Absolute path to the install directory. */
    dir: string;
    /** ISO timestamp of when this was installed. */
    installedAt: string;
  };
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
