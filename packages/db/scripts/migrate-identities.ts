/**
 * Migración de identidades: newappmeta + link-monitor → core.
 *
 * Unifica las listas de usuarios que hoy están repartidas, conservando los
 * hashes de contraseña (todos son bcrypt, compatibles entre sí) y el permiso
 * fino por sección que ya existía.
 *
 * Es idempotente: se puede correr varias veces sin duplicar nada.
 *
 * Uso:
 *   DATABASE_URL=... SOURCE=/ruta/identidades.json node --experimental-strip-types \
 *     scripts/migrate-identities.ts [--apply]
 *
 * Sin --apply solo muestra lo que haría. Nada se escribe.
 */

import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const APPLY = process.argv.includes("--apply");
const SOURCE = process.env.SOURCE ?? "identidades.json";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

// ─── Decisiones de mapeo ────────────────────────────────────────────────────

/**
 * Dominio canónico. Victor aparece con dos (@grupowinners.com en newappmeta,
 * @winnersmastermind.com en link-monitor y dash); sin unificar, la misma persona
 * quedaría como dos usuarios distintos.
 */
const CANONICAL_DOMAIN = "winnersmastermind.com";

/**
 * Quién es dueño. No se deduce del rol ADMIN de newappmeta a propósito: allí
 * también es ADMIN un dev externo, y OWNER da acceso a secretos y a la gestión
 * de usuarios. Se nombra explícitamente.
 */
const OWNERS = new Set(["victor", "daniel"]);

/** Las secciones de newappmeta son todas del módulo META. */
const META_SECTIONS = new Set([
  "dashboard",
  "accounts",
  "campaigns",
  "fanpages",
  "launches",
  "jobs",
]);

interface SourceUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  passwordHash: string;
  sections: string[];
  operations: string[];
}

interface Source {
  operations: { id: string; name: string; slug: string }[];
  newappmeta: SourceUser[];
  monitorEmails: string[];
}

function canonicalEmail(email: string): string {
  const [local] = email.toLowerCase().trim().split("@");
  return `${local}@${CANONICAL_DOMAIN}`;
}

function localPart(email: string): string {
  return email.toLowerCase().split("@")[0];
}

async function main() {
  const src: Source = JSON.parse(readFileSync(SOURCE, "utf8"));

  console.log(APPLY ? "=== APLICANDO ===" : "=== SIMULACIÓN (usa --apply para escribir) ===");
  console.log();

  // ── Operaciones ───────────────────────────────────────────────────────────
  console.log("Operaciones:");
  for (const op of src.operations) {
    console.log(`  ${op.name} (${op.slug})`);
    if (APPLY) {
      await prisma.operation.upsert({
        where: { id: op.id },
        create: { id: op.id, name: op.name, slug: op.slug },
        update: { name: op.name, slug: op.slug },
      });
    }
  }
  console.log();

  // ── Usuarios ──────────────────────────────────────────────────────────────
  // Se indexan por la parte local del correo para detectar a la misma persona
  // aunque venga con dominios distintos.
  const byLocal = new Map<string, SourceUser>();
  for (const u of src.newappmeta) byLocal.set(localPart(u.email), u);

  const monitorOnly = src.monitorEmails
    .map(localPart)
    .filter((l) => !byLocal.has(l));

  console.log("Usuarios:");
  const warnings: string[] = [];

  for (const [local, u] of byLocal) {
    const email = canonicalEmail(u.email);
    const isOwner = OWNERS.has(local);
    const role = isOwner ? "OWNER" : u.role === "ADMIN" ? "ADMIN" : "OPERATOR";

    // Scopes: se conservan tal cual venían. Vacío en un no-dueño significaría
    // "sin ninguna sección", así que se deja explícito y se avisa.
    const scopes = u.sections.filter((s) => META_SECTIONS.has(s));
    const hasMonitor = src.monitorEmails.some((m) => localPart(m) === local);

    const grants: { module: string; level: string; scopes: string[] }[] = [];
    if (!isOwner) {
      if (scopes.length > 0) {
        grants.push({ module: "META", level: "WRITE", scopes });
      } else {
        warnings.push(
          `${email}: era ${u.role} en newappmeta pero sin secciones asignadas — se deja SIN acceso a Meta Ads. Revisar en /admin/users.`,
        );
      }
      if (hasMonitor) grants.push({ module: "MONITOR", level: "WRITE", scopes: [] });
    }

    if (email !== u.email.toLowerCase()) {
      warnings.push(`${u.email} → ${email} (correo unificado al dominio canónico)`);
    }

    const detail = isOwner
      ? "todos los módulos (dueño)"
      : grants.length
        ? grants
            .map((g) => `${g.module}:${g.level}${g.scopes.length ? `[${g.scopes.join(",")}]` : ""}`)
            .join(" ")
        : "SIN MÓDULOS";

    console.log(`  ${email.padEnd(34)} ${role.padEnd(9)} ${detail}`);

    if (APPLY) {
      const user = await prisma.user.upsert({
        where: { email },
        create: {
          email,
          name: u.name,
          passwordHash: u.passwordHash,
          role: role as never,
          // Todo el mundo estrena contraseña en el cutover: las actuales
          // vienen arrastradas de sistemas que dejan de existir.
          mustChangePassword: true,
        },
        update: { name: u.name, role: role as never },
      });

      for (const opId of u.operations) {
        await prisma.membership.upsert({
          where: { userId_operationId: { userId: user.id, operationId: opId } },
          create: { userId: user.id, operationId: opId },
          update: {},
        });
      }

      for (const g of grants) {
        await prisma.moduleGrant.upsert({
          where: { userId_module: { userId: user.id, module: g.module as never } },
          create: {
            userId: user.id,
            module: g.module as never,
            level: g.level as never,
            scopes: g.scopes,
          },
          update: { level: g.level as never, scopes: g.scopes },
        });
      }
    }
  }

  if (monitorOnly.length) {
    console.log();
    console.log("Solo en link-monitor (sin hash recuperable, hay que darles contraseña a mano):");
    for (const l of monitorOnly) console.log(`  ${l}@${CANONICAL_DOMAIN}`);
  }

  if (warnings.length) {
    console.log();
    console.log("Avisos:");
    for (const w of warnings) console.log(`  · ${w}`);
  }

  console.log();
  if (APPLY) {
    const [users, grants, memberships] = await Promise.all([
      prisma.user.count(),
      prisma.moduleGrant.count(),
      prisma.membership.count(),
    ]);
    console.log(`Resultado: ${users} usuarios, ${grants} concesiones, ${memberships} membresías.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
