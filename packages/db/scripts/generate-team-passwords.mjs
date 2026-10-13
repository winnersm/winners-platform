import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

// Contraseña legible pero no adivinable. Se cambia en el primer acceso.
const ALFABETO = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generar() {
  const bytes = randomBytes(12);
  return "Winners." + Array.from(bytes, (b) => ALFABETO[b % ALFABETO.length]).join("");
}

const usuarios = await prisma.user.findMany({
  where: { status: "ACTIVE", email: { not: "victor@winnersmastermind.com" } },
  orderBy: { email: "asc" },
});

const filas = [];
for (const u of usuarios) {
  const pw = generar();
  await prisma.user.update({
    where: { id: u.id },
    // Obligado a cambiarla al entrar: la que se reparte la ve quien la reparte.
    data: { passwordHash: await bcrypt.hash(pw, 12), mustChangePassword: true },
  });
  filas.push({ nombre: u.name ?? "", email: u.email, rol: u.role, pw });
}

console.log();
console.log("  " + "PERSONA".padEnd(10) + "CORREO".padEnd(32) + "ROL".padEnd(10) + "CONTRASEÑA");
console.log("  " + "─".repeat(74));
for (const f of filas) {
  console.log("  " + f.nombre.padEnd(10) + f.email.padEnd(32) + f.rol.padEnd(10) + f.pw);
}
console.log();
console.log(`  ${filas.length} contraseñas generadas. Todos deben cambiarla al entrar.`);
await prisma.$disconnect();
