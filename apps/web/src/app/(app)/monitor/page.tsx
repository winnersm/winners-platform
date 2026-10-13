import { prisma } from "@winners/db";
import { requireGrant } from "@/lib/guards";
import { PageHeader } from "@/components/page-header";
import { MonitorList } from "./monitor-list";

export const dynamic = "force-dynamic";

export default async function MonitorPage() {
  const user = await requireGrant("MONITOR");
  const canEdit =
    user.role === "OWNER" || user.grants.some((g) => g.module === "MONITOR" && g.level !== "READ");

  const [links, incidentes, uptime, ajusteIntervalo] = await Promise.all([
    prisma.monitoredLink.findMany({
      orderBy: [{ enabled: "desc" }, { status: "asc" }, { name: "asc" }],
    }),
    prisma.monitorIncident.findMany({
      orderBy: { openedAt: "desc" },
      take: 30,
      include: { link: { select: { name: true } } },
    }),
    // Uptime de los últimos 30 días. Es justo la pregunta que hoy no se puede
    // responder: los ficheros solo guardaban el estado del momento.
    prisma.$queryRaw<{ linkId: string; total: bigint; ok: bigint }[]>`
      SELECT "linkId",
             count(*) AS total,
             count(*) FILTER (WHERE status = 'OK') AS ok
      FROM monitor."MonitorCheck"
      WHERE "checkedAt" > now() - interval '30 days'
      GROUP BY "linkId"
    `,
    prisma.setting.findUnique({ where: { key: "monitor.interval_minutes" } }),
  ]);

  const uptimePorLink = new Map(
    uptime.map((u) => [
      u.linkId,
      Number(u.total) > 0 ? (Number(u.ok) / Number(u.total)) * 100 : null,
    ]),
  );

  const vigilados = links.filter((l) => l.enabled);
  const caidos = vigilados.filter((l) => l.status === "FAIL");

  return (
    <div>
      <PageHeader
        title="Monitor de tracking links"
        description={
          caidos.length > 0
            ? `${caidos.length} de ${vigilados.length} links caídos ahora mismo`
            : `${vigilados.length} links vigilados · todos responden`
        }
      />

      <MonitorList
        canEdit={canEdit}
        intervaloMin={Number(ajusteIntervalo?.value ?? 30)}
        links={links.map((l) => ({
          id: l.id,
          name: l.name,
          url: l.url,
          expectedUrl: l.expectedUrl,
          expectedText: l.expectedText,
          expectRedirect: l.expectRedirect,
          maxResponseMs: l.maxResponseMs,
          enabled: l.enabled,
          status: l.status,
          lastCheckAt: l.lastCheckAt?.toISOString() ?? null,
          consecutiveFails: l.consecutiveFails,
          uptime: uptimePorLink.get(l.id) ?? null,
        }))}
        incidents={incidentes.map((i) => ({
          id: i.id,
          linkName: i.link.name,
          openedAt: i.openedAt.toISOString(),
          closedAt: i.closedAt?.toISOString() ?? null,
          reason: i.reason,
        }))}
      />
    </div>
  );
}
