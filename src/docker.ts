import { execFileSync } from "node:child_process";

export function dockerBin(env: Record<string, string | undefined>): string {
  return env.ISOLATE_DOCKER_BIN || "docker";
}

export type ComposeVersion = { ok: true; version: string } | { ok: false; version: string } | { ok: null };

/** docker compose >= 2.24 (needed for the !override tag)? ok: null = undetectable */
export function composeVersion(env: Record<string, string | undefined>): ComposeVersion {
  let out: string;
  try {
    out = execFileSync(dockerBin(env), ["compose", "version", "--short"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return { ok: null };
  }
  const m = out.replace(/^v/, "").match(/^(\d+)\.(\d+)/);
  if (!m) return { ok: null };
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return { ok: major > 2 || (major === 2 && minor >= 24), version: out };
}

/** docker compose -p <project> down -v; returns its combined output */
export function composeDown(env: Record<string, string | undefined>, cwd: string, project: string): string {
  return execFileSync(dockerBin(env), ["compose", "-p", project, "down", "-v"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
