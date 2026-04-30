import { readFileSync } from 'node:fs';
import pc from 'picocolors';

export type DistroId =
  | 'arch'
  | 'debian'
  | 'ubuntu'
  | 'fedora'
  | 'rhel'
  | 'opensuse'
  | 'alpine'
  | 'macos'
  | 'unknown';

export interface Distro {
  id: DistroId;
  prettyName: string;
}

/**
 * Best-effort detection of the host distro (Linux + macOS).
 * Reads /etc/os-release on Linux; falls back to 'unknown'.
 */
export function detectDistro(): Distro {
  if (process.platform === 'darwin') {
    return { id: 'macos', prettyName: 'macOS' };
  }
  try {
    const text = readFileSync('/etc/os-release', 'utf8');
    const get = (k: string) =>
      text
        .match(new RegExp(`^${k}=(.+)$`, 'm'))?.[1]
        ?.replace(/^"(.*)"$/, '$1');

    const id = (get('ID') ?? '').toLowerCase();
    const idLike = (get('ID_LIKE') ?? '').toLowerCase().split(/\s+/);
    const pretty = get('PRETTY_NAME') ?? get('NAME') ?? id;

    const matches = (...wanted: string[]) =>
      wanted.some((w) => id === w || idLike.includes(w));

    if (matches('arch')) return { id: 'arch', prettyName: pretty };
    if (id === 'ubuntu') return { id: 'ubuntu', prettyName: pretty };
    if (matches('debian', 'ubuntu')) return { id: 'debian', prettyName: pretty };
    if (matches('fedora')) return { id: 'fedora', prettyName: pretty };
    if (matches('rhel', 'centos')) return { id: 'rhel', prettyName: pretty };
    if (matches('opensuse', 'opensuse-leap', 'opensuse-tumbleweed', 'suse')) {
      return { id: 'opensuse', prettyName: pretty };
    }
    if (matches('alpine')) return { id: 'alpine', prettyName: pretty };
  } catch {
    // /etc/os-release missing — fall through
  }
  return { id: 'unknown', prettyName: process.platform };
}

export interface LlamaInstallHint {
  /** Short label of the detected platform, e.g. "Debian", "Arch Linux". */
  detected: string;
  /** Lines of shell that install llama.cpp via the distro's package manager. */
  packageLines: string[];
  /** Lines of shell that install build deps for a source build. */
  sourceDepsLine?: string;
  /** Backend flag for cmake (-DGGML_VULKAN=ON, -DGGML_METAL=ON, etc.). */
  cmakeBackend: string;
  /** Human-readable label of the GPU backend. */
  backendLabel: string;
}

export function llamaInstallHint(d: Distro = detectDistro()): LlamaInstallHint {
  switch (d.id) {
    case 'arch':
      return {
        detected: 'Arch Linux',
        packageLines: [
          'sudo pacman -S llama.cpp                 # CPU only / generic build',
          'yay -S llama.cpp-vulkan-git              # AUR — Vulkan (AMD/Intel iGPU)',
          'yay -S llama.cpp-hip-git                 # AUR — ROCm (AMD discrete)',
        ],
        sourceDepsLine:
          'sudo pacman -S --needed cmake base-devel vulkan-headers vulkan-icd-loader glslang curl',
        cmakeBackend: '-DGGML_VULKAN=ON',
        backendLabel: 'Vulkan',
      };
    case 'debian':
      return {
        detected: 'Debian',
        packageLines: [],
        sourceDepsLine:
          'sudo apt install -y cmake build-essential pkg-config libvulkan-dev glslc glslang-tools spirv-headers libcurl4-openssl-dev',
        cmakeBackend: '-DGGML_VULKAN=ON',
        backendLabel: 'Vulkan',
      };
    case 'ubuntu':
      return {
        detected: 'Ubuntu',
        packageLines: [],
        sourceDepsLine:
          'sudo apt install -y cmake build-essential pkg-config libvulkan-dev glslc glslang-tools spirv-headers libcurl4-openssl-dev',
        cmakeBackend: '-DGGML_VULKAN=ON',
        backendLabel: 'Vulkan',
      };
    case 'fedora':
      return {
        detected: 'Fedora',
        packageLines: [],
        sourceDepsLine:
          'sudo dnf install -y cmake gcc-c++ make pkgconf-pkg-config vulkan-headers vulkan-loader-devel glslang libcurl-devel',
        cmakeBackend: '-DGGML_VULKAN=ON',
        backendLabel: 'Vulkan',
      };
    case 'rhel':
      return {
        detected: 'RHEL / Rocky / AlmaLinux',
        packageLines: [],
        sourceDepsLine:
          'sudo dnf install -y cmake gcc-c++ make pkgconf-pkg-config vulkan-headers vulkan-loader-devel glslang libcurl-devel',
        cmakeBackend: '-DGGML_VULKAN=ON',
        backendLabel: 'Vulkan',
      };
    case 'opensuse':
      return {
        detected: 'openSUSE',
        packageLines: [],
        sourceDepsLine:
          'sudo zypper install -y cmake gcc-c++ make pkg-config vulkan-headers vulkan-loader-devel glslang libcurl-devel',
        cmakeBackend: '-DGGML_VULKAN=ON',
        backendLabel: 'Vulkan',
      };
    case 'alpine':
      return {
        detected: 'Alpine',
        packageLines: [],
        sourceDepsLine:
          'sudo apk add cmake build-base pkgconfig vulkan-headers vulkan-loader-dev glslang curl-dev',
        cmakeBackend: '-DGGML_VULKAN=ON',
        backendLabel: 'Vulkan',
      };
    case 'macos':
      return {
        detected: 'macOS',
        packageLines: ['brew install llama.cpp                  # Metal-accelerated by default'],
        sourceDepsLine: 'brew install cmake',
        cmakeBackend: '-DGGML_METAL=ON',
        backendLabel: 'Metal',
      };
    case 'unknown':
    default:
      return {
        detected: d.prettyName,
        packageLines: [],
        sourceDepsLine: undefined,
        cmakeBackend: '-DGGML_VULKAN=ON',
        backendLabel: 'Vulkan',
      };
  }
}

