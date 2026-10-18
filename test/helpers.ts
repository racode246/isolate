import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach } from "vitest";
import { main } from "../src/main.js";

const cleanups: string[] = [];
afterEach(() => {
  while (cleanups.length) rmSync(cleanups.pop()!, { recursive: true, force: true });
});

export function tempDir(prefix = "isolate-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export interface RepoSpec {
  /** committed files */
  tracked?: Record<string, string>;
  /** files created after the commit (untracked or ignored) */
  untracked?: Record<string, string>;
  /** repo directory name (default: "app") */
  name?: string;
  /** branch to check out after the initial commit */
  branch?: string;
}

export function makeRepo(spec: RepoSpec = {}): string {
  const root = join(tempDir(), spec.name ?? "app");
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  for (const [p, c] of Object.entries(spec.tracked ?? {})) writeFile(root, p, c);
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  if (spec.branch) git(root, "checkout", "-q", "-b", spec.branch);
  for (const [p, c] of Object.entries(spec.untracked ?? {})) writeFile(root, p, c);
  return root;
}

export function writeFile(root: string, rel: string, content: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

/** every file under root except .git, with contents — for byte-identical comparisons */
export function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === ".git") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

/** a fake `docker` that reports the given compose version and logs its argv */
export function fakeDocker(version: string): { bin: string; log: string } {
  const d = tempDir("isolate-docker-");
  const bin = join(d, "docker");
  const log = join(d, "calls.log");
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1 $2" = "compose version" ]; then echo "${version}"; fi\nexit 0\n`,
  );
  chmodSync(bin, 0o755);
  writeFileSync(log, "");
  return { bin, log };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(cwd: string, args: string[], env: Record<string, string | undefined> = {}): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    cwd,
    env: { ...process.env, ISOLATE_DOCKER_BIN: "/nonexistent/docker", ...env },
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
  });
  return { code, stdout, stderr };
}

export function envValue(content: string, key: string): string | undefined {
  const line = content.split("\n").find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1);
}
