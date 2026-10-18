import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { portOffset } from "./cksum.js";
import { type PortItem, composeItems, defaultStack, hints, renderOverride } from "./compose.js";
import type { Config } from "./config.js";
import { composeDown, composeVersion } from "./docker.js";
import { getValue, removeAdded, replacePort, restoreValue, scanPorts, setValue } from "./envfile.js";
import { type Change, type Manifest, manifestPath, readManifest, writeManifest } from "./manifest.js";
import { assignPorts } from "./ports.js";
import {
  IsolateError,
  type Logger,
  MANIFEST_FILE,
  OVERRIDE_FILE,
  PORTS_FILE,
  PROG,
  type Repo,
  currentBranch,
  expandGlobs,
  isJunkPath,
  isTracked,
  slugify,
  untrackedPaths,
  worktrees,
} from "./util.js";

export interface Context {
  repo: Repo;
  config: Config;
  env: Record<string, string | undefined>;
  log: Logger;
}

const readText = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");

// --------------------------------------------------------------- analysis ---

interface Analysis {
  label: string;
  project: string | null;
  offset: number;
  envFiles: string[];
  envEntries: { file: string; key: string; port: number }[];
  stackFiles: string[];
  items: PortItem[];
  vars: { service: string; name: string; port: number }[];
  sources: number[];
  needsOverride: boolean;
}

function resolveLabel(ctx: Context, name: string | undefined): string {
  const label = name ?? ctx.config.label ?? currentBranch(ctx.repo.root) ?? basename(ctx.repo.root);
  if (!slugify(label)) throw new IsolateError(`label '${label}' produces an empty slug`);
  return label;
}

function envFiles(ctx: Context): string[] {
  const { root } = ctx.repo;
  const cfg = ctx.config.envPorts;
  if (!cfg.enabled) return [];
  if (cfg.files === null) {
    return untrackedPaths(root).filter((rel) => {
      if (rel.endsWith("/")) return false;
      const base = rel.split("/").pop()!;
      return (base === ".env" || base.startsWith(".env.")) && !isJunkPath(rel);
    });
  }
  return expandGlobs(root, cfg.files).filter((rel) => {
    if (!isTracked(root, rel)) return true;
    ctx.log.warn(`${rel} is tracked by git; isolate never edits tracked files, skipping it`);
    return false;
  });
}

function stackFiles(ctx: Context): string[] {
  const { root } = ctx.repo;
  const files = ctx.config.composePorts.files;
  if (files === null) return defaultStack(root);
  const out: string[] = [];
  for (const p of files) {
    const hits = expandGlobs(root, [p]);
    if (hits.length === 0) ctx.log.warn(`composePorts.files: ${p} matches no file`);
    for (const h of hits) if (!out.includes(h)) out.push(h);
  }
  return out;
}

function analyze(ctx: Context, name: string | undefined): Analysis {
  const { root, repoName } = ctx.repo;
  const label = resolveLabel(ctx, name);
  const project = ctx.config.composeProject.enabled ? `${slugify(repoName)}-${slugify(label)}` : null;

  const files = envFiles(ctx);
  const envEntries = files.flatMap((file) =>
    scanPorts(readText(root, file), ctx.config.envPorts.keyPattern).map((e) => ({ file, ...e })),
  );

  const stack = stackFiles(ctx);
  const items = ctx.config.composePorts.enabled ? composeItems(root, stack, ctx.log) : [];
  const dotenv = existsSync(join(root, ".env")) ? readText(root, ".env") : "";
  const vars: Analysis["vars"] = [];
  for (const it of items) {
    if (it.host.type !== "var") continue;
    const value = getValue(dotenv, it.host.name) || it.host.default;
    if (!/^[0-9]+$/.test(value)) {
      ctx.log.warn(
        `service ${it.service}: cannot tell the host port of \${${it.host.name}} (no numeric default or .env value); leaving it`,
      );
      continue;
    }
    vars.push({ service: it.service, name: it.host.name, port: Number(value) });
  }

  const all = [
    ...envEntries.map((e) => e.port),
    ...vars.map((v) => v.port),
    ...items.flatMap((i) => (i.host.type === "fixed" ? [i.host.port] : [])),
  ];
  const sources = [...new Set(all)].filter((p) => p >= 20).sort((a, b) => a - b);

  return {
    label,
    project,
    offset: portOffset(label),
    envFiles: files,
    envEntries,
    stackFiles: stack,
    items,
    vars,
    sources,
    needsOverride: items.some((i) => i.host.type === "fixed"),
  };
}

