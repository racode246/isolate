#!/usr/bin/env node
import { main } from "./main.js";

main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  },
);
