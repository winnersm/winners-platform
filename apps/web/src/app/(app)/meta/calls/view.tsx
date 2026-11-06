"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErrorDetails, errorInfoOf, type ErrorInfo } from "@/components/error-details";
import { META_CALL_LOG_DAYS, META_CALL_LOG_MAX_PER_HOUR, explainEndpoint, sourceLabel } from "@/lib/meta-calls-explain";
import type { CallRow, MetaCallsReport } from "@/lib/meta-calls";
import { CallLog } from "./call-log";

// Cifras exactas: aquí 1.284 y 1.310 no deben verse iguales.
const fmtInt = (n: number) => n.toLocaleString("es-CO");

const dayLabel = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString("es-CO", { day: "numeric", month: "short" });

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warning" | "danger" }) {
  const Icon = tone === "warning" ? ShieldAlert : tone === "danger" ? AlertTriangle : null;
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon className={`h-3.5 w-3.5 ${tone === "warning" ? "text-warning" : "text-destructive"}`} />}
        {label}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Bars({ title, items, selected, onSelect }: {
  title: string;
  items: Array<{ key: string; tip: string; value: number; tick?: string }>;
  selected?: string;
  onSelect?: (key: string) => void;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-sm font-medium">{title}</p>
      <div className="mt-8 flex h-28 items-end gap-0.5 border-b">
        {items.map((i) => {
          const dim = selected !== undefined && i.key !== selected;
          return (
            <button
              key={i.key} type="button" disabled={!onSelect}
              onClick={() => onSelect?.(i.key)}
              aria-label={`${i.tip}: ${fmtInt(i.value)} llamadas`}
              className="group relative flex h-full flex-1 items-end focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
            >
              <span
                className={`block w-full rounded-t-sm group-hover:bg-primary ${dim ? "bg-primary/35" : "bg-primary"}`}
                style={{ height: i.value ? `max(2px, ${(i.value / max) * 100}%)` : 0 }}
              />
              <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-popover px-1.5 py-0.5 text-[11px] text-popover-foreground opacity-0 shadow ring-1 ring-foreground/10 group-hover:opacity-100">
                {i.tip}: {fmtInt(i.value)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-1 flex gap-0.5 overflow-hidden text-[10px] text-muted-foreground">
        {items.map((i) => <span key={i.key} className="flex-1 overflow-visible whitespace-nowrap">{i.tick ?? ""}</span>)}
      </div>
    </div>
  );
}

function Ranking({ title, rows, total, name }: {
  title: string; rows: CallRow[]; total: number; name: (r: CallRow) => string;
}) {
  return (
    <div className="rounded-lg border bg-card">
      <p className="px-4 pt-3 pb-2 text-sm font-medium">{title}</p>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-8 pl-4 text-[11px]">Nombre</TableHead>
            <TableHead className="h-8 text-right text-[11px]">Llamadas</TableHead>
            <TableHead className="h-8 text-right text-[11px]">% del día</TableHead>
            <TableHead className="h-8 text-right text-[11px]">Errores</TableHead>
            <TableHead className="h-8 pr-4 text-right text-[11px]">Limitadas</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key}>
              <TableCell className="max-w-[320px] truncate py-1.5 pl-4 text-xs" title={name(r)}>{name(r)}</TableCell>
              <TableCell className="py-1.5 text-right text-xs font-medium tabular-nums">{fmtInt(r.total)}</TableCell>
              <TableCell className="py-1.5 text-right text-xs tabular-nums text-muted-foreground">{total ? ((r.total / total) * 100).toFixed(1) : "0.0"}%</TableCell>
              <TableCell className="py-1.5 text-right text-xs tabular-nums">{r.errors ? fmtInt(r.errors) : "—"}</TableCell>
              <TableCell className="py-1.5 pr-4 text-right text-xs tabular-nums">{r.limited ? fmtInt(r.limited) : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export default function CallsView() {
  const [date, setDate] = useState<string | null>(null);
  const [report, setReport] = useState<MetaCallsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [accounts, setAccounts] = useState<Record<string, string>>({});
  const [hour, setHour] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async (d: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/meta/calls${d ? `?date=${d}` : ""}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(errorInfoOf(json) ?? { title: json.error ?? "No se pudo cargar el reporte" }); return; }
      setReport(json);
      setRefreshKey((k) => k + 1);
    } catch {
      setError({ kind: "network", title: "No se pudo conectar con el servidor", action: "Revisa tu conexión e inténtalo de nuevo." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial y al cambiar de día
    void load(date);
  }, [date, load]);

  useEffect(() => {
    fetch("/api/meta/accounts")
      .then((r) => r.json())
      .then((j: { accounts?: Array<{ id: string; name: string }> }) => {
        setAccounts(Object.fromEntries((j.accounts ?? []).map((a) => [a.id.replace("act_", ""), a.name])));
      })
      .catch(() => { });
  }, []);

  const peak = report ? Math.max(...report.hours) : 0;
  const peakHour = report ? report.hours.indexOf(peak) : 0;
  // Sin elegir hora se abre la última con llamadas: lo normal es querer ver lo más reciente.
  const lastHour = report ? report.hours.findLastIndex((v) => v > 0) : -1;
  const activeHour = hour ?? (lastHour >= 0 ? lastHour : null);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Llamadas a Meta"
        description="Cuántas llamadas hace la plataforma a Meta cada día y de dónde salen. Consultar este reporte no gasta cuota."
        actions={
          <Button variant="outline" size="sm" onClick={() => load(date)} disabled={loading}>
            <RefreshCw className={`mr-1 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Actualizar
          </Button>
        }
      />

      {error && <ErrorDetails info={error} />}

      {!report ? (
        !error && <Skeleton className="h-64 rounded-lg" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={`Llamadas · ${dayLabel(report.date)}`} value={fmtInt(report.total)} />
            <Stat label="Hora pico" value={peak ? `${peakHour}:00` : "—"} hint={peak ? `${fmtInt(peak)} llamadas · hora Colombia` : undefined} />
            <Stat label="Con error" value={fmtInt(report.errors)} tone={report.errors ? "danger" : undefined} />
            <Stat label="Limitadas por Meta" value={fmtInt(report.limited)} tone={report.limited ? "warning" : undefined} />
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Bars
              title="Últimos 14 días · elige un día"
              selected={report.date}
              onSelect={(d) => { setDate(d); setHour(null); }}
              items={report.days.map((d, i) => ({ key: d.date, tip: dayLabel(d.date), value: d.total, tick: i % 3 === 1 ? dayLabel(d.date) : undefined }))}
            />
            <Bars
              title="Por hora (Colombia) · elige una hora"
              selected={activeHour === null ? undefined : String(activeHour)}
              onSelect={(h) => setHour(Number(h))}
              items={report.hours.map((v, h) => ({ key: String(h), tip: `${h}:00`, value: v, tick: h % 6 === 0 ? `${h}:00` : undefined }))}
            />
          </div>

          {activeHour !== null && <CallLog date={report.date} hour={activeHour} refreshKey={refreshKey} accounts={accounts} />}

          {report.total === 0 ? (
            <p className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
              No hay llamadas registradas este día.
            </p>
          ) : (
            <>
              <Ranking
                title="Dónde se van las llamadas"
                rows={report.top} total={report.total}
                name={(r) => { const t = r as (typeof report.top)[number]; return `${sourceLabel(t.source)} · ${explainEndpoint(t.endpoint)} (${t.endpoint})`; }}
              />
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                <Ranking title="Por origen" rows={report.bySource} total={report.total} name={(r) => sourceLabel(r.key)} />
                <Ranking title="Por cuenta" rows={report.byAccount} total={report.total} name={(r) => accounts[r.key] ? `${accounts[r.key]} · ${r.key}` : r.key} />
              </div>
              {report.byRoute.length > 0 && (
                <Ranking title="Por ruta (de dónde sale la llamada)" rows={report.byRoute} total={report.total} name={(r) => r.key} />
              )}
              <Ranking title="Por tipo de llamada" rows={report.byEndpoint} total={report.total} name={(r) => `${explainEndpoint(r.key)} (${r.key})`} />
            </>
          )}

          <p className="text-xs text-muted-foreground">
            Cada intento cuenta como una llamada, incluidos los reintentos; un batch cuenta como una.
            Los totales se conservan 90 días; el detalle llamada a llamada, {META_CALL_LOG_DAYS} días y hasta {fmtInt(META_CALL_LOG_MAX_PER_HOUR)} llamadas por hora.
          </p>
        </>
      )}
    </div>
  );
}
