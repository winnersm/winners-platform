import { randomBytes } from "crypto";

// Solo minúsculas + números (base36): slugs sin mayúsculas.
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Genera un slug aleatorio en minúsculas (default 7 chars → colisión despreciable). */
export function generateSlug(length = 7): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export function isValidSlug(slug: string): boolean {
  return /^[0-9A-Za-z_-]{3,64}$/.test(slug);
}

/**
 * Slug con prefijo tipo "video-x7kp2q" para que el enlace parezca contenido real
 * y no spam. Si no hay prefijo válido, devuelve solo el aleatorio.
 */
export function buildSlug(prefix: string | undefined, randomLen = 6): string {
  const rand = generateSlug(randomLen);
  const clean = (prefix || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return clean ? `${clean}-${rand}` : rand;
}
