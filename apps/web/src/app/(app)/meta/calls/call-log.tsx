"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorDetails, errorInfoOf, type ErrorInfo } from "@/components/error-details";
import { sourceLabel } from "@/lib/meta-calls-explain";
import type { MetaCallLogPage } from "@/lib/meta-calls";

type Call = MetaCallLogPage["items"][number];

const ALL = "all";
const OUTCOMES = [
  { value: ALL, label: "Todos los resultados" },
  { value: "ok", label: "Correctas" },
  { value: "error", label: "Con error" },
  { value: "limit", label: "Limitadas por Meta" },
];

const COLUMNS = "md:grid-cols-[16px_96px_minmax(0,1.3fr)_minmax(0,1.2fr)_minmax(0,0.7fr)_100px_64px]";

const timeFmt = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", second: "2-digit",
  fractionalSecondDigits: 3, hourCycle: "h23",
});

const fmtInt = (n: number) => n.toLocaleString("es-CO");
const fmtMs = (ms?: number) => (ms === undefined ? "—" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function Outcome({ call }: { call: Call }) {
  if (call.res === "ok") return <Badge variant="secondary">Correcta</Badge>;
  const code = call.code ? ` · ${call.code}` : "";
  return <Badge variant={call.res === "limit" ? "outline" : "destructive"}>{call.res === "limit" ? "Limitada" : "Error"}{code}</Badge>;
}

function Fact({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="grid gap-0.5 sm:grid-cols-[120px_1fr] sm:gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all font-mono">{value}</dd>
    </div>
  );
}

function CallItem({ call, accounts }: { call: Call; accounts: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const Icon = open ? ChevronDown : ChevronRight;
  const account = call.acct ? accounts[call.acct] ?? call.acct : "";
  const params = Object.entries(call.q ?? {}).filter(([k]) => k !== "fields").map(([k, v]) => `${k}=${v}`).join("  ");
  const batch = call.batch && `${call.batch.n} llamadas: ${call.batch.items.join(" · ")}${call.batch.n > call.batch.items.length ? " …" : ""}`;
  return (
    <li className="border-t first:border-t-0">
      <button
        type="button" aria-expanded={open} onClick={() => setOpen(!open)}
        className={`grid w-full grid-cols-[16px_1fr_auto] items-start gap-x-2 gap-y-1 px-4 py-2 text-left text-xs hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${COLUMNS}`}
      >
        <Icon className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono tabular-nums">{timeFmt.format(call.t)}</span>
        <span className="justify-self-end md:hidden"><Outcome call={call} /></span>
        <span className="col-span-2 col-start-2 min-w-0 md:col-span-1 md:col-start-auto">
          <span className="block font-medium">{call.what}</span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground" title={call.ep}>{call.ep}</span>
        </span>
        <span className="col-span-2 col-start-2 min-w-0 md:col-span-1 md:col-start-auto">
          <span className="block truncate" title={sourceLabel(call.src)}>{sourceLabel(call.src)}</span>
          <span className="block truncate font-mono text-[11px] text-muted-foreground" title={call.route}>{call.route ?? "Sin ruta registrada"}</span>
        </span>
        <span className="col-span-2 col-start-2 truncate text-muted-foreground md:col-span-1 md:col-start-auto" title={account}>{account || "—"}</span>
        <span className="hidden md:block"><Outcome call={call} /></span>
        <span className="hidden text-right tabular-nums text-muted-foreground md:block">{fmtMs(call.ms)}</span>
      </button>
      {open && (
        <dl className="space-y-1 bg-muted/30 px-4 py-2 text-[11px] md:pl-[34px]">
          <Fact label="Ruta en Meta" value={call.path || "/ (batch)"} />
          <Fact label="Pantalla" value={call.page} />
          <Fact label="Campos pedidos" value={call.q?.fields} />
          <Fact label="Parámetros" value={params} />
          <Fact label="Campos enviados" value={call.body?.join(", ")} />
          <Fact label="Estado enviado" value={call.status} />
          <Fact label="Lote" value={batch} />
          <Fact label="Respuesta" value={[call.http && `HTTP ${call.http}`, call.code && `código ${call.code}`, fmtMs(call.ms)].filter(Boolean).join(" · ")} />
        </dl>
      )}
    </li>
  );
}

export function CallLog({ date, hour, refreshKey, accounts }: {
  date: string; hour: number; refreshKey: number; accounts: Record<string, string>;
}) {
  const [source, setSource] = useState(ALL);
  const [outcome, setOutcome] = useState(ALL);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState<MetaCallLogPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorInfo | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  async function load(offset: number, isStale: () => boolean = () => false) {
    const params = new URLSearchParams({ date, hour: String(hour), offset: String(offset) });
    if (source !== ALL) params.set("source", source);
    if (outcome !== ALL) params.set("outcome", outcome);
    if (q) params.set("q", q);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/meta/calls/log?${params}`);
      const json = await res.json().catch(() => ({}));
      if (isStale()) return;
      if (!res.ok) { setError(errorInfoOf(json) ?? { title: json.error ?? "No se pudo cargar el detalle" }); return; }
      const next = json as MetaCallLogPage;
      setPage((prev) => (offset && prev ? { ...next, items: [...prev.items, ...next.items] } : next));
    } catch {
      if (!isStale()) setError({ kind: "network", title: "No se pudo conectar con el servidor", action: "Revisa tu conexión e inténtalo de nuevo." });
    } finally {
      if (!isStale()) setLoading(false);
    }
  }

  useEffect(() => {
    let stale = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga al cambiar la hora o un filtro
    void load(0, () => stale);
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load depende justo de estos valores
  }, [date, hour, source, outcome, q, refreshKey]);

  const missing = page ? Math.max(page.total - page.stored, 0) : 0;

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3 pb-2">
        <div className="mr-auto min-w-0">
          <p className="text-sm font-medium">Llamada por llamada · {hour}:00 a {hour}:59 (Colombia)</p>
          <p className="text-xs text-muted-foreground">
            Elige otra hora en la gráfica «Por hora». {page ? `${fmtInt(page.matched)} de ${fmtInt(page.stored)} llamadas con detalle.` : ""}
          </p>
        </div>
        <div className="relative w-full sm:w-52">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar ruta, cuenta, llamada…" aria-label="Buscar en el detalle" className="h-8 pl-8 text-xs" />
        </div>
        <Select value={source} onValueChange={(v) => v && setSource(v)}>
          <SelectTrigger className="h-8 w-full bg-card text-xs sm:w-52" aria-label="Filtrar por origen">
            <SelectValue>{source === ALL ? "Todos los orígenes" : sourceLabel(source)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">Todos los orígenes</SelectItem>
            {(page?.sources ?? []).map((s) => <SelectItem key={s} value={s} className="text-xs">{sourceLabel(s)}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={outcome} onValueChange={(v) => v && setOutcome(v)}>
          <SelectTrigger className="h-8 w-full bg-card text-xs sm:w-44" aria-label="Filtrar por resultado">
            <SelectValue>{OUTCOMES.find((o) => o.value === outcome)?.label}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {OUTCOMES.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {error && <div className="px-4 pb-3"><ErrorDetails info={error} /></div>}
      {missing > 0 && (
        <p className="px-4 pb-2 text-xs text-muted-foreground">
          {fmtInt(missing)} llamadas de esta hora no tienen detalle: se hicieron antes de activarlo, ya caducaron o se pasaron del tope por hora.
        </p>
      )}

      <div className={`hidden gap-x-2 border-t px-4 py-1.5 text-[11px] font-medium text-muted-foreground md:grid ${COLUMNS}`}>
        <span /><span>Hora exacta</span><span>Qué hace</span><span>De dónde viene</span><span>Cuenta</span><span>Resultado</span><span className="text-right">Duración</span>
      </div>
      {page?.items.length ? (
        <ul className="border-t">
          {page.items.map((c, i) => <CallItem key={`${c.t}-${i}`} call={c} accounts={accounts} />)}
        </ul>
      ) : (
        !loading && <p className="border-t p-6 text-center text-sm text-muted-foreground">Sin llamadas con detalle para esta selección.</p>
      )}

      {(loading || page?.hasMore) && (
        <div className="flex justify-center border-t p-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : (
            <Button variant="ghost" size="sm" onClick={() => load(page?.items.length ?? 0)}>Cargar más</Button>
          )}
        </div>
      )}
    </div>
  );
}
