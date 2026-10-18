import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { portOffset } from "../src/cksum.js";
import { envValue, fakeDocker, git, makeRepo, read, run, snapshot } from "./helpers.js";

const GITIGNORE = ".env\n.env.*\n.isolate-*\n";

describe("apply / reset: env files", () => {
  it("remaps PORT keys in untracked .env files and reset restores them byte for byte", async () => {
    const root = makeRepo({
      tracked: { ".gitignore": ".env\n.env.local\n.isolate-*\n", "apps/web/package.json": "{}\n", ".env.example": "PORT=3000\n" },
      untracked: {
        ".env": "PORT=3000\nAPI_PORT=4000\nNAME=x\nPORTAL=7000\n",
        "apps/web/.env.local": "WEB_PORT=5173",
      },
      branch: "feat/x",
    });
    const before = snapshot(root);
    const status = git(root, "status", "--porcelain", "--ignored");

    const r = await run(root, ["apply"]);
    expect(r.code, r.stderr).toBe(0);

    const env = read(root, ".env");
    const port = Number(envValue(env, "PORT"));
    expect(port).toBeGreaterThanOrEqual(3000 + portOffset("feat/x"));
    expect(Number(envValue(env, "API_PORT"))).toBeGreaterThanOrEqual(4000 + portOffset("feat/x"));
    expect(envValue(env, "NAME")).toBe("x");
    expect(envValue(env, "PORTAL")).toBe("7000"); // key does not end in PORT
    expect(Number(envValue(read(root, "apps/web/.env.local"), "WEB_PORT"))).toBeGreaterThan(5173);
    expect(read(root, ".env.example")).toBe("PORT=3000\n"); // tracked: untouched
    expect(envValue(read(root, ".isolate-ports.env"), "PORT_3000")).toBe(String(port));
    expect(envValue(read(root, ".isolate-ports.env"), "ISOLATE_NAME")).toBe("feat/x");
    expect(existsSync(join(root, ".isolate-manifest"))).toBe(true);
    expect(git(root, "status", "--porcelain")).toBe(""); // tracked files untouched

    const reset = await run(root, ["reset"]);
    expect(reset.code, reset.stderr).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(git(root, "status", "--porcelain", "--ignored")).toBe(status);
  });

  it("refuses to apply twice", async () => {
    const root = makeRepo({ tracked: { ".gitignore": GITIGNORE }, untracked: { ".env": "PORT=3000\n" } });
    expect((await run(root, ["apply"])).code).toBe(0);
    const again = await run(root, ["apply"]);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toMatch(/already applied/);
  });

  it("reset without apply fails", async () => {
    const root = makeRepo();
    const r = await run(root, ["reset"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not applied/);
  });

  it("--name sets the label and compose project", async () => {
    const root = makeRepo({ name: "My_App", tracked: { ".gitignore": GITIGNORE }, untracked: { ".env": "PORT=3000\n" } });
    expect((await run(root, ["apply", "--name", "Review 1"])).code).toBe(0);
    expect(envValue(read(root, ".env"), "COMPOSE_PROJECT_NAME")).toBe("my-app-review-1");
    expect(Number(envValue(read(root, ".env"), "PORT"))).toBeGreaterThanOrEqual(3000 + portOffset("Review 1"));
  });

  it("never edits a tracked .env and points to --env-file instead", async () => {
    const root = makeRepo({
      tracked: { ".gitignore": ".isolate-*\n", ".env": "PORT=3000\n", "compose.yml": "services:\n  web:\n    image: nginx\n    ports:\n      - \"${WEB_PORT:-8080}:80\"\n" },
    });
    const r = await run(root, ["apply"]);
    expect(r.code, r.stderr).toBe(0);
    expect(read(root, ".env")).toBe("PORT=3000\n");
    expect(r.stderr + r.stdout).toMatch(/--env-file \.isolate-ports\.env/);
    expect(envValue(read(root, ".isolate-ports.env"), "WEB_PORT")).toMatch(/^\d+$/);
    expect(git(root, "status", "--porcelain")).toBe("");
  });
});

describe("apply / reset: docker compose", () => {
  const varCompose = 'services:\n  web:\n    image: nginx\n    ports:\n      - "${WEB_PORT:-3000}:80"\n';

  it("remaps a ${VAR:-default} host port through .env without an override", async () => {
    const root = makeRepo({ tracked: { ".gitignore": GITIGNORE, "compose.yml": varCompose } });
    const r = await run(root, ["apply"]);
    expect(r.code, r.stderr).toBe(0);
    const env = read(root, ".env");
    expect(Number(envValue(env, "WEB_PORT"))).toBeGreaterThanOrEqual(3000 + portOffset("main"));
    expect(envValue(env, "COMPOSE_FILE")).toBeUndefined();
    expect(envValue(env, "COMPOSE_PROJECT_NAME")).toBe("app-main");
    expect(existsSync(join(root, ".isolate-compose.override.yml"))).toBe(false);

    expect((await run(root, ["reset"])).code).toBe(0);
    expect(existsSync(join(root, ".env"))).toBe(false); // created by apply, removed by reset
    expect(git(root, "status", "--porcelain", "--ignored")).toBe("");
  });

  it("uses the .env value of the variable as the source port", async () => {
    const root = makeRepo({ tracked: { ".gitignore": GITIGNORE, "compose.yml": varCompose }, untracked: { ".env": "WEB_PORT=3100\n" } });
    const r = await run(root, ["apply", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ports.map((p: { from: number }) => p.from)).toEqual([3100]);
    expect(Number(envValue(read(root, ".env"), "WEB_PORT"))).toBe(out.ports[0].to);
    expect((await run(root, ["reset"])).code).toBe(0);
    expect(read(root, ".env")).toBe("WEB_PORT=3100\n");
  });

  it("generates an override for hard-coded host ports and wires COMPOSE_FILE", async () => {
    const docker = fakeDocker("2.29.1");
    const root = makeRepo({
      tracked: {
        ".gitignore": GITIGNORE,
        "compose.yml":
          'services:\n  db:\n    image: postgres\n    ports:\n      - "127.0.0.1:5432:5432"\n      - 9000\n  web:\n    image: nginx\n    ports: ["${WEB_PORT:-3000}:80", "8443:443/tcp"]\n  api:\n    image: x\n    ports:\n      - target: 80\n        published: 8080\n        protocol: tcp\n',
        "compose.override.yml": "services:\n  db:\n    environment:\n      A: b\n",
      },
    });
    const r = await run(root, ["apply", "--json"], { ISOLATE_DOCKER_BIN: docker.bin });
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    const to = (from: number) => out.ports.find((p: { from: number }) => p.from === from)?.to;
    expect(out.ports.map((p: { from: number }) => p.from)).toEqual([3000, 5432, 8080, 8443]);
    expect(out.composeFile).toBe("compose.yml:compose.override.yml:.isolate-compose.override.yml");

    const env = read(root, ".env");
    expect(envValue(env, "COMPOSE_FILE")).toBe(out.composeFile);
    expect(Number(envValue(env, "WEB_PORT"))).toBe(to(3000));

    const ov = read(root, ".isolate-compose.override.yml");
    expect(ov).toContain("ports: !override");
    expect(ov).toContain(`"127.0.0.1:${to(5432)}:5432"`);
    expect(ov).toContain('"9000"');
    expect(ov).toContain(`"${to(8443)}:443/tcp"`);
    expect(ov).toContain('"${WEB_PORT:-3000}:80"');
    expect(ov).toContain(`"published":"${to(8080)}"`);
    expect(ov).not.toMatch(/^  [a-z]+:\n\s+environment/m);

    expect((await run(root, ["reset"])).code).toBe(0);
    expect(git(root, "status", "--porcelain", "--ignored")).toBe("");
  });

  it("does nothing when an override is needed but docker compose is older than 2.24", async () => {
    const docker = fakeDocker("2.20.0");
    const root = makeRepo({
      tracked: { ".gitignore": GITIGNORE, "compose.yml": 'services:\n  db:\n    image: postgres\n    ports:\n      - "5432:5432"\n' },
      untracked: { ".env": "PORT=3000\n" },
    });
    const before = snapshot(root);
    const r = await run(root, ["apply"], { ISOLATE_DOCKER_BIN: docker.bin });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/2\.24/);
    expect(snapshot(root)).toEqual(before);
  });

  it("names the compose project even when the stack publishes no ports", async () => {
    const root = makeRepo({ tracked: { ".gitignore": GITIGNORE, "docker-compose.yml": "services:\n  worker:\n    image: x\n" } });
    expect((await run(root, ["apply"])).code).toBe(0);
    expect(envValue(read(root, ".env"), "COMPOSE_PROJECT_NAME")).toBe("app-main");
  });

  it("reset --with-docker brings the compose project down first", async () => {
    const docker = fakeDocker("2.29.1");
    const root = makeRepo({ tracked: { ".gitignore": GITIGNORE, "compose.yml": varCompose } });
    expect((await run(root, ["apply"], { ISOLATE_DOCKER_BIN: docker.bin })).code).toBe(0);
    expect((await run(root, ["reset", "--with-docker"], { ISOLATE_DOCKER_BIN: docker.bin })).code).toBe(0);
    expect(read(docker.log, "")).toContain("compose -p app-main down -v");
  });
});
