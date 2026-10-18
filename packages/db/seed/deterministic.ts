import { createHash } from "node:crypto";

/** RFC 4122 v5-style UUID from a stable name, so re-seeding yields identical ids. */
const NAMESPACE = "ssos-seed-v1";

export function seedId(...parts: (string | number)[]): string {
  const hash = createHash("sha1").update(`${NAMESPACE}:${parts.join(":")}`).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function seedToken(...parts: string[]): string {
  return createHash("sha256").update(`${NAMESPACE}:token:${parts.join(":")}`).digest("base64url").slice(0, 32);
}

/** Small deterministic PRNG (mulberry32). */
export function prng(seedText: string): () => number {
  let a = createHash("sha1").update(seedText).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rand: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rand() * items.length)];
  if (item === undefined) throw new Error("pick() from empty list");
  return item;
}
