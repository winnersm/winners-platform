/**
 * Traslada el token de Meta del acortador a core.Secret.
 *
 * Estaba cifrado con la clave propia del acortador. Se descifra con ella y se
 * vuelve a cifrar con la clave maestra, para que quede como un secreto más y
 * se pueda rotar desde /admin/secrets.
 *
 * Uso:
 *   DATABASE_URL=... OLD_KEY=<hex64 del acortador> ENCRYPTION_KEY=<hex64 maestra> \
 *     node scripts/migrate-links-token.mjs [--apply]
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const APPLY = process.argv.includes("--apply");
const CLAVE_DESTINO = "links_meta_token";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Mismo formato en origen y destino: iv(16) + authTag(16) + ciphertext, en base64.
function decrypt(b64, hexKey) {
  const data = Buffer.from(b64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), data.subarray(0, 16));
  decipher.setAuthTag(data.subarray(16, 32));
  return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]).toString("utf8");
}

function encrypt(texto, hexKey) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), iv);
  const enc = Buffer.concat([cipher.update(texto, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

async function main() {
  const oldKey = process.env.OLD_KEY;
  const newKey = process.env.ENCRYPTION_KEY;
  if (!oldKey || oldKey.length !== 64) throw new Error("OLD_KEY debe ser un hex de 64 caracteres");
  if (!newKey || newKey.length !== 64) throw new Error("ENCRYPTION_KEY debe ser un hex de 64 caracteres");

  const conns = await prisma.$queryRaw`
    SELECT id, name, "encryptedToken", "tokenLast4"
    FROM legacy_links."MetaConnection"
    WHERE status = 'active'
    ORDER BY "createdAt" DESC
  `;

  if (conns.length === 0) {
    console.log("No hay conexiones activas en el acortador.");
    return;
  }

  console.log(APPLY ? "=== APLICANDO ===" : "=== SIMULACIÓN (usa --apply) ===");
  console.log();

  // Se elige la que de verdad funciona: la más reciente puede estar bloqueada
  // por Meta, y migrar un token muerto solo traslada el problema.
  let conn = null;
  for (const c of conns) {
    let t;
    try {
      t = decrypt(c.encryptedToken, oldKey);
    } catch {
      console.log(`  ${c.name}: no se pudo descifrar, se salta`);
      continue;
    }
    const r = await fetch(
      `https://graph.facebook.com/v21.0/me/adaccounts?fields=id&limit=1&access_token=${t}`,
    ).then((x) => x.json()).catch(() => ({ error: { message: "sin respuesta" } }));

    if (r.error) {
      console.log(`  ${c.name} (····${c.tokenLast4}): NO SIRVE — ${r.error.message}`);
      continue;
    }
    console.log(`  ${c.name} (····${c.tokenLast4}): funciona`);
    conn = c;
    break;
  }

  if (!conn) {
    console.error();
    console.error("Ninguno de los tokens del acortador funciona contra Meta.");
    console.error("Hay que generar uno nuevo y añadirlo en /admin/secrets.");
    process.exit(1);
  }
  let token;
  try {
    token = decrypt(conn.encryptedToken, oldKey);
  } catch (e) {
    console.error("  No se pudo descifrar con OLD_KEY:", e.message);
    console.error("  Habrá que reintroducir el token a mano en /admin/secrets.");
    process.exit(1);
  }

  console.log(`  Descifrado correctamente (${token.length} caracteres, acaba en ····${token.slice(-4)})`);

  if (APPLY) {
    await prisma.secret.upsert({
      where: { key: CLAVE_DESTINO },
      create: {
        key: CLAVE_DESTINO,
        label: "Token de Meta para enlaces",
        section: "meta",
        ciphertext: encrypt(token, newKey),
        hint: token.slice(-4),
      },
      update: { ciphertext: encrypt(token, newKey), hint: token.slice(-4) },
    });
    console.log();
    console.log(`  Guardado como secreto "${CLAVE_DESTINO}".`);
  }
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
