import { prisma } from "@winners/db";
import { requireGrant } from "@/lib/guards";
import { PageHeader } from "@/components/page-header";
import { UsersTable } from "./users-table";
import { CreateUserDialog } from "./create-user-dialog";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const actor = await requireGrant("ADMIN", "READ");

  const [users, operations] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ status: "asc" }, { email: "asc" }],
      include: {
        grants: true,
        memberships: { select: { operationId: true } },
      },
    }),
    prisma.operation.findMany({ orderBy: { name: "asc" } }),
  ]);

  const canEdit = actor.role === "OWNER";

  return (
    <div>
      <PageHeader
        title="Usuarios"
        description="Una sola alta y una sola baja para todas las secciones de la plataforma"
        actions={canEdit ? <CreateUserDialog /> : undefined}
      />

      <UsersTable
        canEdit={canEdit}
        currentUserId={actor.id}
        operations={operations.map((o) => ({ id: o.id, name: o.name }))}
        users={users.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          status: u.status,
          mustChangePassword: u.mustChangePassword,
          lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
          grants: u.grants.map((g) => ({ module: g.module, level: g.level, scopes: g.scopes })),
          operations: u.memberships.map((m) => m.operationId),
        }))}
      />
    </div>
  );
}
