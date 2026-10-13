// Script de datos post-migración multi-operación (idempotente).
// Se corre UNA vez en prod tras `prisma migrate deploy`:
//   docker compose cp scripts/deploy-operations.js app:/app/deploy-operations.js
//   docker compose exec -T -w /app app node deploy-operations.js
//
// Crea las 2 operaciones, asigna todo lo existente a JV Liminal y da ambas
// operaciones a los usuarios que aún no tengan ninguna. Re-ejecutable sin daño.
const { Client } = require("pg");

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  console.log("Conectado a la base de datos");

  async function upsertOp(name, slug) {
    const r = await c.query(
      `INSERT INTO "Operation" (id, name, slug, "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, now())
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name, slug]
    );
    return r.rows[0].id;
  }

  const liminal = await upsertOp("JV Liminal", "jv-liminal");
  const winners = await upsertOp("Winners Mastermind", "winners-mastermind");
  console.log("Operaciones listas:", { liminal, winners });

  // Backfill: todo lo que no tenga operación asignada → JV Liminal.
  for (const table of ["BusinessManager", "Fanpage", "FanpageToken", "Launch", "LaunchSheet"]) {
    const r = await c.query(`UPDATE "${table}" SET "operationId" = $1 WHERE "operationId" IS NULL`, [liminal]);
    console.log(`  ${table}: ${r.rowCount} filas → JV Liminal`);
  }

  // Usuarios sin operaciones → ambas (no pisa a los que ya tengan asignación).
  const u = await c.query(
    `UPDATE "User" SET operations = $1 WHERE operations IS NULL OR cardinality(operations) = 0`,
    [[liminal, winners]]
  );
  console.log(`  User: ${u.rowCount} usuarios → ambas operaciones`);

  await c.end();
  console.log("✅ Datos de operaciones listos");
})().catch((e) => {
  console.error("❌ Error:", e);
  process.exit(1);
});
