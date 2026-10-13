/**
 * Vuelve a cifrar los tokens de Meta con la clave maestra.
 *
 * La migración copió `encryptedToken` tal cual desde newappmeta, que usa OTRA
 * clave de cifrado. El resultado: los tokens estaban ahí pero la app no podía
 * descifrar ninguno, así que el módulo Meta Ads no podía hablar con Meta —
 * ni listar cuentas, ni sincronizar, ni duplicar.
 *
 * Además prueba cada token contra Meta y avisa de los que ya no sirven, para
 * no dejar credenciales muertas ocupando sitio.
 *
 * Uso:
 *   DATABASE_URL=... OLD_KEY=<hex64 newappmeta> ENCRYPTION_KEY=<hex64 maestra> \
 *     node scripts/recifrar-tokens-meta.mjs [--apply]
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const APPLY = process.argv.includes("--apply");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Formato común: iv(16) + authTag(16) + ciphertext, en base64.
function decrypt(b64, hexKey) {
  const data = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), data.subarray(0, 16));
  d.setAuthTag(data.subarray(16, 32));
  return Buffer.concat([d.update(data.subarray(32)), d.final()]).toString("utf8");
}

function encrypt(texto, hexKey) {
  const iv = randomBytes(16);
  const c = createCipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), iv);
  const enc = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}

async function pruebaMeta(token) {
  try {
    const r = await fetch(
      `https://graph.facebook.com/v21.0/me/adaccounts?fields=id&limit=1&access_token=${token}`,
    ).then((x) => x.json());
    if (r.error) return { vivo: false, motivo: r.error.message };
    return { vivo: true, cuentas: (r.data ?? []).length };
  } catch {
    return { vivo: false, motivo: "sin respuesta de Meta" };
  }
}

async function main() {
  const oldKey = process.env.OLD_KEY;
  const newKey = process.env.ENCRYPTION_KEY;
  if (!oldKey || oldKey.length !== 64) throw new Error("OLD_KEY debe ser un hex de 64 caracteres");
  if (!newKey || newKey.length !== 64) throw new Error("ENCRYPTION_KEY debe ser un hex de 64");

  console.log(APPLY ? "=== APLICANDO ===" : "=== SIMULACIÓN (usa --apply) ===");
  console.log();

  let ok = 0;
  let muertos = 0;
  let ilegibles = 0;

  // ── Business Managers ──────────────────────────────────────────────────────
  console.log("Business Managers:");
  const bms = await prisma.businessManager.findMany({ orderBy: { name: "asc" } });

  for (const bm of bms) {
    let token;
    try {
      token = decrypt(bm.encryptedToken, oldKey);
    } catch {
      // Puede que ya estuviera cifrado con la clave nueva (script repetido).
      try {
        decrypt(bm.encryptedToken, newKey);
        console.log(`  ${bm.name.padEnd(18)} ya estaba con la clave nueva, se deja`);
        continue;
      } catch {
        console.log(`  ${bm.name.padEnd(18)} NO SE PUEDE DESCIFRAR con ninguna clave`);
        ilegibles++;
        continue;
      }
    }

    const estado = await pruebaMeta(token);
    const etiqueta = estado.vivo ? `funciona (${estado.cuentas} cuenta/s)` : `MUERTO — ${estado.motivo}`;
    console.log(`  ${bm.name.padEnd(18)} ····${token.slice(-4)}  ${etiqueta}`);

    if (estado.vivo) ok++;
    else muertos++;

    if (APPLY) {
      await prisma.businessManager.update({
        where: { id: bm.id },
        data: {
          encryptedToken: encrypt(token, newKey),
          tokenLast4: token.slice(-4),
          // Un token que Meta rechaza no debe quedar como activo: la app lo
          // intentaría usar y fallaría sin explicación.
          status: estado.vivo ? bm.status : "invalid",
        },
      });
    }
  }

  // ── Tokens de Fanpages ─────────────────────────────────────────────────────
  console.log();
  console.log("Tokens de Fanpages:");
  const fts = await prisma.fanpageToken.findMany({ orderBy: { name: "asc" } });

  for (const ft of fts) {
    let token;
    try {
      token = decrypt(ft.encryptedToken, oldKey);
    } catch {
      try {
        decrypt(ft.encryptedToken, newKey);
        console.log(`  ${ft.name.padEnd(26)} ya estaba con la clave nueva, se deja`);
        continue;
      } catch {
        console.log(`  ${ft.name.padEnd(26)} NO SE PUEDE DESCIFRAR`);
        ilegibles++;
        continue;
      }
    }

    // Este token sirve para páginas, no para cuentas publicitarias.
    const r = await fetch(
      `https://graph.facebook.com/v21.0/me?fields=id&access_token=${token}`,
    ).then((x) => x.json()).catch(() => ({ error: { message: "sin respuesta" } }));
    const vivo = !r.error;
    console.log(
      `  ${ft.name.padEnd(26)} ····${token.slice(-4)}  ${vivo ? "funciona" : `MUERTO — ${r.error.message}`}`,
    );

    if (vivo) ok++;
    else muertos++;

    if (APPLY) {
      await prisma.fanpageToken.update({
        where: { id: ft.id },
        data: {
          encryptedToken: encrypt(token, newKey),
          status: vivo ? ft.status : "invalid",
        },
      });
    }
  }

  console.log();
  console.log(`${ok} token(s) funcionando, ${muertos} muerto(s), ${ilegibles} ilegible(s).`);
  if (APPLY && muertos > 0) {
    console.log("Los muertos quedan marcados como 'invalid' para que la app no los use.");
  }
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