// ------------------------------------------------------------- ports file ---

interface Mapping {
  label: string | null;
  project: string | null;
  composeFile: string | null;
  ports: { from: number; to: number }[];
}

function readPortsFile(dir: string): Mapping | null {
  const p = join(dir, PORTS_FILE);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8");
  const ports: Mapping["ports"] = [];
  for (const m of text.matchAll(/^PORT_([0-9]+)=([0-9]+)$/gm)) ports.push({ from: Number(m[1]), to: Number(m[2]) });
  return {
    label: getValue(text, "ISOLATE_NAME") ?? null,
    project: getValue(text, "COMPOSE_PROJECT_NAME") ?? null,
    composeFile: getValue(text, "COMPOSE_FILE") ?? null,
    ports,
  };
}

function printMapping(log: Logger, m: Mapping | null): void {
  if (!m) return log.info("      (not isolated)");
  if (m.label) log.info(`      label          : ${m.label}`);
  if (m.project) log.info(`      compose project: ${m.project}`);
  if (m.composeFile) log.info(`      compose files  : ${m.composeFile}`);
  for (const p of m.ports) log.info(`      port ${p.from} -> ${p.to}`);
}

// ------------------------------------------------------------------ apply ---

export async function apply(ctx: Context, opts: { name?: string }): Promise<object> {
  const { root } = ctx.repo;
  const { log } = ctx;
  if (existsSync(manifestPath(root))) {
    throw new IsolateError(`isolate is already applied here (${MANIFEST_FILE} exists); run '${PROG} reset' first`);
  }
  const a = analyze(ctx, opts.name);

  log.info("==> checkout");
  log.info(`    root    : ${root}`);
  log.info(`    label   : ${a.label}`);
  log.info(`    project : ${a.project ?? "(composeProject disabled)"}`);

  // fail fast, before anything is changed
  if (a.needsOverride) {
    const v = composeVersion(ctx.env);
    if (v.ok === false) {
      throw new IsolateError(
        `docker compose >= 2.24 is required (found ${v.version}) — the generated override uses the !override tag`,
      );
    }
    if (v.ok === null) log.warn(`docker compose not found / version undetectable — ${OVERRIDE_FILE} requires compose >= 2.24 at runtime`);
  }

  log.info("==> remapping ports (tracked files stay clean)");
  log.info(`    label '${a.label}' -> port offset=+${a.offset}`);
  const mapping = await assignPorts(a.sources, a.offset);
  for (const from of a.sources) {
    const to = mapping.get(from);
    if (to === undefined) log.warn(`could not find a free port for ${from}; leaving it unchanged`);
    else log.info(`    port   : ${from} -> ${to}`);
  }
  if (a.sources.length === 0) log.info("    (no ports found to remap)");

  // from here on the checkout changes: every change goes into the manifest first
  const manifest: Manifest = { generatedBy: PROG, version: 1, label: a.label, project: a.project, changes: [] };
  const touched: string[] = [];
  const record = (c: Change) => {
    manifest.changes.push(c);
    writeManifest(root, manifest);
    if (!touched.includes(c.file)) touched.push(c.file);
  };
  writeManifest(root, manifest);

  for (const file of a.envFiles) {
    let content = readText(root, file);
    const before = content;
    for (const e of a.envEntries.filter((x) => x.file === file)) {
      const to = mapping.get(e.port);
      if (to === undefined) continue;
      content = replacePort(content, e.key, String(e.port), String(to));
      record({ type: "env-port", file, key: e.key, from: e.port, to });
    }
    if (content !== before) {
      writeFileSync(join(root, file), content);
      log.info(`    rewrote: ${file}`);
    }
  }

  // docker compose: override for hard-coded host ports, .env for the rest
  log.info(a.items.length || a.stackFiles.length ? "==> docker compose isolation" : "==> docker compose isolation: no compose stack");
  let composeFile: string | null = null;
  const override = renderOverride(a.items, mapping, PROG);
  if (override) {
    writeFileSync(join(root, OVERRIDE_FILE), override);
    record({ type: "generated", file: OVERRIDE_FILE });
    log.info(`    wrote  : ${OVERRIDE_FILE} (hard-coded host ports; tracked compose files untouched)`);
    composeFile = [...a.stackFiles, OVERRIDE_FILE].join(":");
  }
  const varSets = new Map<string, number>();
  for (const v of a.vars) {
    const to = mapping.get(v.port);
    if (to !== undefined) varSets.set(v.name, to);
  }

  const dotenvExists = existsSync(join(root, ".env"));
  const wantProject = a.project !== null && (dotenvExists || a.stackFiles.length > 0);
  let envFile: string | null = null;
  if (dotenvExists && isTracked(root, ".env")) {
    if (composeFile || varSets.size || wantProject) {
      log.warn(`.env is tracked by git — not modifying it. Use: docker compose --env-file ${PORTS_FILE} ...`);
      envFile = PORTS_FILE;
    }
  } else if (composeFile || varSets.size || wantProject) {
    if (!dotenvExists) {
      writeFileSync(join(root, ".env"), `# Generated by ${PROG} — do not commit.\n`);
      record({ type: "created", file: ".env" });
      log.info("    created: .env (for COMPOSE_* wiring)");
    }
    const set = (key: string, value: string) => {
      const r = setValue(readText(root, ".env"), key, value);
      if (r.kind === "unchanged") return;
      writeFileSync(join(root, ".env"), r.content);
      if (r.kind === "added") record({ type: "key-added", file: ".env", key, addedNewline: r.addedNewline });
      else record({ type: "key-replaced", file: ".env", key, previous: r.previous });
      log.info(`    .env   : ${key}=${value}`);
    };
    if (composeFile) set("COMPOSE_FILE", composeFile);
    for (const [k, v] of varSets) set(k, String(v));
    if (a.project) set("COMPOSE_PROJECT_NAME", a.project);
    envFile = ".env";
  }

  const ports = a.sources.flatMap((from) => (mapping.has(from) ? [{ from, to: mapping.get(from)! }] : []));
  const lines = [
    `# Generated by ${PROG} — do not commit.`,
    "# Port remapping for this checkout (old -> new):",
    ...ports.map((p) => `#   ${p.from} -> ${p.to}`),
    `ISOLATE_NAME=${a.label}`,
    ...(a.project ? [`COMPOSE_PROJECT_NAME=${a.project}`] : []),
    ...(composeFile ? [`COMPOSE_FILE=${composeFile}`] : []),
    ...ports.map((p) => `PORT_${p.from}=${p.to}`),
    ...[...varSets].map(([k, v]) => `${k}=${v}`),
  ];
  writeFileSync(join(root, PORTS_FILE), lines.join("\n") + "\n");
  record({ type: "generated", file: PORTS_FILE });

  log.info("");
  log.info("==> isolated");
  if (a.project) log.info(`    compose project : ${a.project}`);
  for (const p of ports) log.info(`    port mapping    : ${p.from} -> ${p.to}`);
  log.info(`    mapping file    : ${join(root, PORTS_FILE)}`);
  if (envFile === PORTS_FILE) log.info(`    compose usage   : docker compose --env-file ${PORTS_FILE} ...`);

  return { root, label: a.label, project: a.project, ports, files: touched, composeFile, envFile, portsFile: PORTS_FILE };
}

