// Line-level edits of dotenv files that keep every other byte intact, so that
// reset can restore a file exactly.

const LINE_RE = /^([A-Za-z0-9_]+)=(.*?)(\r?)$/;

function parse(line: string): { key: string; value: string; cr: string } | null {
  const m = line.match(LINE_RE);
  return m ? { key: m[1]!, value: m[2]!, cr: m[3]! } : null;
}

export interface PortEntry {
  key: string;
  port: number;
}

/** KEY=<2-5 digit port> lines whose key matches keyPattern */
export function scanPorts(content: string, keyPattern: RegExp): PortEntry[] {
  const out: PortEntry[] = [];
  for (const line of content.split("\n")) {
    const p = parse(line);
    if (p && /^[0-9]{2,5}$/.test(p.value) && keyPattern.test(p.key)) out.push({ key: p.key, port: Number(p.value) });
  }
  return out;
}

/** value of the last KEY= line, surrounding quotes stripped */
export function getValue(content: string, key: string): string | undefined {
  let v: string | undefined;
  for (const line of content.split("\n")) {
    const p = parse(line);
    if (p && p.key === key) v = p.value;
  }
  if (v === undefined) return undefined;
  return v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
}

/** rewrite KEY=from -> KEY=to (exact lines only) */
export function replacePort(content: string, key: string, from: string, to: string): string {
  return content
    .split("\n")
    .map((line) => {
      const p = parse(line);
      return p && p.key === key && p.value === from ? `${key}=${to}${p.cr}` : line;
    })
    .join("\n");
}

export type SetResult =
  | { kind: "unchanged"; content: string }
  | { kind: "replaced"; content: string; previous: string }
  | { kind: "added"; content: string; addedNewline: boolean };

/** set KEY=value: replace the first KEY= line, or append one */
export function setValue(content: string, key: string, value: string): SetResult {
  const lines = content.split("\n");
  const i = lines.findIndex((l) => parse(l)?.key === key);
  if (i >= 0) {
    const p = parse(lines[i]!)!;
    if (p.value === value) return { kind: "unchanged", content };
    lines[i] = `${key}=${value}${p.cr}`;
    return { kind: "replaced", content: lines.join("\n"), previous: p.value };
  }
  const addedNewline = content.length > 0 && !content.endsWith("\n");
  return { kind: "added", content: `${content}${addedNewline ? "\n" : ""}${key}=${value}\n`, addedNewline };
}

/** undo an "added": drop the last KEY= line (and the newline added before it) */
export function removeAdded(content: string, key: string, addedNewline: boolean): string {
  const lines = content.split("\n");
  let i = -1;
  lines.forEach((l, idx) => {
    if (parse(l)?.key === key) i = idx;
  });
  if (i < 0) return content;
  lines.splice(i, 1);
  let out = lines.join("\n");
  if (addedNewline && i === lines.length - 1 && out.endsWith("\n")) out = out.slice(0, -1);
  return out;
}

/** undo a "replaced": put the previous value back on the first KEY= line */
export function restoreValue(content: string, key: string, previous: string): string {
  const lines = content.split("\n");
  const i = lines.findIndex((l) => parse(l)?.key === key);
  if (i < 0) return content;
  lines[i] = `${key}=${previous}${parse(lines[i]!)!.cr}`;
  return lines.join("\n");
}
