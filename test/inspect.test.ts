import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { portOffset } from "../src/cksum.js";
import { git, makeRepo, run } from "./helpers.js";

const GITIGNORE = ".env\n.isolate-*\n";
const compose = 'services:\n  web:\n    image: nginx\n    ports:\n      - "${WEB_PORT:-3000}:80"\n  db:\n    image: postgres\n    ports:\n      - "5432:5432"\n      - "6000:6000"\n';

describe("doctor", () => {
  it("prints var-form hints for hard-coded host ports and changes nothing", async () => {
    const root = makeRepo({ tracked: { ".gitignore": GITIGNORE, "compose.yml": compose }, untracked: { ".env": "PORT=3000\n" } });
    const r = await run(root, ["doctor"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('"${DB_PORT:-5432}:5432"');
    expect(r.stdout).toContain('"${DB_PORT_2:-6000}:6000"');
    expect(r.stdout).not.toMatch(/hint:.*web/);
    expect(git(root, "status", "--porcelain", "--ignored")).toBe("!! .env\n");
  });

  it("--json describes what apply would do", async () => {
    const root = makeRepo({ tracked: { ".gitignore": GITIGNORE, "compose.yml": compose }, untracked: { ".env": "PORT=3000\n" }, branch: "feat/x" });
    const r = await run(root, ["doctor", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({
      label: "feat/x",
      project: "app-feat-x",
      applied: false,
      offset: portOffset("feat/x"),
      envFiles: [".env"],
      compose: {
        files: ["compose.yml"],
        override: true,
        vars: [{ service: "web", name: "WEB_PORT", port: 3000 }],
      },
    });
    expect(out.ports).toEqual([3000, 5432, 6000].map((from) => ({ from, candidate: from + portOffset("feat/x") })));
    expect(out.compose.hints).toEqual([
      { service: "db", item: "5432:5432", suggestion: "${DB_PORT:-5432}:5432" },
      { service: "db", item: "6000:6000", suggestion: "${DB_PORT_2:-6000}:6000" },
    ]);
  });
});

describe("status / list", () => {
  it("status --json reports the applied mapping", async () => {
    const root = makeRepo({ tracked: { ".gitignore": GITIGNORE }, untracked: { ".env": "PORT=3000\n" } });
    expect(JSON.parse((await run(root, ["status", "--json"])).stdout)).toMatchObject({ applied: false });
    const applied = JSON.parse((await run(root, ["apply", "--json"])).stdout);
    const s = await run(root, ["status", "--json"]);
    expect(s.code, s.stderr).toBe(0);
    expect(JSON.parse(s.stdout)).toEqual({
      root: git(root, "rev-parse", "--show-toplevel").trim(),
      applied: true,
      label: "main",
      project: "app-main",
      composeFile: null,
      ports: applied.ports,
    });
  });

  it("list shows every worktree with its mapping", async () => {
    const root = makeRepo({ tracked: { ".gitignore": GITIGNORE } });
    const wt = join(root, "..", "wt-x");
    git(root, "worktree", "add", "-q", "-b", "feat/x", wt);
    await run(wt, ["apply"]);
    const r = await run(root, ["list"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("[main]");
    expect(r.stdout).toContain("[feat/x]");
    expect(r.stdout).toContain("(not isolated)");
    expect(r.stdout).toContain("label          : feat/x");
  });
});

describe("cli", () => {
  it("prints usage and fails on an unknown subcommand", async () => {
    const r = await run(makeRepo(), ["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown subcommand/);
  });

  it("--help succeeds and --version prints the package version", async () => {
    expect((await run(makeRepo(), ["--help"])).stdout).toMatch(/usage: isolate/);
    expect((await run(makeRepo(), ["--version"])).stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it("fails outside a git repository", async () => {
    const { tempDir } = await import("./helpers.js");
    const r = await run(tempDir(), ["status"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not inside a git repository/);
  });

  it("rejects unknown options", async () => {
    const r = await run(makeRepo(), ["apply", "--frob"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown option/);
  });
});