// ------------------------------------------------------------------ reset ---

export function reset(ctx: Context, opts: { withDocker: boolean }): void {
  const { root } = ctx.repo;
  const { log } = ctx;
  const manifest = readManifest(root);
  if (manifest === null) throw new IsolateError(`isolate is not applied here (no ${MANIFEST_FILE} in ${root})`);
  const mapping = readPortsFile(root);

  if (opts.withDocker) {
    const project = mapping?.project;
    if (!project) log.warn("no compose project recorded; skipping --with-docker");
    else {
      log.info(`==> docker compose -p ${project} down -v`);
      try {
        for (const l of composeDown(ctx.env, root, project).split("\n")) if (l) log.info(`    ${l}`);
      } catch {
        log.warn("docker compose down failed (continuing)");
      }
    }
  }

  log.info("==> undoing");
  if (manifest === "legacy") resetLegacy(ctx, mapping);
  else {
    const edit = (file: string, fn: (s: string) => string) => {
      const p = join(root, file);
      if (!existsSync(p)) return log.warn(`${file} missing; cannot restore it`);
      writeFileSync(p, fn(readFileSync(p, "utf8")));
    };
    for (const c of [...manifest.changes].reverse()) {
      switch (c.type) {
        case "env-port":
          edit(c.file, (s) => replacePort(s, c.key, String(c.to), String(c.from)));
          log.info(`    restored port  : ${c.file} ${c.key}=${c.from}`);
          break;
        case "key-added":
          edit(c.file, (s) => removeAdded(s, c.key, c.addedNewline));
          log.info(`    removed key    : ${c.file} ${c.key}`);
          break;
        case "key-replaced":
          edit(c.file, (s) => restoreValue(s, c.key, c.previous));
          log.info(`    restored key   : ${c.file} ${c.key}`);
          break;
        case "created":
        case "generated":
          rmSync(join(root, c.file), { force: true });
          log.info(`    deleted        : ${c.file}`);
          break;
      }
    }
  }
  rmSync(manifestPath(root), { force: true });
  log.info("==> reset complete");
}

