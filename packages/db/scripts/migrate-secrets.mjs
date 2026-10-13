/**
 * Traslada la tabla `config` de automations-hub a core.Secret y core.Setting.
 *
 * Los valores marcados como secretos estaban en TEXTO PLANO. Aquí se cifran
 * con AES-256-GCM y la clave maestra, en el mismo formato que usa la app
 * (iv + authTag + ciphertext, en base64), para que ambas los lean igual.
 *
 * No es "arrastrar el problema": es justo lo contrario. Aun así conviene
 * rotarlos después, porque han estado legibles en la base durante meses.
 *
 * Uso:
 *   DATABASE_URL=... ENCRYPTION_KEY=<hex 64> node scripts/migrate-secrets.mjs [--apply]
 */

import { createCipheriv, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const APPLY = process.argv.includes("--apply");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function encrypt(plaintext) {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY debe ser un hex de 64 caracteres");
  }
  const key = Buffer.from(hex, "hex");
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

/** Últimos 4 caracteres, para reconocer un secreto en la interfaz sin descifrarlo. */
function hint(valor) {
  return valor.length > 4 ? valor.slice(-4) : "····";
}

const SECCIONES = {
  fb_tokens: "meta",
  affiliates: "affiliates",
  sheets: "google",
  slack: "slack",
  accounts: "meta",
  google: "google",
  controller: "meta",
  schedule: "schedule",
};

async function main() {
  console.log(APPLY ? "=== APLICANDO ===" : "=== SIMULACIÓN (usa --apply) ===");
  console.log();

  const filas = await prisma.$queryRaw`
    SELECT key, value, label, section, is_secret
    FROM legacy_automations.config
    WHERE value <> ''
  `;

  let secretos = 0;
  let ajustes = 0;

  for (const f of filas) {
    const seccion = SECCIONES[f.section] ?? f.section ?? "general";

    if (f.is_secret) {
      console.log(`  🔒 ${f.key.padEnd(34)} → core.Secret (${seccion}) ····${hint(f.value)}`);
      if (APPLY) {
        await prisma.secret.upsert({
          where: { key: f.key },
          create: {
            key: f.key,
            label: f.label ?? f.key,
            section: seccion,
            ciphertext: encrypt(f.value),
            hint: hint(f.value),
          },
          update: { ciphertext: encrypt(f.value), hint: hint(f.value), section: seccion },
        });
      }
      secretos++;
    } else {
      console.log(`  ⚙️  ${f.key.padEnd(34)} → core.Setting (${seccion})`);
      if (APPLY) {
        await prisma.setting.upsert({
          where: { key: f.key },
          create: { key: f.key, value: f.value, label: f.label, section: seccion },
          update: { value: f.value, label: f.label, section: seccion },
        });
      }
      ajustes++;
    }
  }

  console.log();
  console.log(`${secretos} secretos cifrados, ${ajustes} ajustes.`);
  if (APPLY) {
    console.log();
    console.log("Estaban en texto plano en la base. Conviene rotarlos cuando puedas.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
