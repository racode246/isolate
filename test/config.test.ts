import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { envValue, fakeDocker, makeRepo, read, run, snapshot } from "./helpers.js";

const GITIGNORE = ".env\n.env.*\n.isolate-*\nlocal/\n";
const compose = 'services:\n  web:\n    image: nginx\n    ports:\n      - "${WEB_PORT:-3000}:80"\n  db:\n    image: postgres\n    ports:\n      - "5432:5432"\n';
const config = (c: unknown) => JSON.stringify(c, null, 2) + "\n";

describe("isolate.config.json", () => {
  it("envPorts: false leaves .env ports alone", async () => {
    const root = makeRepo({
      tracked: { ".gitignore": GITIGNORE, "isolate.config.json": config({ envPorts: false }) },
      untracked: { ".env": "PORT=3000\n" },
    });
    const r = await run(root, ["apply"]);
    expect(r.code, r.stderr).toBe(0);
    expect(envValue(read(root, ".env"), "PORT")).toBe("3000");
  });

  it("composePorts: false neither generates an override nor sets compose port variables", async () => {
    const root = makeRepo({
      tracked: { ".gitignore": GITIGNORE, "compose.yml": compose, "isolate.config.json": config({ composePorts: { enabled: false } }) },
    });
    const r = await run(root, ["apply"]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(root, ".isolate-compose.override.yml"))).toBe(false);
    const env = read(root, ".env");
    expect(envValue(env, "WEB_PORT")).toBeUndefined();
    expect(envValue(env, "COMPOSE_FILE")).toBeUndefined();
    expect(envValue(env, "COMPOSE_PROJECT_NAME")).toBe("app-main");
  });

  it("composeProject: false does not set COMPOSE_PROJECT_NAME", async () => {
    const root = makeRepo({
      tracked: { ".gitignore": GITIGNORE, "compose.yml": compose.split("  db:")[0]!, "isolate.config.json": config({ composeProject: false }) },
    });
    const r = await run(root, ["apply", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).project).toBeNull();
    const env = read(root, ".env");
    expect(envValue(env, "COMPOSE_PROJECT_NAME")).toBeUndefined();
    expect(envValue(env, "WEB_PORT")).toMatch(/^\d+$/);
  });

  it("envPorts.files and keyPattern select exactly the files and keys to remap", async () => {
    const root = makeRepo({
      tracked: {
        ".gitignore": GITIGNORE,
        "isolate.config.json": config({ envPorts: { files: ["local/*.env", ".env"], keyPattern: "^(PORT|DB_ADDR_PORT|LISTEN)$" } }),
      },
      untracked: { ".env": "PORT=3000\nAPI_PORT=4000\nLISTEN=4100\n", "local/dev.env": "PORT=3001\n", ".env.local": "PORT=3002\n" },
    });
    const r = await run(root, ["apply", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const env = read(root, ".env");
    expect(envValue(env, "PORT")).not.toBe("3000");
    expect(envValue(env, "LISTEN")).not.toBe("4100");
    expect(envValue(env, "API_PORT")).toBe("4000");
    expect(envValue(read(root, "local/dev.env"), "PORT")).not.toBe("3001"); // inside a fully untracked dir
    expect(envValue(read(root, ".env.local"), "PORT")).toBe("3002"); // not selected
  });

  it("composePorts.files replaces the default compose stack", async () => {
    const docker = fakeDocker("2.29.1");
    const root = makeRepo({
      tracked: {
        ".gitignore": GITIGNORE,
        "compose.yml": compose,
        "docker/dev.yml": 'services:\n  cache:\n    image: redis\n    ports:\n      - "6379:6379"\n',
        "isolate.config.json": config({ composePorts: { files: ["docker/dev.yml"] } }),
      },
    });
    const r = await run(root, ["apply", "--json"], { ISOLATE_DOCKER_BIN: docker.bin });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ports.map((p: { from: number }) => p.from)).toEqual([6379]);
    expect(out.composeFile).toBe("docker/dev.yml:.isolate-compose.override.yml");
  });

  it("label in the config is the default label; --name still wins", async () => {
    const root = makeRepo({
      tracked: { ".gitignore": GITIGNORE, "isolate.config.json": config({ label: "fixed" }) },
      untracked: { ".env": "PORT=3000\n" },
    });
    const r = await run(root, ["apply", "--json"]);
    expect(JSON.parse(r.stdout).label).toBe("fixed");
    await run(root, ["reset"]);
    expect(JSON.parse((await run(root, ["apply", "--json", "--name", "other"])).stdout).label).toBe("other");
  });

  const invalid: [string, unknown, RegExp][] = [
    ["unknown top-level key", { envPort: true }, /unknown key "envPort"/],
    ["wrong resolver type", { envPorts: "yes" }, /envPorts: expected a boolean or an object/],
    ["unknown resolver key", { composePorts: { file: [] } }, /composePorts: unknown key "file"/],
    ["files not a string list", { envPorts: { files: [1] } }, /envPorts\.files: expected an array of strings/],
    ["invalid keyPattern", { envPorts: { keyPattern: "(" } }, /envPorts\.keyPattern: invalid regular expression/],
    ["label not a string", { label: 3 }, /label: expected a non-empty string/],
  ];
  for (const [name, cfg, msg] of invalid) {
    it(`rejects an invalid config: ${name}`, async () => {
      const root = makeRepo({ tracked: { ".gitignore": GITIGNORE, "isolate.config.json": config(cfg) }, untracked: { ".env": "PORT=3000\n" } });
      const before = snapshot(root);
      const r = await run(root, ["apply"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/isolate\.config\.json/);
      expect(r.stderr).toMatch(msg);
      expect(snapshot(root)).toEqual(before);
    });
  }

  it("rejects a config that is not valid JSON", async () => {
    const root = makeRepo({ tracked: { "isolate.config.json": "{ nope" } });
    const r = await run(root, ["doctor"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/isolate\.config\.json: invalid JSON/);
  });

  it("accepts the $schema key", async () => {
    const root = makeRepo({ tracked: { "isolate.config.json": config({ $schema: "https://unpkg.com/@racode246/isolate/schema.json" }) } });
    expect((await run(root, ["doctor"])).code).toBe(0);
  });
});
