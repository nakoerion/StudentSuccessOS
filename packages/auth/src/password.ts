import bcrypt from "bcryptjs";

const COST = 10;

/** A valid bcrypt hash of a random string, used to keep timing equal for unknown e-mails. */
const DUMMY_HASH = "$2b$10$4YlEDjbYoHyaSpgV/dkrn..hcRFuKx/gnXuf530rFc5.dZ5a9AdL.";

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST);
}

/** Constant-ish time: always runs one bcrypt compare, even when there is no hash. */
export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  const ok = await bcrypt.compare(password, hash ?? DUMMY_HASH);
  return ok && Boolean(hash);
}
