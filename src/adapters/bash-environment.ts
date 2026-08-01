import path from "node:path";
import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BashExecutionGuard } from "../policy/engine.ts";
import { resolveProjectPath, type ProjectIdentity } from "../project.ts";

const UNSAFE_ENVIRONMENT_KEYS = new Set([
  "BASH_ENV",
  "ENV",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_WORK_TREE",
  "GREP_OPTIONS",
  "LESSCLOSE",
  "LESSOPEN",
  "PAGER",
  "RIPGREP_CONFIG_PATH",
]);

function environmentIssue(): string | undefined {
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (UNSAFE_ENVIRONMENT_KEYS.has(key) || key.startsWith("BASH_FUNC_") || key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) {
      return `${key} changes Bash command behavior`;
    }
  }
  return undefined;
}

function bashAbsolutePath(value: string): string | undefined {
  if (process.platform !== "win32") return path.isAbsolute(value) ? value : undefined;
  if (/^[A-Za-z]:[\\/]/.test(value)) return value;
  const msys = value.match(/^\/([A-Za-z])\/(.*)$/);
  if (msys) return `${msys[1]!.toUpperCase()}:/${msys[2]}`;
  // Git for Windows reports system commands under virtual /usr and /mingw roots.
  if (value.startsWith("/usr/") || value.startsWith("/mingw")) return "[trusted-git-bash-system-path]";
  return undefined;
}

async function pathEnvironmentIssue(project: ProjectIdentity, cwd: string): Promise<string | undefined> {
  const entries = (process.env.PATH ?? "").split(path.delimiter);
  for (const entry of entries) {
    const candidate = entry || cwd;
    const resolved = await resolveProjectPath(project.root, cwd, candidate);
    if (resolved.inside) return "PATH contains a project-local executable directory";
  }
  return undefined;
}

export async function inspectBashEnvironment(
  pi: ExtensionAPI,
  cwd: string,
  agentDir: string,
  project: ProjectIdentity,
): Promise<BashExecutionGuard> {
  const unsafeEnvironment = environmentIssue() ?? await pathEnvironmentIssue(project, cwd);
  if (unsafeEnvironment) {
    return { trusted: false, reason: unsafeEnvironment, isExecutableTrusted: async () => false };
  }

  try {
    const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    if (settings.getShellCommandPrefix()?.trim()) {
      return { trusted: false, reason: "Pi shellCommandPrefix changes Bash execution", isExecutableTrusted: async () => false };
    }
    if (settings.getShellPath()?.trim()) {
      return { trusted: false, reason: "A custom Pi shellPath is configured", isExecutableTrusted: async () => false };
    }
  } catch (error) {
    return {
      trusted: false,
      reason: `Pi shell settings could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      isExecutableTrusted: async () => false,
    };
  }

  return {
    trusted: true,
    isExecutableTrusted: async (command) => {
      if (!/^[A-Za-z0-9_.+-]+$/.test(command)) return false;
      try {
        const result = await pi.exec("bash", ["--noprofile", "--norc", "-c", `command -v -- ${command}`], {
          cwd,
          timeout: 5_000,
        });
        if (result.code !== 0) return false;
        const executable = result.stdout.trim().split(/\r?\n/, 1)[0];
        if (!executable) return false;
        const nativePath = bashAbsolutePath(executable);
        if (nativePath === "[trusted-git-bash-system-path]") return true;
        if (!nativePath) return false;
        return !(await resolveProjectPath(project.root, cwd, nativePath)).inside;
      } catch {
        return false;
      }
    },
  };
}
