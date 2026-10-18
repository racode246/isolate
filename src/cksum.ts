// POSIX `cksum` (CRC-32, polynomial 0x04C11DB7, MSB first, length appended),
// so port offsets stay identical to the original isolate.sh.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function cksum(s: string): number {
  let crc = 0;
  const step = (byte: number) => {
    crc = ((crc << 8) ^ TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  };
  const bytes = Buffer.from(s, "utf8");
  for (const b of bytes) step(b);
  for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) step(n & 0xff);
  return ~crc >>> 0;
}

/** ((cksum(label) % 100) + 1) * 10: 10..1000 in steps of 10 */
export function portOffset(label: string): number {
  return ((cksum(label) % 100) + 1) * 10;
}
