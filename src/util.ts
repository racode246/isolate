import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export const PROG = "isolate";
export const PORTS_FILE = ".isolate-ports.env";
export const MANIFEST_FILE = ".isolate-manifest";
export const OVERRIDE_FILE = ".isolate-compose.override.yml";
export const CONFIG_FILE = "isolate.config.json";

/** An expected failure: printed as "error: <message>", exits with `code`. */
export class IsolateError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

export interface Logger {
  info(s: string): void;
  warn(s: string): void;
}

// ------------------------------------------------------------------- git ---

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export interface Repo {
  /** top level of the current checkout */
  root: string;
  /** the main worktree; its directory name names the compose project */
  main: string;
  repoName: string;
}

export function findRepo(cwd: string): Repo {
  const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!root) throw new IsolateError("not inside a git repository");
  const main = worktrees(root)[0]?.path ?? root;
  return { root, main, repoName: basename(main) };
}

export function currentBranch(root: string): string | null {
  const b = git(root, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim();
  return b && b !== "HEAD" ? b : null;
}

/** untracked (ignored or not) paths; fully untracked directories collapse to "dir/" */
export function untrackedPaths(root: string): string[] {
  const out = git(root, ["ls-files", "--others", "--directory", "-z"]) ?? "";
  return out.split("\0").filter(Boolean);
}

export function isTracked(root: string, rel: string): boolean {
  return git(root, ["ls-files", "--error-unmatch", "--", rel]) !== null;
}

export interface Worktree {
  path: string;
  branch: string;
}

export function worktrees(root: string): Worktree[] {
  const out = git(root, ["worktree", "list", "--porcelain"]) ?? "";
  const list: Worktree[] = [];
  let cur: Worktree | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice("worktree ".length), branch: "?" };
      list.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (cur && line === "detached") {
      cur.branch = "(detached)";
    }
  }
  return list;
}

// ----------------------------------------------------------------- paths ---

/** lowercase, non-alnum -> "-", squeezed and trimmed (valid compose project name) */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

const JUNK_DIRS = new Set([
  "node_modules", "dist", "build", "out", ".next", ".nuxt", "target", "__pycache__", ".venv", "venv",
  "vendor", "coverage", ".cache", ".tox", ".turbo", ".gradle", ".terraform", "tmp",
]);

export function isJunkPath(rel: string): boolean {
  return rel.split("/").some((seg) => JUNK_DIRS.has(seg));
}

function segmentRegex(seg: string): RegExp {
  const body = seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${body}$`);
}

/**
 * Expand gitignore-free globs (`*`, `?`, `**`) relative to root into existing
 * files, sorted. `**` does not descend into .git or junk directories.
 */
export function expandGlobs(root: string, patterns: string[]): string[] {
  const found = new Set<string>();
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const walk = (rel: string, segs: string[]) => {
    const abs = join(root, rel);
    if (segs.length === 0) {
      if (rel && existsSync(abs) && !isDir(abs)) found.add(rel);
      return;
    }
    const [seg, ...rest] = segs as [string, ...string[]];
    if (seg === "**") {
      walk(rel, rest);
      if (!isDir(abs)) return;
      for (const e of readdirSync(abs)) {
        if (e === ".git" || JUNK_DIRS.has(e)) continue;
        const sub = rel ? `${rel}/${e}` : e;
        if (isDir(join(root, sub))) walk(sub, segs);
      }
      return;
    }
    if (!/[*?]/.test(seg)) {
      walk(rel ? `${rel}/${seg}` : seg, rest);
      return;
    }
    if (!isDir(abs)) return;
    const re = segmentRegex(seg);
    for (const e of readdirSync(abs)) if (re.test(e)) walk(rel ? `${rel}/${e}` : e, rest);
  };
  for (const p of patterns) walk("", p.replace(/^\.\//, "").split("/").filter(Boolean));
  return [...found].sort();
}
