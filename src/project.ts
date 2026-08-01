import { access, realpath } from "node:fs/promises";
import path from "node:path";

export type GitRootResolver = (cwd: string) => Promise<string | undefined>;

export type ProjectIdentity = {
  root: string;
  key: string;
};

export type ResolvedProjectPath = {
  absolute: string;
  canonical: string;
  inside: boolean;
  relative: string | undefined;
};

function comparisonPath(value: string): string {
  return path.normalize(value);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}

/** Resolve symlinks in the existing prefix while retaining missing path segments. */
export async function canonicalizeProspectivePath(value: string): Promise<string> {
  const absolute = path.resolve(value);
  const missing: string[] = [];
  let cursor = absolute;

  while (!(await pathExists(cursor))) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return absolute;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }

  const canonicalParent = await realpath(cursor);
  return path.join(canonicalParent, ...missing);
}

export function projectKey(root: string): string {
  return comparisonPath(root);
}

export async function resolveProjectIdentity(cwd: string, findGitRoot?: GitRootResolver): Promise<ProjectIdentity> {
  const absoluteCwd = path.resolve(cwd);
  let candidate = absoluteCwd;

  if (findGitRoot) {
    try {
      const gitRoot = await findGitRoot(absoluteCwd);
      if (gitRoot?.trim()) candidate = path.resolve(absoluteCwd, gitRoot.trim());
    } catch {
      // Non-Git directories use cwd as their project boundary.
    }
  }

  const root = await canonicalizeProspectivePath(candidate);
  return { root, key: projectKey(root) };
}

export async function resolveProjectPath(
  projectRoot: string,
  cwd: string,
  value: string | undefined,
): Promise<ResolvedProjectPath> {
  const absolute = path.resolve(cwd, value || ".");
  const canonical = await canonicalizeProspectivePath(absolute);
  const normalizedRoot = path.normalize(projectRoot);
  const normalizedCanonical = path.normalize(canonical);
  const relativeNative = path.relative(normalizedRoot, normalizedCanonical);
  const rootPrefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  // Both values were canonicalized through realpath, so an exact prefix check
  // preserves case-sensitive Windows directory semantics while also rejecting
  // cross-volume and UNC escapes.
  const inside = normalizedCanonical === normalizedRoot || normalizedCanonical.startsWith(rootPrefix);

  return {
    absolute,
    canonical,
    inside,
    relative: inside ? toPosix(relativeNative || ".") : undefined,
  };
}
