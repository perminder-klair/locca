import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import * as p from "@clack/prompts";
import { allEntries, type CatalogEntry, defaultBuild } from "./catalog.js";
import {
  fitHint,
  incompatibilitySummary,
  isCompatible,
  memoryBudget,
} from "./compat.js";
import { downloadCatalogEntry } from "./commands/download.js";
import { searchHF } from "./commands/search.js";
import { CONFIG_FILE, loadConfig, saveConfig } from "./config.js";
import { detectDistro, renderLlamaInstallHint } from "./distro.js";
import { probeHardware } from "./hardware.js";
import { scanModels } from "./models.js";
import { exitIfCancelled, pc, printBanner } from "./ui.js";
import { autoThreads, expandHome, have } from "./util.js";

export async function runSetup(): Promise<void> {
  printBanner({ tagline: true });
  p.intro(
    `${pc.bgMagenta(pc.black(pc.bold(" locca ")))}  ${pc.magenta("setup")}`,
  );
  p.log.message(
    [
      `${pc.magenta("▸")} Pick a models folder`,
      `${pc.magenta("▸")} Confirm llama.cpp is installed ${pc.dim("(locca spawns it for you)")}`,
      `${pc.magenta("▸")} Tune defaults ${pc.dim("(port, context, threads, VRAM budget)")}`,
      "",
      pc.dim("Saved to ~/.locca/config.json — re-run `locca setup` anytime."),
    ].join("\n"),
  );

  const existing = loadConfig();
  const totalCores = autoThreads() + 2; // autoThreads = nproc - 2
  const threadDefault = autoThreads();

  // Models directory
  const modelsDirIn = await p.text({
    message: "Where do you keep .gguf models?",
    placeholder: existing.modelsDir,
    initialValue: existing.modelsDir,
  });
  exitIfCancelled(modelsDirIn);
  const modelsDir = expandHome(modelsDirIn || existing.modelsDir);

  if (!existsSync(modelsDir)) {
    const create = await p.confirm({
      message: `Directory does not exist. Create ${modelsDir}?`,
      initialValue: true,
    });
    exitIfCancelled(create);
    if (create) {
      mkdirSync(modelsDir, { recursive: true });
      p.log.success(`Created ${modelsDir}`);
    } else {
      p.log.warn("Skipped — locca will fail until this directory exists.");
    }
  }

  // ── llama.cpp presence check ────────────────────────────────────────
  const llamaPresent = have("llama-server");
  const distro = detectDistro();

  if (llamaPresent) {
    p.log.success(
      `llama-server is on PATH — locca will spawn it for you ${pc.dim(`(detected ${distro.prettyName})`)}`,
    );
  } else {
    p.log.warn(
      `llama-server NOT found in PATH ${pc.dim(`(detected ${distro.prettyName})`)} — install instructions at the end of setup.`,
    );
  }

  // Server defaults (port/ctx/threads).
  const useDefaults = await p.confirm({
    message: `Use sensible defaults? (port 8080, ctx 32768, threads ${threadDefault} of ${totalCores} cores)`,
    initialValue: true,
  });
  exitIfCancelled(useDefaults);

  let port = 8080;
  let ctx = 32768;
  let threads = threadDefault;

  if (!useDefaults) {
    const portIn = await p.text({ message: "Port", initialValue: "8080" });
    exitIfCancelled(portIn);
    port = parseInt(portIn, 10) || 8080;

    const ctxIn = await p.text({
      message: "Context size",
      initialValue: "32768",
    });
    exitIfCancelled(ctxIn);
    ctx = parseInt(ctxIn, 10) || 32768;

    const threadsIn = await p.text({
      message: `CPU threads (system has ${totalCores})`,
      initialValue: String(threadDefault),
    });
    exitIfCancelled(threadsIn);
    threads = parseInt(threadsIn, 10) || threadDefault;
  }

  // VRAM budget — caps auto-picked ctx so small GPUs don't OOM on 128k.
  // Stored in MB; `undefined` means no cap (current behaviour).
  const vramBudgetMB = await promptForVramBudget(existing.vramBudgetMB);

  // pi skills / extensions — off by default (locca passes --no-skills /
  // --no-extensions). Enable for users who want pi's full agentic surface.
  const piSkills = await p.confirm({
    message: "Enable pi's skills?",
    initialValue: existing.piSkills ?? false,
  });
  exitIfCancelled(piSkills);

  const piExtensions = await p.confirm({
    message: "Enable pi's extensions?",
    initialValue: existing.piExtensions ?? false,
  });
  exitIfCancelled(piExtensions);

  const piContextFiles = await p.confirm({
    message: "Enable pi's AGENTS.md / CLAUDE.md context files?",
    initialValue: existing.piContextFiles ?? false,
  });
  exitIfCancelled(piContextFiles);

  saveConfig({
    modelsDir,
    defaultPort: port,
    defaultCtx: ctx,
    defaultThreads: threads,
    vramBudgetMB,
    piSkills,
    piExtensions,
    piContextFiles,
  });
  p.log.success(`Wrote ${CONFIG_FILE}`);

  // Offer to grab a starter model when the modelsDir is empty — without
  // weights locca can't actually run anything, and discovering
  // `locca download` on their own is friction.
  if (scanModels(modelsDir).length === 0) {
    await promptForFirstModel();
  }

  // pi (coding agent)
  if (have("pi")) {
    p.log.success("pi (coding agent) found");
  } else {
    const installPi = await p.confirm({
      message: "Install 'pi' coding agent now?",
      initialValue: true,
    });
    exitIfCancelled(installPi);
    if (installPi) await tryInstallPi();
  }

  if (!llamaPresent) {
    p.log.warn(
      `${pc.bgYellow(pc.black(pc.bold(" ACTION REQUIRED ")))} ${pc.yellow(pc.bold("llama-server is not yet on PATH."))}`,
    );
    p.log.message(renderLlamaInstallHint());
    p.log.message(
      pc.dim(
        `If you built it elsewhere, set llamaServer/llamaCli in ${CONFIG_FILE} to absolute paths.`,
      ),
    );
  }

  p.outro(pc.green("Setup complete. Run `locca` to get started."));
}