/** undo a manifest written by the original isolate.sh (line-based format) */
function resetLegacy(ctx: Context, mapping: Mapping | null): void {
  const { root } = ctx.repo;
  const lines = readFileSync(manifestPath(root), "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#"));
  const edit = (file: string, fn: (s: string) => string) => {
    const p = join(root, file);
    if (existsSync(p)) writeFileSync(p, fn(readFileSync(p, "utf8")));
  };
  for (const line of lines) {
    const [kind, ...restParts] = line.split(" ");
    const rest = restParts.join(" ");
    if (kind === "rewritten") {
      edit(rest, (s) => {
        for (const p of mapping?.ports ?? []) {
          s = s.replace(new RegExp(`^([A-Za-z0-9_]*PORT)=${p.to}$`, "gm"), `$1=${p.from}`);
        }
        return s;
      });
    } else if (kind === "key-added") {
      const [file, key] = restParts as [string, string];
      edit(file, (s) => s.replace(new RegExp(`^${key}=.*\\n?`, "gm"), ""));
    } else if (kind === "key-replaced") {
      const [file, ...kv] = restParts as [string, ...string[]];
      const pair = kv.join(" ");
      const key = pair.slice(0, pair.indexOf("="));
      const old = pair.slice(pair.indexOf("=") + 1);
      edit(file, (s) => restoreValue(s, key, old));
    }
    ctx.log.info(`    undone         : ${line}`);
  }
  for (const line of lines) {
    const [kind, ...restParts] = line.split(" ");
    if (kind === "created" || kind === "generated") rmSync(join(root, restParts.join(" ")), { force: true });
  }
}

// ---------------------------------------------------------- status / list ---

