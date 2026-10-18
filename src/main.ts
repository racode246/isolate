import { readFileSync } from "node:fs";
import { apply, type Context, doctor, list, reset, status } from "./commands.js";
import { loadConfig } from "./config.js";
import { IsolateError, PROG, findRepo } from "./util.js";

export interface Io {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const USAGE = `usage: ${PROG} <command> [options]

Isolate the dev environment of the current git checkout so several checkouts
(worktrees) of one repo can run side by side. Tracked files are never edited;
everything apply changes is recorded and undone exactly by reset.

commands
  apply  [--name <label>] [--json]
      Remap ports in untracked .env* files, set "\${VAR:-default}" compose
      host ports via VAR in .env, generate .isolate-compose.override.yml for
      hard-coded compose host ports (needs docker compose >= 2.24), and set
      COMPOSE_FILE / COMPOSE_PROJECT_NAME in .env.
      --name <label>  label for the port offset and compose project name
                      (default: "label" in isolate.config.json, else the branch)
  status [--json]          the mapping applied to the current checkout
  list   [--json]          every worktree of this repo and its mapping
  reset  [--with-docker]   undo apply; --with-docker runs
                           'docker compose -p <project> down -v' first
  doctor [--name <label>] [--json]
      dry run: what apply would remap, plus var-form hints for compose ports

options
  --json         print one JSON object to stdout (logs go to stderr)
  -h, --help     show this help
  -v, --version  show the version

config: isolate.config.json at the checkout root (optional) selects what to
resolve — see https://github.com/racode246/isolate#configuration
`;

interface Spec {
  name?: boolean;
  json?: boolean;
  withDocker?: boolean;
}

const SPECS: Record<string, Spec> = {
  apply: { name: true, json: true },
  status: { json: true },
  list: { json: true },
  reset: { withDocker: true },
  doctor: { name: true, json: true },
};

interface Parsed {
  name?: string;
  json: boolean;
  withDocker: boolean;
}

function parseArgs(cmd: string, args: string[]): Parsed {
  const spec = SPECS[cmd]!;
  const out: Parsed = { json: false, withDocker: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (spec.name && (a === "--name" || a.startsWith("--name="))) {
      const v = a === "--name" ? args[++i] : a.slice("--name=".length);
      if (!v) throw new IsolateError("--name needs a value", 2);
      out.name = v;
    } else if (spec.json && a === "--json") out.json = true;
    else if (spec.withDocker && a === "--with-docker") out.withDocker = true;
    else throw new IsolateError(`unknown option for ${cmd}: ${a}`, 2);
  }
  return out;
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

export async function main(argv: string[], io: Io): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === undefined) {
      io.stderr(USAGE);
      return 2;
    }
    if (cmd === "-h" || cmd === "--help" || cmd === "help") {
      io.stdout(USAGE);
      return 0;
    }
    if (cmd === "-v" || cmd === "--version") {
      io.stdout(`${version()}\n`);
      return 0;
    }
    if (!(cmd in SPECS)) {
      io.stderr(USAGE);
      throw new IsolateError(`unknown subcommand: ${cmd}`, 2);
    }
    const opts = parseArgs(cmd, rest);
    const info = opts.json ? io.stderr : io.stdout;
    const repo = findRepo(io.cwd);
    const ctx: Context = {
      repo,
      config: loadConfig(repo.root),
      env: io.env,
      log: { info: (s) => info(`${s}\n`), warn: (s) => io.stderr(`warn: ${s}\n`) },
    };
    let result: object | undefined;
    switch (cmd) {
      case "apply":
        result = await apply(ctx, { name: opts.name });
        break;
      case "status":
        result = status(ctx);
        break;
      case "list":
        result = list(ctx);
        break;
      case "reset":
        reset(ctx, { withDocker: opts.withDocker });
        break;
      case "doctor":
        result = doctor(ctx, { name: opts.name });
        break;
    }
    if (opts.json && result) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof IsolateError) {
      io.stderr(`error: ${e.message}\n`);
      return e.code;
    }
    throw e;
  }
}
