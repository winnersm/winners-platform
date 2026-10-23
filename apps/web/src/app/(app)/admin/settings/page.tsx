import { prisma } from "@winners/db";
import { requireGrant } from "@/lib/guards";
import { getActiveOperationId } from "@/lib/operation";
import { SettingsTabs } from "./settings-tabs";

export default async function SettingsPage() {
  // Antes comprobaba role === "ADMIN", que era el modelo de roles anterior.
  // Con el actual, quien administra es OWNER, así que expulsaba justo a quien
  // debía entrar.
  await requireGrant("ADMIN", "READ");

  const op = (await getActiveOperationId()) ?? undefined;
  const [bms, trashed] = await Promise.all([
    prisma.businessManager.findMany({
      where: { ...(op ? { operationId: op } : {}), deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, bmIdMeta: true, systemUserId: true, status: true, tokenLast4: true, updatedAt: true },
    }),
    prisma.businessManager.findMany({
      where: { ...(op ? { operationId: op } : {}), deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      select: {
        id: true, name: true, bmIdMeta: true, systemUserId: true, status: true, updatedAt: true,
        deletedAt: true, deletedByName: true, deletedReason: true,
      },
    }),
  ]);

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Ajustes</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Gestión de Business Managers, usuarios y accesos
        </p>
      </div>
      <SettingsTabs initialBMs={bms} initialTrash={trashed} />
    </div>
  );
}