async function promptForVramBudget(
  existing: number | undefined,
): Promise<number | undefined> {
  const initial = existing ?? 0;
  const choice = await p.select<number>({
    message: "Approximate VRAM budget? (caps auto-picked context window)",
    initialValue: initial,
    options: [
      {
        value: 0,
        label: "Skip / unlimited",
        hint: "no cap on auto-picked ctx",
      },
      { value: 6 * 1024, label: "6 GB", hint: "caps ctx to 8k" },
      { value: 8 * 1024, label: "8 GB", hint: "caps ctx to 16k" },
      { value: 12 * 1024, label: "12 GB", hint: "caps ctx to 32k" },
      { value: 16 * 1024, label: "16 GB", hint: "caps ctx to 64k" },
      { value: 24 * 1024, label: "24 GB or more", hint: "no cap (full 128k)" },
    ],
  });
  exitIfCancelled(choice);
  return choice > 0 ? choice : undefined;
}

async function promptForFirstModel(): Promise<void> {
  p.log.message("Your models directory is empty — locca needs a .gguf to run.");

  const budget = memoryBudget(probeHardware());
  p.log.message(
    pc.dim(`  Detected ${budget.description} — using that to recommend a fit.`),
  );

  // One row per (family, size) pick the catalog's preferred build (full-precision
  // when it fits, otherwise the smallest quant). Showing one row per quant would
  // explode the list and force the user to know quant tags.
  const rows = pickBuildsForFirstRunMenu(budget);

  while (true) {
    type Choice = string | "browse" | "skip";
    const choice = await p.select<Choice>({
      message: "Grab a starter model now?",
      initialValue:
        rows.find((r) => r.compatible)?.entry.id ?? rows[0]?.entry.id ?? "skip",
      options: [
        ...rows.map((r) => ({
          value: r.entry.id,
          label: r.label,
          hint: r.hint,
        })),
        {
          value: "browse",
          label: "Browse HuggingFace…",
          hint: "search by name",
        },
        {
          value: "skip",
          label: "Skip — add models later with `locca download`",
        },
      ],
    });
    exitIfCancelled(choice);

    if (choice === "skip") {
      p.log.message(
        "Add a model anytime with `locca download <repo>` or `locca search`.",
      );
      return;
    }

    if (choice === "browse") {
      try {
        await searchHF([]);
      } catch (e) {
        p.log.warn(`Search failed: ${(e as Error).message}`);
      }
      return;
    }

    const picked = rows.find((r) => r.entry.id === choice);
    if (!picked) return;

    if (!picked.compatible) {
      const proceed = await p.confirm({
        message: `${picked.entry.family.name} ${picked.entry.size.name} likely won't fit (${picked.hint}). Download anyway?`,
        initialValue: false,
      });
      exitIfCancelled(proceed);
      if (!proceed) continue;
    }

    try {
      await downloadCatalogEntry(picked.entry);
    } catch (e) {
      p.log.warn(`Model download failed: ${(e as Error).message}`);
      p.log.message(
        "You can retry later with `locca download` or `locca search`.",
      );
    }
    return;
  }
}

