import { prisma } from "@winners/db";
import { requireGrant } from "@/lib/guards";
import { PageHeader } from "@/components/page-header";
import { TasksList } from "./tasks-list";
import { MasterSwitch } from "./master-switch";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const user = await requireGrant("AUTOMATIONS");
  const canEdit =
    user.role === "OWNER" ||
    user.grants.some((g) => g.module === "AUTOMATIONS" && g.level !== "READ");
  const isAdmin =
    user.role === "OWNER" ||
    user.grants.some((g) => g.module === "AUTOMATIONS" && g.level === "ADMIN");

  const [tasks, flag, lastRuns, accounts, pendingTriggers] = await Promise.all([
    prisma.automationTask.findMany({ orderBy: { displayName: "asc" } }),
    prisma.systemFlag.findUnique({ where: { key: "automations_enabled" } }),
    // Última ejecución de cada tarea
    prisma.$queryRaw<{ taskName: string; startedAt: Date; success: boolean | null; errorMsg: string | null }[]>`
      SELECT DISTINCT ON ("taskName") "taskName", "startedAt", success, "errorMsg"
      FROM automations.task_runs
      ORDER BY "taskName", "startedAt" DESC
    `,
    // Las cuentas que estas tareas ven de verdad: las del último chequeo de saldo.
    prisma.$queryRaw<{ accountId: string; accountName: string | null; statusLabel: string | null }[]>`
      SELECT DISTINCT ON ("accountId") "accountId", "accountName", "statusLabel"
      FROM automations.account_snapshots
      ORDER BY "accountId", "checkedAt" DESC
    `,
    prisma.taskTrigger.findMany({ where: { processed: false }, select: { taskName: true } }),
  ]);

  const runByTask = new Map(lastRuns.map((r) => [r.taskName, r]));
  const pending = new Set(pendingTriggers.map((t) => t.taskName));

  return (
    <div>
      <PageHeader
        title="Tareas automáticas"
        description="Se ejecutan solas. Pausan campañas y borran anuncios reales, así que elige bien sobre qué cuentas actúan."
        actions={
          <MasterSwitch on={flag?.value ?? true} canEdit={isAdmin} />
        }
      />

      <TasksList
        canEdit={canEdit}
        masterOn={flag?.value ?? true}
        accounts={accounts.map((a) => ({
          id: a.accountId,
          name: a.accountName ?? a.accountId,
          status: a.statusLabel,
        }))}
        tasks={tasks.map((t) => {
          const run = runByTask.get(t.name);
          return {
            name: t.name,
            displayName: t.displayName,
            description: t.description,
            cron: t.cron,
            enabled: t.enabled,
            dryRun: t.dryRun,
            scopeMode: t.scopeMode,
            scopeAccounts: t.scopeAccounts,
            pending: pending.has(t.name),
            lastRun: run
              ? {
                  at: run.startedAt.toISOString(),
                  success: run.success,
                  error: run.errorMsg,
                }
              : null,
          };
        })}
      />
    </div>
  );
}
