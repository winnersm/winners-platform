"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Check, Copy, Eye, EyeOff, Loader2, ShieldCheck, X, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorDetails, errorInfoOf, toastApiError, type ErrorInfo } from "@/components/error-details";
import type { TokenAdAccount, TokenPage, TokenPixel, TokenReport } from "@/lib/token-validator";

interface SavedBm { id: string; name: string; bmIdMeta: string; status: string; tokenLast4: string | null }

const PASTED = "pasted";

const ACC_STATUS: Record<number, [string, "ok" | "bad" | "warn"]> = {
  1: ["Activa", "ok"], 2: ["Deshabilitada", "bad"], 3: ["Sin confirmar", "warn"], 7: ["En revisión", "warn"],
  8: ["Revisión de política", "warn"], 9: ["Pago pendiente", "warn"], 100: ["Cerrada", "bad"], 101: ["Cerrada", "bad"],
};

const TASK_LABELS: Record<string, string> = {
  ANALYZE: "Analizar", ADVERTISE: "Publicidad", MODERATE: "Moderar", CREATE_CONTENT: "Contenido",
  MANAGE: "Administrar", MESSAGING: "Mensajes", VIEW_MONETIZATION_INSIGHTS: "Monetización", DRAFT: "Borrador",
};

const TONE = {
  ok: "bg-success-soft text-success",
  bad: "bg-destructive/10 text-destructive",
  warn: "bg-warning-soft text-warning",
  info: "bg-primary/10 text-primary",
  muted: "bg-muted text-muted-foreground",
} as const;

function Pill({ tone = "muted", children }: { tone?: keyof typeof TONE; children: ReactNode }) {
  return <Badge variant="outline" className={`border-transparent ${TONE[tone]}`}>{children}</Badge>;
}

function CopyId({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="Copiar"
      className="ml-1 inline-flex align-middle text-muted-foreground hover:text-foreground"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200); });
      }}
    >
      {done ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm break-words">{children}</div>
    </div>
  );
}

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

const fmtDate = (ms: number, withTime = false) =>
  new Date(ms).toLocaleString("es-CO", withTime
    ? { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }
    : { day: "2-digit", month: "short", year: "numeric" });

function Expiry({ ts, now }: { ts?: number; now: number }) {
  if (!ts) return <Pill tone="ok">No expira</Pill>;
  const diff = ts * 1000 - now;
  const days = Math.floor(Math.abs(diff) / 86_400_000);
  const tone = diff < 0 || days < 7 ? "bad" : days < 30 ? "warn" : "ok";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {fmtDate(ts * 1000)}
      <Pill tone={tone}>{diff < 0 ? `Expiró hace ${days} d` : `Expira en ${days} d`}</Pill>
    </span>
  );
}

function LastFired({ ts, now }: { ts?: string; now: number }) {
  if (!ts) return <span className="text-muted-foreground">Nunca</span>;
  const d = (now - new Date(ts).getTime()) / 86_400_000;
  const label = d < 1 ? "Hoy" : d < 2 ? "Ayer" : `Hace ${Math.floor(d)} d`;
  const cls = d < 1 ? "text-success" : d < 7 ? "text-primary" : d < 30 ? "text-warning" : "text-muted-foreground";
  return <span className={cls} title={new Date(ts).toLocaleString("es-CO")}>{label}</span>;
}

function groupBy<T>(list: T[], key: (t: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const it of list) { const k = key(it); m.set(k, [...(m.get(k) ?? []), it]); }
  return [...m.entries()];
}

// ─── Pestañas ────────────────────────────────────────────────────────────────

