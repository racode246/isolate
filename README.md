# @racode246/isolate

Run several checkouts (git worktrees) of one repository side by side without port or docker compose collisions.

`isolate apply` changes only the **current checkout**: it remaps ports in untracked `.env*` files, remaps docker compose host ports, and gives the compose project its own name. Tracked files are never edited, and `isolate reset` undoes everything exactly.

```bash
cd ../my-app-feat-x            # a worktree of my-app
npx @racode246/isolate apply   # ports + compose isolated for this checkout
npm run dev                    # reads the rewritten .env
docker compose up -d           # project my-app-feat-x, remapped host ports
npx @racode246/isolate reset --with-docker
```

## Commands

| Command | What it does |
|---|---|
| `apply [--name <label>] [--json]` | Isolate the current checkout. |
| `status [--json]` | Show the mapping applied to the current checkout. |
| `list [--json]` | Show every worktree of the repo and its mapping. |
| `reset [--with-docker]` | Undo `apply`. `--with-docker` first runs `docker compose -p <project> down -v`. |
| `doctor [--name <label>] [--json]` | Dry run: what `apply` would remap, with hints. Changes nothing. |

`<label>` drives the port offset and the compose project name. Default: `label` in the config file, else the current branch, else the directory name.

`--json` prints one JSON object to stdout; logs go to stderr. `apply --json` prints:

```json
{
  "root": "/path/to/checkout",
  "label": "feat/x",
  "project": "my-app-feat-x",
  "ports": [{ "from": 3000, "to": 3460 }],
  "files": [".env", ".isolate-compose.override.yml", ".isolate-ports.env"],
  "composeFile": "compose.yml:.isolate-compose.override.yml",
  "envFile": ".env",
  "portsFile": ".isolate-ports.env"
}
```

`envFile` is where the `COMPOSE_*` settings went: `.env`, or `.isolate-ports.env` when `.env` is tracked (then run `docker compose --env-file .isolate-ports.env ...`), or `null` when nothing needed them.

## What `apply` changes

1. **Ports in env files**: `KEY=<port>` lines whose key ends in `PORT` in untracked `.env` / `.env.*` files. Tracked files such as `.env.example` are skipped.
2. **Compose host ports**:
   - `"${WEB_PORT:-3000}:80"` (short or long syntax): sets `WEB_PORT` in `.env`. No override needed.
   - Hard-coded `"3000:80"`: writes `.isolate-compose.override.yml`, which replaces the service's `ports` with the `!override` tag, and adds it to `COMPOSE_FILE` in `.env`. This needs **docker compose >= 2.24**; `apply` stops before changing anything if the version is older. `doctor` prints the `${VAR:-default}` form for each such port, so you can avoid the override.
3. **Compose project**: `COMPOSE_PROJECT_NAME=<repo>-<label>` in `.env`, so containers, networks and volumes don't collide.

New ports are `old + ((cksum(label) % 100) + 1) * 10`, then the next free port upward. A label therefore maps to the same ports every time.

`apply` records every change in `.isolate-manifest` and writes the mapping to `.isolate-ports.env` (`PORT_<old>=<new>`). Add the generated files to your gitignore:

```gitignore
.isolate-ports.env
.isolate-manifest
.isolate-compose.override.yml
```

## Configuration

Put an optional `isolate.config.json` at the checkout root (commit it, so every worktree shares it). Without it, everything is enabled with the defaults below.

```json
{
  "$schema": "https://unpkg.com/@racode246/isolate/schema.json",
  "label": "review",
  "envPorts": { "files": [".env", "apps/*/.env.local"], "keyPattern": "(^|_)PORT$" },
  "composePorts": { "files": ["docker/compose.dev.yml"] },
  "composeProject": false
}
```

| Key | Default | Meaning |
|---|---|---|
| `label` | branch name | Default label (`--name` wins). |
| `envPorts` | `true` | `false` to leave env files alone, or an object: |
| `envPorts.files` | untracked `.env`, `.env.*` | Globs (`*`, `?`, `**`) relative to the root. |
| `envPorts.keyPattern` | `PORT$` | Regular expression tested against the key. |
| `composePorts` | `true` | `false` to leave compose ports alone, or an object: |
| `composePorts.files` | primary compose file + its `*.override.*` | Compose files in load order. |
| `composeProject` | `true` | `false` to keep the default compose project name. |

Each resolver also accepts `{ "enabled": false }`. Unknown keys and wrong types are errors.

## Requirements

- Node.js >= 20 and git
- docker compose >= 2.24 only when a hard-coded compose host port needs the override

## Not covered

Ports hard-coded in application source, ports inside URLs (`API_URL=http://localhost:3000`), port ranges (`3000-3005:3000-3005`), and compose files outside the configured stack. Run `doctor` to see exactly what `apply` will touch.

## License

MIT