interface FirstRunRow {
  entry: CatalogEntry;
  label: string;
  hint: string;
  compatible: boolean;
}

/**
 * For each (family, size) in the catalog, pick the build we want to surface
 * in the first-run menu and tag it with a compatibility hint. Compatible rows
 * (full-precision preferred, then quantized fallback) sort first; incompatible
 * rows stay visible so users learn what their RAM can reach.
 */
function pickBuildsForFirstRunMenu(
  budget: ReturnType<typeof memoryBudget>,
): FirstRunRow[] {
  const entries = allEntries();
  // Group by (family.name, size.name) so we render one row per size.
  const buckets = new Map<string, CatalogEntry[]>();
  for (const e of entries) {
    const key = `${e.family.name}|${e.size.name}`;
    const list = buckets.get(key);
    if (list) list.push(e);
    else buckets.set(key, [e]);
  }

  const rows: FirstRunRow[] = [];
  for (const variants of buckets.values()) {
    const compat = variants.filter((v) => isCompatible(v, budget));
    const pick =
      defaultBuild(compat) ??
      // Nothing fits — show the smallest quant so the row carries an honest
      // "needs N GB" hint rather than disappearing.
      [...variants].sort((a, b) => a.build.fileSize - b.build.fileSize)[0]!;

    const compatible = compat.length > 0;
    const hint = compatible
      ? `${pc.green("fits")} — ${fitHint(pick, budget)}`
      : (incompatibilitySummary(pick, budget) ?? "too large");

    rows.push({
      entry: pick,
      label: `${pick.family.name} ${pick.size.name} ${pick.build.quantization}`,
      hint,
      compatible,
    });
  }

  // Compatible first; within each group, smaller models first so the
  // "easy first download" sits at the top.
  rows.sort((a, b) => {
    if (a.compatible !== b.compatible) return a.compatible ? -1 : 1;
    return a.entry.size.parameterCount - b.entry.size.parameterCount;
  });
  return rows;
}

async function tryInstallPi(): Promise<void> {
  const pkg = "@mariozechner/pi-coding-agent";
  if (have("mise")) {
    const r = spawnSync("mise", ["use", "-g", `npm:${pkg}`], {
      stdio: "inherit",
    });
    if (r.status === 0) {
      p.log.success("Installed pi via mise");
      return;
    }
    p.log.warn("mise install failed, trying npm...");
  }

  if (have("npm")) {
    const r = spawnSync("npm", ["install", "-g", pkg], { stdio: "inherit" });
    if (r.status === 0) {
      p.log.success("Installed pi via npm");
      return;
    }
    p.log.warn(
      "npm install failed (may need sudo, or use a Node version manager).",
    );
  } else {
    p.log.warn("Neither mise nor npm found.");
  }

  p.log.message(
    [
      "Manual install command:",
      `  npm install -g ${pkg}`,
      "",
      "On Debian/Ubuntu the system nodejs may be too old — consider mise or NodeSource.",
    ].join("\n"),
  );
}
