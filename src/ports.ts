import { createServer } from "node:net";

/** true when TCP port can be bound on 127.0.0.1 right now */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/**
 * old port -> new port: start at old + offset and probe upward for a free
 * port, never handing out a source port or one already assigned.
 * Ports with no free candidate within 1000 tries are left out.
 */
export async function assignPorts(sources: number[], offset: number): Promise<Map<number, number>> {
  const reserved = new Set(sources);
  const mapping = new Map<number, number>();
  for (const from of sources) {
    let p = from + offset;
    for (let tries = 0; tries < 1000; tries++, p++) {
      if (p > 65535) p = 20000;
      if (!reserved.has(p) && (await portFree(p))) {
        reserved.add(p);
        mapping.set(from, p);
        break;
      }
    }
  }
  return mapping;
}