function OverviewTab({ r }: { r: TokenReport }) {
  const d = r.debug;
  const activeAccounts = r.accounts.filter((a) => a.account_status === 1).length;
  const firedPixels = r.pixels.filter((p) => !p.is_unavailable && p.last_fired_time).length;
  const pagesWithFans = r.pages.filter((p) => (p.fan_count ?? 0) > 0).length;
  const bms = [...new Set(r.accounts.flatMap((a) => (a.business ? [a.business.name] : [])))];
  const typeTone = d.type === "SYSTEM_USER" ? "ok" : d.type === "USER" ? "info" : d.type === "PAGE" ? "warn" : "muted";

  return (
    <div className="space-y-4">
      <Section title="Token">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Info label="Estado"><Pill tone="ok">Válido</Pill></Info>
          <Info label="Tipo"><Pill tone={typeTone}>{d.type ?? "Desconocido"}</Pill></Info>
          <Info label="App">{d.application ?? "—"}</Info>
          <Info label="App ID">
            <span className="font-mono text-xs">{d.app_id ?? "—"}</span>{d.app_id && <CopyId text={d.app_id} />}
          </Info>
          <Info label="User ID">
            <span className="font-mono text-xs">{d.user_id ?? "—"}</span>{d.user_id && <CopyId text={d.user_id} />}
          </Info>
          <Info label="Expira"><Expiry ts={d.expires_at} now={Date.parse(r.checkedAt)} /></Info>
          <Info label="Acceso a datos hasta">{d.data_access_expires_at ? fmtDate(d.data_access_expires_at * 1000) : "—"}</Info>
          <Info label="Emitido">{d.issued_at ? fmtDate(d.issued_at * 1000, true) : "—"}</Info>
        </div>
      </Section>

      {(r.identity || r.source.kind === "bm") && (
        <Section title="Identidad">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {r.identity && (
              <>
                <Info label="ID"><span className="font-mono text-xs">{r.identity.id}</span><CopyId text={r.identity.id} /></Info>
                <Info label="Nombre">{r.identity.name ?? "—"}</Info>
                {r.identity.email && <Info label="Email">{r.identity.email}</Info>}
              </>
            )}
            {r.source.kind === "bm" && (
              <Info label="BM de Ajustes">
                {r.source.name}
                <div className="text-xs text-muted-foreground">
                  {r.bm ? <>Acceso confirmado a <span className="font-mono">{r.source.bmIdMeta}</span></> : <span className="text-destructive">Sin acceso a {r.source.bmIdMeta}</span>}
                </div>
              </Info>
            )}
          </div>
        </Section>
      )}

      <Section title="Accesos">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Info label="Cuentas activas">
            <span className="text-xl font-semibold text-success tabular-nums">{activeAccounts}</span>
            <span className="text-muted-foreground"> de {r.accounts.length}</span>
          </Info>
          <Info label="Píxeles con disparos">
            <span className="text-xl font-semibold text-primary tabular-nums">{firedPixels}</span>
            <span className="text-muted-foreground"> de {r.pixels.length}</span>
          </Info>
          <Info label="Páginas">
            <span className="text-xl font-semibold tabular-nums">{r.pages.length}</span>
            {pagesWithFans > 0 && <span className="text-muted-foreground"> · {pagesWithFans} con fans</span>}
          </Info>
          {bms.length > 0 && <Info label="Business Managers">{bms.map((b) => <div key={b} className="text-sm">{b}</div>)}</Info>}
        </div>
      </Section>
    </div>
  );
}

