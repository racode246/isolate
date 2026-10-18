import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, IsolateError } from "./util.js";

export interface EnvPortsConfig {
  enabled: boolean;
  /** globs relative to the checkout root; null = discover untracked .env* files */
  files: string[] | null;
  /** tested against the key of KEY=<port> lines */
  keyPattern: RegExp;
}

export interface ComposePortsConfig {
  enabled: boolean;
  /** compose files relative to the checkout root; null = the default stack */
  files: string[] | null;
}

export interface Config {
  label: string | null;
  envPorts: EnvPortsConfig;
  composePorts: ComposePortsConfig;
  composeProject: { enabled: boolean };
}

export const DEFAULT_KEY_PATTERN = "PORT$";

function fail(msg: string): never {
  throw new IsolateError(`${CONFIG_FILE}: ${msg}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkKeys(where: string, obj: Record<string, unknown>, allowed: string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) fail(`${where ? `${where}: ` : ""}unknown key "${k}" (allowed: ${allowed.join(", ")})`);
  }
}

function resolver(name: string, v: unknown, keys: string[]): Record<string, unknown> & { enabled: boolean } {
  if (v === undefined || v === true) return { enabled: true };
  if (v === false) return { enabled: false };
  if (!isObject(v)) fail(`${name}: expected a boolean or an object`);
  checkKeys(name, v, ["enabled", ...keys]);
  if (v.enabled !== undefined && typeof v.enabled !== "boolean") fail(`${name}.enabled: expected a boolean`);
  return { ...v, enabled: v.enabled !== false };
}

function stringList(where: string, v: unknown): string[] | null {
  if (v === undefined) return null;
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && s.length > 0)) {
    fail(`${where}: expected an array of strings`);
  }
  return v as string[];
}

export function parseConfig(raw: unknown): Config {
  if (!isObject(raw)) fail("expected a JSON object");
  checkKeys("", raw, ["$schema", "label", "envPorts", "composePorts", "composeProject"]);
  if (raw.label !== undefined && (typeof raw.label !== "string" || raw.label === "")) fail("label: expected a non-empty string");

  const env = resolver("envPorts", raw.envPorts, ["files", "keyPattern"]);
  let keyPattern: RegExp;
  const pat = env.keyPattern ?? DEFAULT_KEY_PATTERN;
  if (typeof pat !== "string") fail("envPorts.keyPattern: expected a string");
  try {
    keyPattern = new RegExp(pat);
  } catch {
    fail(`envPorts.keyPattern: invalid regular expression ${JSON.stringify(pat)}`);
  }
  const compose = resolver("composePorts", raw.composePorts, ["files"]);
  const project = resolver("composeProject", raw.composeProject, []);

  return {
    label: (raw.label as string | undefined) ?? null,
    envPorts: { enabled: env.enabled, files: stringList("envPorts.files", env.files), keyPattern },
    composePorts: { enabled: compose.enabled, files: stringList("composePorts.files", compose.files) },
    composeProject: { enabled: project.enabled },
  };
}

export function loadConfig(root: string): Config {
  const p = join(root, CONFIG_FILE);
  if (!existsSync(p)) return parseConfig({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    fail(`invalid JSON (${(e as Error).message})`);
  }
  return parseConfig(raw);
}