/**
 * Best-effort guess at which shell rc file the user wants to append to.
 * Reads $SHELL; falls back to bashrc.
 */
function shellRcGuess(): string {
  const sh = process.env.SHELL ?? '';
  if (sh.endsWith('/zsh')) return 'zshrc';
  if (sh.endsWith('/fish')) return 'config/fish/config.fish';
  return 'bashrc';
}

/**
 * Format a shell line: command in default weight, trailing `# comment` dimmed.
 */
function fmtCmd(line: string): string {
  const m = line.match(/^(.*?)(\s+#\s.*)$/);
  if (!m) return pc.cyan(line);
  return `${pc.cyan(m[1])}${pc.dim(m[2])}`;
}

/**
 * Render a multi-line, copy-pasteable install hint for the current distro.
 * Used by `requireLlama` and the setup wizard.
 */
export function renderLlamaInstallHint(): string {
  const hint = llamaInstallHint();
  const out: string[] = [];

  out.push(pc.bold(`Install llama.cpp on ${pc.magenta(hint.detected)}:`));
  out.push('');

  if (hint.packageLines.length > 0) {
    out.push(`  ${pc.bold('Distro package')} ${pc.dim('(easiest):')}`);
    for (const line of hint.packageLines) {
      out.push(`    ${fmtCmd(line)}`);
    }
    out.push('');
  }

  if (hint.sourceDepsLine) {
    out.push(
      `  ${pc.bold('Build from source')} ${pc.dim(`(${hint.backendLabel}):`)}`,
    );
    out.push(`    ${fmtCmd(hint.sourceDepsLine)}`);
    out.push(
      `    ${pc.cyan('git clone')} ${pc.underline('https://github.com/ggml-org/llama.cpp')} ~/llama.cpp`,
    );
    out.push(
      `    ${pc.cyan(`cmake -B ~/llama.cpp/build -S ~/llama.cpp ${hint.cmakeBackend}`)}`,
    );
    out.push(`    ${pc.cyan('cmake --build ~/llama.cpp/build -j')}`);
    out.push(
      `    ${fmtCmd('export PATH="$HOME/llama.cpp/build/bin:$PATH"        # this session')}`,
    );
    out.push(
      `    ${fmtCmd(
        `echo 'export PATH="$HOME/llama.cpp/build/bin:$PATH"' >> ~/.${shellRcGuess()}   # persist`,
      )}`,
    );
    out.push('');
  } else {
    out.push(
      `  ${pc.bold('Build from source:')} ${pc.underline('https://github.com/ggml-org/llama.cpp')}`,
    );
    out.push('');
  }

  out.push(pc.bold('Already have a server somewhere else?') + ' Run:');
  out.push(`  ${pc.cyan('locca setup')}        ${pc.dim('# pick "External" and paste the URL')}`);

  return out.join('\n');
}
