import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Logger } from "./util.js";

export type HostPort =
  | { type: "none" } // container-only entry: no host binding
  | { type: "fixed"; port: number }
  | { type: "var"; name: string; default: string };

export interface PortItem {
  service: string;
  file: string;
  /** the entry as written: short-syntax string or long-syntax mapping */
  raw: string | Record<string, unknown>;
  host: HostPort;
}

const PRIMARY = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
const OVERRIDES = [
  "docker-compose.override.yml",
  "docker-compose.override.yaml",
  "compose.override.yml",
  "compose.override.yaml",
];

/** files docker compose loads by default: the primary file and its conventional override */
export function defaultStack(root: string): string[] {
  const pick = (names: string[]) => names.find((f) => existsSync(join(root, f)));
  return [pick(PRIMARY), pick(OVERRIDES)].filter((f): f is string => !!f);
}

/** split on ":" outside ${...} and [...] */
function splitColons(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if ((c === "$" && s[i + 1] === "{") || c === "[") depth++;
    if ((c === "}" || c === "]") && depth > 0) depth--;
    if (c === ":" && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts;
}

interface Short {
  ip: string | null;
  host: string | null;
  container: string;
  proto: string;
}

function parseShort(item: string): Short | null {
  const m = item.match(/^(.*?)(\/[a-z]+)?$/)!;
  const parts = splitColons(m[1]!);
  const proto = m[2] ?? "";
  if (parts.length === 1) return { ip: null, host: null, container: parts[0]!, proto };
  if (parts.length === 2) return { ip: null, host: parts[0]!, container: parts[1]!, proto };
  if (parts.length === 3) return { ip: parts[0]!, host: parts[1]!, container: parts[2]!, proto };
  return null;
}

function hostOf(host: string | null): HostPort | null {
  if (host === null || host === "") return { type: "none" };
  if (/^[0-9]+$/.test(host)) return { type: "fixed", port: Number(host) };
  const v = host.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}$/);
  if (v) return { type: "var", name: v[1]!, default: v[2] ?? "" };
  return null; // port ranges and other forms are left alone
}

function itemsOfFile(root: string, file: string, log: Logger): PortItem[] {
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(join(root, file), "utf8"));
  } catch (e) {
    log.warn(`${file}: cannot parse YAML (${(e as Error).message.split("\n")[0]}); skipping it`);
    return [];
  }
  const services = (doc as { services?: unknown } | null)?.services;
  if (!services || typeof services !== "object") return [];
  const out: PortItem[] = [];
  for (const [service, def] of Object.entries(services as Record<string, unknown>)) {
    const ports = (def as { ports?: unknown } | null)?.ports;
    if (!Array.isArray(ports)) continue;
    for (const entry of ports) {
      if (typeof entry === "string" || typeof entry === "number") {
        const raw = String(entry);
        const short = parseShort(raw);
        const host = short && hostOf(short.host);
        if (!host) {
          log.warn(`service ${service}: cannot read the host port of "${raw}"; leaving it`);
          out.push({ service, file, raw, host: { type: "none" } });
        } else out.push({ service, file, raw, host });
      } else if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        const pub = obj.published;
        const host = pub === undefined || pub === null ? { type: "none" as const } : hostOf(String(pub));
        if (!host) {
          log.warn(`service ${service}: cannot read the host port of published: ${String(pub)}; leaving it`);
          out.push({ service, file, raw: obj, host: { type: "none" } });
        } else out.push({ service, file, raw: obj, host });
      }
    }
  }
  return out;
}

export function composeItems(root: string, files: string[], log: Logger): PortItem[] {
  return files.flatMap((f) => itemsOfFile(root, f, log));
}

/** the entry with its host port replaced by `host` (a number or a ${VAR:-n} reference) */
export function withHost(item: PortItem, host: string): string | Record<string, unknown> {
  if (typeof item.raw !== "string") return { ...item.raw, published: host };
  const s = parseShort(item.raw)!;
  return `${s.ip !== null ? `${s.ip}:` : ""}${host}:${s.container}${s.proto}`;
}

/** variable name for a var-form hint: <SERVICE>_PORT, then <SERVICE>_PORT_2, ... */
export function varSuggestion(service: string, nth: number): string {
  const base = `${service.toUpperCase().replace(/[.-]/g, "_")}_PORT`;
  return nth > 1 ? `${base}_${nth}` : base;
}

export interface Hint {
  service: string;
  item: string;
  suggestion: string;
}

export function hints(items: PortItem[]): Hint[] {
  const nth = new Map<string, number>();
  const out: Hint[] = [];
  for (const it of items) {
    if (it.host.type !== "fixed") continue;
    const n = (nth.get(it.service) ?? 0) + 1;
    nth.set(it.service, n);
    const ref = `\${${varSuggestion(it.service, n)}:-${it.host.port}}`;
    const s = withHost(it, ref);
    out.push({
      service: it.service,
      item: typeof it.raw === "string" ? it.raw : JSON.stringify(it.raw),
      suggestion: typeof s === "string" ? s : `published: "${ref}"`,
    });
  }
  return out;
}

/**
 * The generated override: every service with a hard-coded host port gets its
 * whole ports list replaced (`!override`, docker compose >= 2.24), remapped.
 */
export function renderOverride(items: PortItem[], mapping: Map<number, number>, prog: string): string | null {
  const services = [...new Set(items.filter((i) => i.host.type === "fixed").map((i) => i.service))];
  if (services.length === 0) return null;
  const lines = [
    `# Generated by ${prog} — do not commit.`,
    "# Replaces host-side ports of the base compose stack (requires compose >= 2.24).",
    "services:",
  ];
  for (const svc of services) {
    lines.push(`  ${svc}:`, "    ports: !override");
    for (const it of items.filter((i) => i.service === svc)) {
      let v: string | Record<string, unknown> = it.raw;
      if (it.host.type === "fixed" && mapping.has(it.host.port)) v = withHost(it, String(mapping.get(it.host.port)));
      lines.push(`      - ${JSON.stringify(v)}`);
    }
  }
  return lines.join("\n") + "\n";
}
