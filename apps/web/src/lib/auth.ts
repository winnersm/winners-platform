import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import { z } from "zod";
import { prisma } from "@winners/db";
import type { Grant, Level, Module, Role } from "@winners/auth";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Sesión con JWT (sin tabla de sesiones). Los permisos viajan dentro del token
 * para no consultar la base en cada render.
 *
 * Contrapartida: un cambio de permisos no surte efecto hasta que el token se
 * refresca. Por eso dura 8 horas y no días — quitarle el acceso a alguien no
 * puede tardar una semana en aplicarse. Para bajas inmediatas está
 * `status: SUSPENDED`, que se comprueba en cada refresco.
 */
const TOKEN_MAX_AGE = 8 * 60 * 60;

async function loadPrincipal(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      grants: true,
      memberships: { select: { operationId: true } },
    },
  });
  if (!user || user.status !== "ACTIVE") return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as Role,
    mustChangePassword: user.mustChangePassword,
    grants: user.grants.map((g) => ({
      module: g.module as Module,
      level: g.level as Level,
      scopes: g.scopes,
    })) satisfies Grant[],
    operations: user.memberships.map((m) => m.operationId),
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: TOKEN_MAX_AGE },
  pages: { signIn: "/login" },

  callbacks: {
    async jwt({ token, user, trigger }) {
      // Login inicial
      if (user) {
        const p = await loadPrincipal(user.id as string);
        if (!p) return {};
        Object.assign(token, p);
        return token;
      }

      // Refresco: se relee de la base, para que suspender a alguien o cambiarle
      // los permisos surta efecto sin esperar a que caduque el token.
      if (trigger === "update" || !token.role) {
        const p = token.id ? await loadPrincipal(token.id as string) : null;
        if (!p) return {}; // borrado o suspendido -> sesión inválida
        Object.assign(token, p);
      }

      return token;
    },

    async session({ session, token }) {
      if (!token.id) return session;
      session.user.id = token.id as string;
      session.user.role = token.role as Role;
      session.user.grants = (token.grants as Grant[]) ?? [];
      session.user.operations = (token.operations as string[]) ?? [];
      session.user.mustChangePassword = Boolean(token.mustChangePassword);
      return session;
    },
  },

  providers: [
    Credentials({
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email.toLowerCase().trim() },
        });

        // Se compara igualmente contra un hash falso cuando el usuario no
        // existe: de lo contrario el tiempo de respuesta delataría qué correos
        // están dados de alta.
        const hash =
          user?.passwordHash ??
          "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
        const valid = await compare(parsed.data.password, hash);

        if (!user || !valid || user.status !== "ACTIVE") return null;

        await prisma.user.update({
          where: { id: user.id },
          data: { lastLoginAt: new Date() },
        });

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
});
