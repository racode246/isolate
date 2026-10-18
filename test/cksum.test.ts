import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { cksum, portOffset } from "../src/cksum.js";

function shellCksum(s: string): number {
  const out = execFileSync("sh", ["-c", 'printf "%s" "$1" | cksum', "sh", s], { encoding: "utf8" });
  return Number(out.trim().split(/\s+/)[0]);
}

describe("cksum", () => {
  const labels = ["", "a", "feat/x", "main", "fix/very-long-branch-name-with-many-parts-123", "日本語ブランチ"];
  for (const label of labels) {
    it(`matches POSIX cksum for ${JSON.stringify(label)}`, () => {
      expect(cksum(label)).toBe(shellCksum(label));
    });
  }

  it("derives the port offset like isolate.sh", () => {
    for (const label of labels) {
      expect(portOffset(label)).toBe(((shellCksum(label) % 100) + 1) * 10);
    }
  });
});
