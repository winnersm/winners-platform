import { prisma } from "@winners/db";
import { requireGrant } from "@/lib/guards";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  await requireGrant("AUTOMATIONS");

  const [accounts, openAlerts] = await Promise.all([
    // Último estado conocido de cada cuenta
    prisma.$queryRaw<
      {
        accountId: string;
        accountName: string | null;
        statusLabel: string | null;
        balance: number | null;
        currency: string | null;
        checkedAt: Date;
        errorMsg: string | null;
      }[]
    >`
      SELECT DISTINCT ON ("accountId")
             "accountId", "accountName", "statusLabel", balance, currency, "checkedAt", "errorMsg"
      FROM automations.account_snapshots
      ORDER BY "accountId", "checkedAt" DESC
    `,
    prisma.billingAlert.findMany({
      where: { resolvedAt: null },
      orderBy: { alertedAt: "desc" },
      take: 50,
    }),
  ]);

  const conProblema = accounts.filter(
    (a) => a.errorMsg || (a.statusLabel && a.statusLabel !== "ACTIVE"),
  );

  return (
    <div>
      <PageHeader
        title="Billing"
        description={`${accounts.length} cuentas vigiladas · la revisión corre cada 30 minutos`}
      />

      {openAlerts.length > 0 && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">
            {openAlerts.length} alerta(s) sin resolver
          </p>
          <ul className="mt-2 space-y-1">
            {openAlerts.slice(0, 5).map((a) => (
              <li key={a.id} className="text-xs text-muted-foreground">
                <span className="font-medium">{a.accountName ?? a.accountId}</span> — {a.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Cuenta</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="text-right">Saldo</TableHead>
              <TableHead>Última revisión</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">
                  Todavía no hay datos. Aparecerán tras la primera revisión de saldo.
                </TableCell>
              </TableRow>
            )}

            {/* Primero lo que necesita atención: una lista alfabética esconde los problemas. */}
            {[...conProblema, ...accounts.filter((a) => !conProblema.includes(a))].map((a) => (
              <TableRow key={a.accountId}>
                <TableCell>
                  <p className="text-sm">{a.accountName ?? a.accountId}</p>
                  <p className="text-xs text-muted-foreground">{a.accountId}</p>
                </TableCell>
                <TableCell>
                  {a.errorMsg ? (
                    <Badge variant="destructive" className="text-xs">
                      error
                    </Badge>
                  ) : (
                    <Badge
                      variant={a.statusLabel === "ACTIVE" ? "default" : "secondary"}
                      className="text-xs"
                    >
                      {a.statusLabel ?? "?"}
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {a.balance !== null ? `${a.balance.toFixed(2)} ${a.currency ?? ""}` : "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(a.checkedAt).toLocaleString("es-CO", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
