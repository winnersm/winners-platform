/**
 * Traslada el SQLite local de opwinners (`datos.db`) al schema `cloner`.
 *
 * Lo que había allí:
 *   - tokens      → cloner.CloneToken, ahora CIFRADOS (estaban en texto plano
 *                   en un fichero del escritorio, sin permisos de nadie)
 *   - plantillas  → cloner.CloneTemplate (estructura a jsonb)
 *   - copias      → cloner.CloneRun (el historial)
 *   - cache       → cloner.CloneCache (el catálogo de idiomas de Meta)
 *
 * Se apoya en `sqlite3` de la línea de comandos en vez de en una librería:
 * es una migración de una sola vez y no merece añadir una dependencia al
 * monorepo para siempre.
 *
 * Uso:
 *   DATABASE_URL=... ENCRYPTION_KEY=<hex 64> \
 *     node scripts/migrate-cloner-data.mjs /ruta/a/datos.db [--apply]
 *
 * Sin --apply solo dice qué haría.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createCipheriv, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const APPLY = process.argv.includes("--apply");
const DB = process.argv.find((a) => a.endsWith(".db"));

if (!DB || !existsSync(DB)) {
  console.error("Falta la ruta al datos.db de opwinners.");
  console.error("  node scripts/migrate-cloner-data.mjs /ruta/a/datos.db [--apply]");
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function encrypt(plaintext) {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY debe ser un hex de 64 caracteres");
  }
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hex, "hex"), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  // Mismo formato que apps/web/src/lib/crypto.ts: iv + authTag + cifrado.
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

/** Lee una tabla del SQLite como array de objetos. */
function leer(tabla, columnas) {
  const salida = execFileSync(
    "sqlite3",
    ["-json", DB, `SELECT ${columnas} FROM ${tabla}`],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  ).trim();
  return salida ? JSON.parse(salida) : [];
}

function jsonSeguro(texto, porDefecto) {
  try {
    return texto ? JSON.parse(texto) : porDefecto;
  } catch {
    return porDefecto;
  }
}

async function main() {
  console.log(`Leyendo ${DB}${APPLY ? "" : "  (simulación: no se escribe nada)"}\n`);

  // ─── Tokens ────────────────────────────────────────────────────────────────
  const tokens = leer("tokens", "alias, token, usuario, usuario_id, valido, error, creado");
  console.log(`Tokens: ${tokens.length}`);
  for (const t of tokens) {
    console.log(`  ${t.alias} — ${t.usuario ?? "sin validar"} (${t.valido ? "válido" : "no válido"})`);
    if (!APPLY) continue;
    await prisma.cloneToken.upsert({
      where: { alias: t.alias },
      create: {
        alias: t.alias,
        encryptedToken: encrypt(t.token),
        hint: t.token.slice(-6),
        userName: t.usuario || null,
        userIdMeta: t.usuario_id || null,
        valid: !!t.valido,
        error: t.error || null,
        createdAt: t.creado ? new Date(t.creado) : new Date(),
      },
      update: {
        encryptedToken: encrypt(t.token),
        hint: t.token.slice(-6),
        userName: t.usuario || null,
        userIdMeta: t.usuario_id || null,
        valid: !!t.valido,
        error: t.error || null,
      },
    });
  }

  // ─── Plantillas ────────────────────────────────────────────────────────────
  const plantillas = leer(
    "plantillas",
    "nombre, creada, origen_campana, origen_cuenta, nota, estructura",
  );
  console.log(`\nPlantillas: ${plantillas.length}`);
  for (const p of plantillas) {
    const est = jsonSeguro(p.estructura, null);
    if (!est) {
      console.log(`  ✗ ${p.nombre}: la estructura no es JSON válido, se omite`);
      continue;
    }
    const ads = (est.ads ?? []).length;
    const adsets = (est.adsets ?? []).length;
    console.log(
      `  ${p.nombre} — ${adsets} adset(s), ${ads} anuncio(s), ` +
        `${(p.estructura.length / 1024).toFixed(0)} KB`,
    );
    if (!APPLY) continue;
    await prisma.cloneTemplate.upsert({
      where: { name: p.nombre },
      create: {
        name: p.nombre,
        note: p.nota ?? "",
        sourceCampaignId: p.origen_campana ?? "",
        sourceAccountId: p.origen_cuenta ?? "",
        structure: est,
        createdAt: p.creada ? new Date(p.creada) : new Date(),
      },
      update: {
        note: p.nota ?? "",
        sourceCampaignId: p.origen_campana ?? "",
        sourceAccountId: p.origen_cuenta ?? "",
        structure: est,
      },
    });
  }

  // ─── Historial ─────────────────────────────────────────────────────────────
  // Se borra y se reinserta: CloneRun no tiene clave natural, así que correr el
  // script dos veces duplicaría el historial entero.
  const copias = leer(
    "copias",
    "fecha, campana_origen, nombre_origen, cuenta_origen, cuenta_destino, " +
      "nombre_destino, campana_destino, adsets, ads, copias_pedidas, incidencias, detalle",
  );
  console.log(`\nHistorial: ${copias.length} copia(s)`);
  if (APPLY) {
    const existentes = await prisma.cloneRun.count();
    if (existentes) {
      console.log(`  (borrando ${existentes} fila(s) previa(s) para no duplicar)`);
      await prisma.cloneRun.deleteMany({});
    }
    await prisma.cloneRun.createMany({
      data: copias.map((c) => ({
        sourceCampaign: c.campana_origen ?? "",
        sourceName: c.nombre_origen ?? "",
        sourceAccount: c.cuenta_origen ?? "",
        targetAccount: c.cuenta_destino ?? "",
        targetName: c.nombre_destino ?? "",
        targetCampaign: c.campana_destino ?? "",
        adsets: c.adsets ?? 0,
        ads: c.ads ?? 0,
        requestedCopies: c.copias_pedidas ?? 1,
        issues: jsonSeguro(c.incidencias, []),
        detail: jsonSeguro(c.detalle, {}),
        createdAt: c.fecha ? new Date(c.fecha) : new Date(),
      })),
    });
  }

  // ─── Caché de idiomas ──────────────────────────────────────────────────────
  const cache = leer("cache", "clave, valor");
  console.log(`\nCaché: ${cache.length} entrada(s)`);
  for (const c of cache) {
    const valor = jsonSeguro(c.valor, null);
    if (!valor) continue;
    const n = Object.keys(valor).length;
    console.log(`  ${c.clave} — ${n} entrada(s)`);
    if (!APPLY) continue;
    await prisma.cloneCache.upsert({
      where: { key: c.clave },
      create: { key: c.clave, value: valor },
      update: { value: valor },
    });
  }

  // ─── Comprobación ──────────────────────────────────────────────────────────
  if (APPLY) {
    const [nTokens, nPlantillas, nCopias] = await Promise.all([
      prisma.cloneToken.count(),
      prisma.cloneTemplate.count(),
      prisma.cloneRun.count(),
    ]);
    console.log("\nEn la base tras migrar:");
    console.log(`  tokens      ${nTokens} / ${tokens.length}`);
    console.log(`  plantillas  ${nPlantillas} / ${plantillas.length}`);
    console.log(`  historial   ${nCopias} / ${copias.length}`);
    if (nTokens < tokens.length || nPlantillas < plantillas.length || nCopias < copias.length) {
      console.error("\nFaltan filas. Revisa los mensajes de arriba antes de dar por buena la migración.");
      process.exitCode = 1;
    }
  } else {
    console.log("\nNada escrito. Vuelve a lanzarlo con --apply cuando lo veas bien.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
