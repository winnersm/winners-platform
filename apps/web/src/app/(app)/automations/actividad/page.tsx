import { prisma } from "@winners/db";
import { requireGrant } from "@/lib/guards";
import { PageHeader } from "@/components/page-header";
import { ActivityList } from "./activity-list";

export const dynamic = "force-dynamic";

export default async function ActividadPage() {
  await requireGrant("AUTOMATIONS");

  const [runs, tareas] = await Promise.all([
    prisma.taskRun.findMany({
      orderBy: { startedAt: "desc" },
      take: 200,
      include: { task: { select: { displayName: true } } },
    }),
    prisma.automationTask.findMany({ select: { name: true, displayName: true } }),
  ]);

  return (
    <div>
      <PageHeader
        title="Actividad"
        description="Cada ejecución de cada tarea: cuándo, cuánto tardó y qué hizo"
      />
      <ActivityList
        tareas={tareas}
        runs={runs.map((r) => ({
          id: r.id,
          taskName: r.taskName,
          displayName: r.task.displayName,
          startedAt: r.startedAt.toISOString(),
          durationS: r.durationS,
          success: r.success,
          errorMsg: r.errorMsg,
          triggeredBy: r.triggeredBy,
          dryRun: r.dryRun,
          result: r.result as Record<string, unknown> | null,
        }))}
      />
    </div>
  );
}
