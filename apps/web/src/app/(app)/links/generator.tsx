"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, Loader2, Wand2, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { generateLinks, type GeneratedLink } from "./generate-actions";

interface Account {
  id: string;
  name: string;
  status?: number;
  currency?: string;
}

interface Ad {
  adId: string;
  adName: string;
  adsetId: string;
  campaignId: string;
  campaignName?: string;
  adsetName?: string;
  assetId?: string;
}

interface Domain {
  id: string;
  host: string;
  active: boolean;
}

interface FunnelUrl {
  id: string;
  name: string;
  urlTemplate: string;
}

/** Prefijos que hacen que el enlace parezca contenido y no un acortador. */
const PREFIJOS = ["article", "report", "video", "news", "story", ""];

export function Generator({
  domains,
  funnelUrls,
}: {
  domains: Domain[];
  funnelUrls: FunnelUrl[];
}) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [errorCuentas, setErrorCuentas] = useState<string | null>(null);
  const [accountId, setAccountId] = useState("");

  const [ads, setAds] = useState<Ad[]>([]);
  const [cargandoAds, setCargandoAds] = useState(false);
  const [soloActivos, setSoloActivos] = useState(true);
  const [filtro, setFiltro] = useState("");
  const [elegidos, setElegidos] = useState<Set<string>>(new Set());

  const [url, setUrl] = useState("");
  const [domainId, setDomainId] = useState(domains.find((d) => d.active)?.id ?? "");
  const [prefijo, setPrefijo] = useState("article");
  const [funnelUrlId, setFunnelUrlId] = useState("");

  const [generados, setGenerados] = useState<GeneratedLink[]>([]);
  const [pending, startTransition] = useTransition();

  // Las cuentas se piden una vez al abrir la pantalla.
  useEffect(() => {
    fetch("/api/links/ad-accounts")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setErrorCuentas(d.error);
        else setAccounts(d.accounts ?? []);
      })
      .catch(() => setErrorCuentas("No se pudo contactar con Meta"));
  }, []);

  // Los anuncios, cada vez que cambia la cuenta o el filtro de activos.
  useEffect(() => {
    if (!accountId) {
      setAds([]);
      return;
    }
    setCargandoAds(true);
    setElegidos(new Set());
    fetch(`/api/links/ads?accountId=${encodeURIComponent(accountId)}${soloActivos ? "" : "&all=1"}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) toast.error(d.error);
        setAds(d.ads ?? []);
      })
      .catch(() => toast.error("No se pudieron cargar los anuncios"))
      .finally(() => setCargandoAds(false));
  }, [accountId, soloActivos]);

  const visibles = useMemo(() => {
    const q = filtro.toLowerCase().trim();
    if (!q) return ads;
    return ads.filter(
      (a) =>
        a.adName.toLowerCase().includes(q) ||
        (a.campaignName ?? "").toLowerCase().includes(q) ||
        a.adId.includes(q),
    );
  }, [ads, filtro]);

  function alternar(adId: string) {
    setElegidos((prev) => {
      const s = new Set(prev);
      if (s.has(adId)) s.delete(adId);
      else s.add(adId);
      return s;
    });
  }

  function generar() {
    const seleccionados = ads.filter((a) => elegidos.has(a.adId));
    startTransition(async () => {
      const res = await generateLinks({
        domainId,
        url,
        slugPrefix: prefijo || null,
        funnelUrlId: funnelUrlId || null,
        ads: seleccionados.map((a) => ({
          adId: a.adId,
          adsetId: a.adsetId,
          campaignId: a.campaignId,
          assetId: a.assetId ?? null,
          adName: a.adName ?? null,
          adsetName: a.adsetName ?? null,
          campaignName: a.campaignName ?? null,
        })),
      });
      if (res.ok) {
        setGenerados(res.created);
        setElegidos(new Set());
        toast.success(`${res.created.length} enlace(s) generado(s)`);
      } else {
        toast.error(res.error);
      }
    });
  }

  async function copiar(texto: string, aviso = "Copiado") {
    try {
      await navigator.clipboard.writeText(texto);
      toast.success(aviso);
    } catch {
      toast.error("No se pudo copiar");
    }
  }

  if (errorCuentas) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <div className="text-sm text-amber-900">
          <p className="font-medium">No se pueden listar los anuncios</p>
          <p className="mt-0.5">{errorCuentas}</p>
        </div>
      </div>
    );
  }

  const dominiosActivos = domains.filter((d) => d.active);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Anuncios ──────────────────────────────────────────────── */}
        <div className="rounded-lg border bg-card p-4">
          <p className="mb-3 text-sm font-medium">1 · Elige los anuncios</p>

          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="mb-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
            disabled={accounts === null}
          >
            <option value="">
              {accounts === null ? "Cargando cuentas…" : "Elige una cuenta publicitaria"}
            </option>
            {(accounts ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.status !== 1 ? " (inactiva)" : ""}
              </option>
            ))}
          </select>

          {accountId && (
            <>
              <div className="mb-2 flex items-center gap-2">
                <Input
                  placeholder="Filtrar por nombre, campaña o ID…"
                  value={filtro}
                  onChange={(e) => setFiltro(e.target.value)}
                  className="text-xs"
                />
                <Button
                  size="sm"
                  variant={soloActivos ? "default" : "outline"}
                  onClick={() => setSoloActivos((v) => !v)}
                >
                  Solo activos
                </Button>
              </div>

              <div className="max-h-72 overflow-y-auto rounded-md border">
                {cargandoAds && (
                  <p className="flex items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Cargando anuncios…
                  </p>
                )}
                {!cargandoAds && visibles.length === 0 && (
                  <p className="p-4 text-center text-xs text-muted-foreground">
                    {ads.length === 0
                      ? soloActivos
                        ? "Ningún anuncio en entrega. Prueba a desactivar «Solo activos»."
                        : "Esta cuenta no tiene anuncios."
                      : "Ninguno coincide con el filtro"}
                  </p>
                )}
                {visibles.map((a) => (
                  <label
                    key={a.adId}
                    className="flex cursor-pointer items-start gap-2 border-b px-3 py-2 last:border-0 hover:bg-muted/50"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 rounded border"
                      checked={elegidos.has(a.adId)}
                      onChange={() => alternar(a.adId)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{a.adName || a.adId}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {a.campaignName ?? a.campaignId}
                      </p>
                    </div>
                  </label>
                ))}
              </div>

              {visibles.length > 0 && (
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {elegidos.size} de {visibles.length} seleccionados
                  </span>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setElegidos(new Set(visibles.map((a) => a.adId)))}
                    >
                      Todos
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setElegidos(new Set())}>
                      Ninguno
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Destino ───────────────────────────────────────────────── */}
        <div className="rounded-lg border bg-card p-4">
          <p className="mb-3 text-sm font-medium">2 · A dónde apuntan</p>

          {funnelUrls.length > 0 && (
            <div className="mb-3 space-y-1.5">
              <Label className="text-xs">URL guardada</Label>
              <select
                value={funnelUrlId}
                onChange={(e) => {
                  setFunnelUrlId(e.target.value);
                  const f = funnelUrls.find((x) => x.id === e.target.value);
                  if (f) setUrl(f.urlTemplate);
                }}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="">Escribir una URL nueva</option>
                {funnelUrls.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="url" className="text-xs">
              URL de FunnelFlux con sus macros
            </Label>
            <Textarea
              id="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              rows={4}
              className="font-mono text-xs"
              placeholder="https://track.tudominio.com/fts/FUNNEL-TS?ad_id={{ad.id}}&adset_id={{adset.id}}&campaign={{campaign.id}}&placement={{placement}}"
            />
            <p className="text-xs text-muted-foreground">
              Las {"{{macros}}"} se sustituyen por los IDs reales de cada anuncio, así
              que el enlace ya nace resuelto y el redirect es instantáneo.
            </p>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Dominio</Label>
              <select
                value={domainId}
                onChange={(e) => setDomainId(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                {dominiosActivos.length === 0 && <option value="">Sin dominios activos</option>}
                {dominiosActivos.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.host}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Prefijo del enlace</Label>
              <select
                value={prefijo}
                onChange={(e) => setPrefijo(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                {PREFIJOS.map((p) => (
                  <option key={p} value={p}>
                    {p || "sin prefijo"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            Quedará como{" "}
            <code>
              {dominiosActivos.find((d) => d.id === domainId)?.host ?? "dominio"}/
              {prefijo ? `${prefijo}-` : ""}x7kp2q
            </code>
          </p>

          <Button
            className="mt-4 w-full"
            disabled={pending || elegidos.size === 0 || !url.trim() || !domainId}
            onClick={generar}
          >
            {pending ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                Generando…
              </>
            ) : (
              <>
                <Wand2 className="mr-1.5 h-4 w-4" />
                Generar {elegidos.size > 0 ? `${elegidos.size} enlace(s)` : "enlaces"}
              </>
            )}
          </Button>
        </div>
      </div>

      {/* ── Resultado ───────────────────────────────────────────────── */}
      {generados.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b p-3">
            <p className="text-sm font-medium">
              {generados.length} enlace(s) generado(s)
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                copiar(generados.map((g) => g.url).join("\n"), "Todos los enlaces copiados")
              }
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              Copiar todos
            </Button>
          </div>
          <div className="divide-y">
            {generados.map((g) => (
              <div key={g.slug} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <code className="text-xs">{g.url}</code>
                  <p className="truncate text-xs text-muted-foreground">{g.adName}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => copiar(g.url)}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
