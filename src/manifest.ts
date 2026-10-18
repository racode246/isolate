import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_FILE } from "./util.js";

/** One change apply made to the checkout; reset undoes them in reverse order. */
export type Change =
  | { type: "env-port"; file: string; key: string; from: number; to: number }
  | { type: "key-added"; file: string; key: string; addedNewline: boolean }
  | { type: "key-replaced"; file: string; key: string; previous: string }
  | { type: "created"; file: string }
  | { type: "generated"; file: string };

export interface Manifest {
  generatedBy: string;
  version: 1;
  label: string;
  project: string | null;
  changes: Change[];
}

export function manifestPath(root: string): string {
  return join(root, MANIFEST_FILE);
}

export function writeManifest(root: string, m: Manifest): void {
  writeFileSync(manifestPath(root), JSON.stringify(m, null, 2) + "\n");
}

/** the manifest, "legacy" for one written by isolate.sh, or null when not applied */
export function readManifest(root: string): Manifest | "legacy" | null {
  const p = manifestPath(root);
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8");
  if (!text.trimStart().startsWith("{")) return "legacy";
  return JSON.parse(text) as Manifest;
}
