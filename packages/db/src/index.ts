import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Falta DATABASE_URL");
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

// En desarrollo Next recarga los módulos en caliente; sin este singleton se
// abriría una conexión nueva en cada recarga hasta agotar el pool.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function client(): PrismaClient {
  return (globalForPrisma.prisma ??= createPrismaClient());
}

/**
 * El cliente se crea en el PRIMER USO, no al importar el módulo.
 *
 * Importa porque Next inspecciona las rutas durante el build, y ahí no hay
 * DATABASE_URL: si el cliente se construyera al importar, el build fallaría
 * sin que nadie haya hecho todavía una sola consulta.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_t, prop, receiver) {
    return Reflect.get(client(), prop, receiver);
  },
  has(_t, prop) {
    return prop in client();
  },
});

export * from "@prisma/client";