export function status(ctx: Context): object {
  const { root } = ctx.repo;
  ctx.log.info(`  ${root}`);
  const m = existsSync(manifestPath(root)) ? readPortsFile(root) : null;
  printMapping(ctx.log, m);
  return {
    root,
    applied: m !== null,
    label: m?.label ?? null,
    project: m?.project ?? null,
    composeFile: m?.composeFile ?? null,
    ports: m?.ports ?? [],
  };
}

export function list(ctx: Context): object {
  const out = worktrees(ctx.repo.root).map((w) => {
    ctx.log.info(`  ${w.path}  [${w.branch}]`);
    const m = existsSync(join(w.path, MANIFEST_FILE)) ? readPortsFile(w.path) : null;
    printMapping(ctx.log, m);
    return { path: w.path, branch: w.branch, applied: m !== null, ...(m ?? {}) };
  });
  return { worktrees: out };
}

// ----------------------------------------------------------------- doctor ---

export function doctor(ctx: Context, opts: { name?: string }): object {
  const { root } = ctx.repo;
  const { log } = ctx;
  const a = analyze(ctx, opts.name);
  const applied = existsSync(manifestPath(root));

  log.info("==> checkout");
  log.info(`    root    : ${root}`);
  log.info(`    label   : ${a.label}`);
  log.info(`    project : ${a.project ?? "(composeProject disabled)"}`);
  log.info(`    state   : ${applied ? "ALREADY APPLIED (run reset before apply again)" : "not applied"}`);

  log.info("");
  log.info("==> env files (untracked; tracked ones are never touched)");
  if (!ctx.config.envPorts.enabled) log.info("    (envPorts disabled in isolate.config.json)");
  else if (a.envFiles.length === 0) log.info("    (none)");
  for (const f of a.envFiles) log.info(`    ${f}`);
  if (existsSync(join(root, ".env")) && isTracked(root, ".env")) {
    log.info(`    note: .env is tracked — COMPOSE_* wiring will go to ${PORTS_FILE} only (use --env-file)`);
  }

  log.info("");
  log.info("==> docker compose");
  const hs = hints(a.items);
  if (!ctx.config.composePorts.enabled) log.info("    (composePorts disabled in isolate.config.json)");
  else if (a.stackFiles.length === 0) log.info("    (no compose stack files found)");
  else {
    log.info(
      `    stack files     : ${a.stackFiles.join(" ")}${a.needsOverride ? ` + ${OVERRIDE_FILE} (generated for hard-coded ports)` : " (no override needed)"}`,
    );
    if (a.needsOverride) {
      const v = composeVersion(ctx.env);
      log.info(
        v.ok === true
          ? "    compose version : OK (>= 2.24)"
          : v.ok === false
            ? `    compose version : TOO OLD (${v.version}) — apply will fail; >= 2.24 required`
            : "    compose version : not detectable (docker missing?) — override needs >= 2.24 at runtime",
      );
    }
    for (const v of a.vars) log.info(`    ${v.service}: \${${v.name}} (host port ${v.port}) -> set in .env`);
    for (const h of hs) {
      log.info(
        `    hint: ${h.service} uses a hard-coded host port (${h.item}). To isolate it without the override, write it as "${h.suggestion}"`,
      );
    }
  }

  log.info("");
  log.info("==> port analysis");
  log.info(`    label '${a.label}' -> offset=+${a.offset}`);
  for (const p of a.sources) log.info(`    port ${p} -> would try ${p + a.offset} (then probe upward)`);
  if (a.sources.length === 0) log.info("    (no ports detected)");

  return {
    root,
    label: a.label,
    project: a.project,
    applied,
    offset: a.offset,
    envFiles: a.envFiles,
    compose: { files: a.stackFiles, override: a.needsOverride, vars: a.vars, hints: hs },
    ports: a.sources.map((from) => ({ from, candidate: from + a.offset })),
  };
}