function PermissionsTab({ r }: { r: TokenReport }) {
  const granted = [...new Set([...(r.debug.scopes ?? []), ...(r.debug.granular_scopes ?? []).map((g) => g.scope)])].sort();
  const declined = r.debug.declined_scopes ?? [];
  return (
    <Section title={`Permisos otorgados (${granted.length})`}>
      {granted.length ? (
        <div className="flex flex-wrap gap-1.5">{granted.map((p) => <Pill key={p} tone="info">{p}</Pill>)}</div>
      ) : (
        <p className="text-sm text-muted-foreground">Meta no devolvió permisos. Prueba con App ID y App Secret.</p>
      )}
      {declined.length > 0 && (
        <>
          <h3 className="mb-2 mt-4 text-sm font-semibold">Permisos denegados</h3>
          <div className="flex flex-wrap gap-1.5">{declined.map((p) => <Pill key={p} tone="bad">{p}</Pill>)}</div>
        </>
      )}
    </Section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function AccountsTab({ accounts }: { accounts: TokenAdAccount[] }) {
  if (!accounts.length) return <Section title="Cuentas publicitarias"><Empty>Sin cuentas publicitarias accesibles</Empty></Section>;
  return (
    <Section title={`Cuentas publicitarias (${accounts.length})`}>
      <div className="space-y-4">
        {groupBy(accounts, (a) => a.business?.name ?? "Sin Business Manager").map(([bm, list]) => (
          <div key={bm}>
            <div className="mb-1.5 text-xs text-muted-foreground"><Pill>{bm}</Pill> <span className="ml-1">{list.length} cuenta(s)</span></div>
            <div className="divide-y rounded-md border">
              {list.map((a) => {
                const [label, tone] = ACC_STATUS[a.account_status ?? 0] ?? ["Desconocido", "warn"];
                const spent = Number(a.amount_spent ?? 0) / 100;
                return (
                  <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{a.name ?? a.id}</div>
                      <div className="text-xs text-muted-foreground">
                        <span className="font-mono">{a.id}</span><CopyId text={a.id} />
                        {a.currency ? ` · ${a.currency}` : ""}{a.timezone_name ? ` · ${a.timezone_name}` : ""}
                      </div>
                    </div>
                    <div className="text-right">
                      <Pill tone={tone}>{label}</Pill>
                      <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                        Gastado: {spent.toLocaleString("es-CO", { maximumFractionDigits: 2 })} {a.currency ?? ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function PixelsTab({ pixels, now }: { pixels: TokenPixel[]; now: number }) {
  if (!pixels.length) return <Section title="Píxeles"><Empty>No se encontraron píxeles accesibles con este token</Empty></Section>;
  return (
    <Section title={`Píxeles (${pixels.length})`}>
      <div className="space-y-4">
        {groupBy(pixels, (p) => p.owner_business?.name ?? "Sin BM dueño").map(([owner, list]) => (
          <div key={owner}>
            <div className="mb-1.5 text-xs text-muted-foreground"><Pill>{owner}</Pill> <span className="ml-1">{list.length} píxel(es)</span></div>
            <div className="grid gap-2 md:grid-cols-2">
              {list.map((px) => (
                <div key={px.id} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{px.name || "Sin nombre"}</div>
                      <div className="text-xs text-muted-foreground"><span className="font-mono">{px.id}</span><CopyId text={px.id} /></div>
                      <div className="text-xs text-muted-foreground">Visto desde {px.seenFrom}</div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {px.is_unavailable ? <Pill tone="bad">Inactivo</Pill> : <Pill tone="ok">Activo</Pill>}
                      {px.can_proxy && <Pill tone="info">CAPI</Pill>}
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                    <Info label="Creado">{px.creation_time ? fmtDate(new Date(px.creation_time).getTime()) : "—"}</Info>
                    <Info label="Último disparo"><LastFired ts={px.last_fired_time} now={now} /></Info>
                    <Info label="Match rate">{px.match_rate_approx != null && px.match_rate_approx >= 0 ? `${px.match_rate_approx}%` : "—"}</Info>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function PageRow({ p }: { p: TokenPage }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{p.name ?? p.id}</span>
          {p.verification_status === "blue_verified" && <Pill tone="info">Verificada</Pill>}
          {p.is_published === false && <Pill tone="bad">No publicada</Pill>}
          {p.link && (
            <a href={p.link} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" title="Abrir página">
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          <span className="font-mono">{p.id}</span><CopyId text={p.id} />{p.category ? ` · ${p.category}` : ""}
        </div>
        {!!p.tasks?.length && (
          <div className="mt-1 flex flex-wrap gap-1">{p.tasks.map((t) => <Pill key={t}>{TASK_LABELS[t] ?? t}</Pill>)}</div>
        )}
      </div>
      <div className="text-right text-xs tabular-nums text-muted-foreground">
        <div><span className="font-medium text-foreground">{(p.fan_count ?? 0).toLocaleString("es-CO")}</span> fans</div>
        <div>{(p.followers_count ?? 0).toLocaleString("es-CO")} seguidores</div>
      </div>
    </div>
  );
}

function PagesTab({ pages }: { pages: TokenPage[] }) {
  const [showAll, setShowAll] = useState(false);
  if (!pages.length) {
    return <Section title="Páginas"><Empty>No se encontraron páginas accesibles. Requiere pages_show_list o pages_read_engagement.</Empty></Section>;
  }
  const sorted = [...pages].sort((a, b) => (b.fan_count ?? 0) - (a.fan_count ?? 0));
  const withFans = sorted.filter((p) => (p.fan_count ?? 0) > 0);
  const noFans = sorted.filter((p) => !(p.fan_count ?? 0));
  const shown = showAll ? noFans : noFans.slice(0, 50);
  return (
    <Section title={`Páginas (${pages.length} · ${withFans.length} con fans)`}>
      {withFans.length > 0 && <div className="divide-y rounded-md border">{withFans.map((p) => <PageRow key={p.id} p={p} />)}</div>}
      {noFans.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">{noFans.length} página(s) sin fans</summary>
          <div className="mt-2 divide-y rounded-md border">{shown.map((p) => <PageRow key={p.id} p={p} />)}</div>
          {shown.length < noFans.length && (
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShowAll(true)}>
              Ver las {noFans.length - shown.length} restantes
            </Button>
          )}
        </details>
      )}
    </Section>
  );
}

function RawTab({ r }: { r: TokenReport }) {
  const blocks: [string, unknown][] = [
    ["debug_token", r.debug], ["me", r.identity], ["adaccounts", r.accounts], ["pixels", r.pixels], ["pages", r.pages],
  ];
  return (
    <Section
      title="Respuestas de Meta"
      actions={
        <Button variant="outline" size="sm" onClick={() => {
          void navigator.clipboard?.writeText(JSON.stringify(r, null, 2)).then(() => toast.success("JSON copiado"));
        }}>
          <Copy /> Copiar todo
        </Button>
      }
    >
      <div className="space-y-2">
        {blocks.map(([k, v]) => (
          <details key={k} className="rounded-md border">
            <summary className="cursor-pointer px-3 py-2 font-mono text-xs">{k}</summary>
            <pre className="max-h-96 overflow-auto border-t bg-muted/40 p-3 text-[11px]">{JSON.stringify(v, null, 2)}</pre>
          </details>
        ))}
      </div>
    </Section>
  );
}

// ─── Vista ───────────────────────────────────────────────────────────────────

type Tab = "overview" | "permissions" | "accounts" | "pixels" | "pages" | "raw";

export default function TokenValidatorView({ canUseSavedBms }: { canUseSavedBms: boolean }) {
  const [bms, setBms] = useState<SavedBm[]>([]);
  const [source, setSource] = useState<string>(PASTED);
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<TokenReport | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    if (!canUseSavedBms) return;
    fetch("/api/meta/token-validator")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: SavedBm[]) => setBms(Array.isArray(list) ? list : []))
      .catch(() => setBms([]));
  }, [canUseSavedBms]);

  const pasted = source === PASTED;
  const selectedBm = bms.find((b) => b.id === source);
  const trimmed = token.trim();
  const preview = trimmed.length > 20 ? `${trimmed.slice(0, 12)}…${trimmed.slice(-8)} (${trimmed.length} caracteres)` : "";

  async function analyze() {
    if (pasted && !trimmed) { toast.error("Pega un token de acceso"); return; }
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const body = pasted
        ? { token: trimmed, ...(appId.trim() && appSecret.trim() ? { appId: appId.trim(), appSecret: appSecret.trim() } : {}) }
        : { bmId: source };
      const res = await fetch("/api/meta/token-validator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setError(errorInfoOf(json) ?? { title: (json as { error?: string } | null)?.error ?? "No se pudo validar el token" });
        toastApiError(json, "No se pudo validar el token");
        return;
      }
      setReport(json as TokenReport);
      setTab("overview");
    } catch {
      setError({ title: "Sin conexión con el servidor", message: "Revisa tu conexión y vuelve a intentarlo." });
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    setToken(""); setAppId(""); setAppSecret(""); setReport(null); setError(null);
  }

  const failedSteps = useMemo(() => report?.steps.filter((s) => !s.ok) ?? [], [report]);
  const granted = report ? new Set([...(report.debug.scopes ?? []), ...(report.debug.granular_scopes ?? []).map((g) => g.scope)]).size : 0;
  const tabs: { id: Tab; label: string; count?: number }[] = report ? [
    { id: "overview", label: "Resumen" },
    { id: "permissions", label: "Permisos", count: granted },
    { id: "accounts", label: "Cuentas", count: report.accounts.length },
    { id: "pixels", label: "Píxeles", count: report.pixels.length },
    { id: "pages", label: "Páginas", count: report.pages.length },
    { id: "raw", label: "JSON" },
  ] : [];

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Validar token"
        description="Comprueba un token de Meta: tipo, caducidad, permisos y a qué cuentas, píxeles y páginas llega."
      />

      <div className="space-y-3 rounded-lg border bg-card p-4">
        {canUseSavedBms && bms.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Token de</span>
            <Select value={source} onValueChange={(v) => { if (v) { setSource(v); setReport(null); setError(null); } }}>
              <SelectTrigger className="w-80 max-w-full">
                <SelectValue>
                  {pasted ? "Pegar un token" : selectedBm ? `${selectedBm.name}${selectedBm.tokenLast4 ? ` · …${selectedBm.tokenLast4}` : ""}` : "BM"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PASTED}>Pegar un token</SelectItem>
                {bms.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}{b.tokenLast4 ? ` · …${b.tokenLast4}` : ""}{b.status !== "active" ? ` (${b.status})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!pasted && <span className="text-xs text-muted-foreground">Business Manager de Ajustes · el token no sale del servidor</span>}
          </div>
        )}

        {pasted && (
          <>
            <div className="flex gap-2">
              <Input
                type={showToken ? "text" : "password"}
                placeholder="EAAB…"
                spellCheck={false}
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void analyze(); }}
                className="font-mono"
              />
              <Button variant="outline" onClick={() => setShowToken((v) => !v)} title={showToken ? "Ocultar" : "Mostrar"}>
                {showToken ? <EyeOff /> : <Eye />}
              </Button>
            </div>
            {preview && <p className="font-mono text-xs text-muted-foreground">{preview}</p>}
            <div className="flex flex-wrap gap-2">
              <Input placeholder="App ID (opcional)" value={appId} onChange={(e) => setAppId(e.target.value)} className="w-52" inputMode="numeric" />
              <Input type="password" placeholder="App Secret (opcional)" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} className="w-52" autoComplete="off" />
              <span className="self-center text-xs text-muted-foreground">Con App ID y App Secret Meta devuelve todos los permisos.</span>
            </div>
          </>
        )}

        <div className="flex gap-2">
          <Button onClick={() => void analyze()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            {busy ? "Analizando…" : "Analizar token"}
          </Button>
          <Button variant="ghost" onClick={clear} disabled={busy}>Limpiar</Button>
        </div>
        {busy && <p className="text-xs text-muted-foreground">Consultando token, identidad, cuentas, píxeles y páginas. Con muchas cuentas puede tardar.</p>}
      </div>

      {error && <div className="mt-4"><ErrorDetails info={error} /></div>}

      {report && (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {report.steps.map((s) => (
              <span key={s.key} className={`inline-flex items-center gap-1 ${s.ok ? "text-muted-foreground" : "text-destructive"}`}>
                {s.ok ? <Check className="h-3 w-3 text-success" /> : <X className="h-3 w-3" />}
                {s.label}{s.count != null ? `: ${s.count}` : ""}{s.note ? ` · ${s.note}` : ""}
              </span>
            ))}
          </div>
          {failedSteps.map((s) => (
            <ErrorDetails key={s.key} info={s.error && { ...s.error, title: `${s.label}: ${s.error.title}` }} fallback={`${s.label}: no se pudo consultar`} variant="warning" compact />
          ))}

          <div className="flex flex-wrap gap-1 border-b">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === t.id ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              >
                {t.label}
                {t.count != null && <span className="ml-1.5 rounded bg-muted px-1.5 text-[11px] tabular-nums">{t.count}</span>}
              </button>
            ))}
          </div>

          {tab === "overview" && <OverviewTab r={report} />}
          {tab === "permissions" && <PermissionsTab r={report} />}
          {tab === "accounts" && <AccountsTab accounts={report.accounts} />}
          {tab === "pixels" && <PixelsTab pixels={report.pixels} now={Date.parse(report.checkedAt)} />}
          {tab === "pages" && <PagesTab pages={report.pages} />}
          {tab === "raw" && <RawTab r={report} />}
        </div>
      )}
    </div>
  );
}
