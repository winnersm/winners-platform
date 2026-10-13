"use client";

import { useEffect, useState, useCallback, Suspense, useRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  RefreshCw, AlertCircle, Search, Copy, TrendingUp, Play, Pause, Briefcase, Building2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { DuplicateCampaignModal } from "@/components/duplicate-campaign-modal";
import { DuplicateAdsetsModal } from "@/components/duplicate-adsets-modal";
import { DuplicateAdsModal } from "@/components/duplicate-ads-modal";
import { toast } from "sonner";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Campaign {
  id: string; name: string; status: string; objective: string;
  buying_type: string; daily_budget?: string; lifetime_budget?: string;
  is_cbo: boolean; special_ad_categories: string[];
}
interface AdSet {
  id: string; name: string; status: string; campaign_id?: string;
  daily_budget?: string; lifetime_budget?: string; optimization_goal?: string;
}
interface Ad { id: string; name: string; status: string; creative_id?: string; }

interface Insights {
  spend: string; impressions: string; clicks: string; ctr: string; cpc: string;
  cpm?: string; inline_link_clicks?: string; unique_link_clicks_ctr?: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
}
type Level = "campaign" | "adset" | "ad";
type Selection = { id: string; name: string };

// ─── Client-side cache ────────────────────────────────────────────────────────
const CLIENT_TTL = 5 * 60 * 1000;
interface Snap<T> { data: T; key: string; ts: number; }
function fresh<T>(s: Snap<T> | null, key: string): s is Snap<T> {
  return !!s && s.key === key && Date.now() - s.ts < CLIENT_TTL;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DATE_PRESETS = [
  { value: "today", label: "Hoy" },
  { value: "yesterday", label: "Ayer" },
  { value: "last_7d", label: "7 días" },
  { value: "last_30d", label: "30 días" },
  { value: "last_month", label: "Mes ant." },
];

const STATUS_OPTS = [
  { value: "ALL", label: "Todos" },
  { value: "ACTIVE", label: "Activos" },
  { value: "PAUSED", label: "Pausados" },
  { value: "ARCHIVED", label: "Archivados" },
];

function fmtBudget(cents?: string) {
  if (!cents) return "—";
  return new Intl.NumberFormat("es-MX", {
    style: "currency", currency: "USD", minimumFractionDigits: 0,
  }).format(Number(cents) / 100);
}

function fmtC(n: number | null): string {
  const x = n ?? 0;
  return `$${x.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtI(n: number | null): string {
  const x = n ?? 0;
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1)}M`;
  if (x >= 1_000) return `${(x / 1_000).toFixed(1)}K`;
  return Math.round(x).toString();
}
function fmtP(n: number | null): string {
  return `${(n ?? 0).toFixed(2)}%`;
}

// Meta devuelve varios action_types de compra/checkout que SE SOLAPAN (omni_*,
// offsite_conversion.*, onsite_*, purchase, ...) con el mismo valor → sumarlos es
// doble/óctuple conteo. Se toma el primer tipo canónico (omni_* = deduplicado, el
// que muestra Ads Manager).
function pickAction(rows: Array<{ action_type: string; value: string }> | undefined, priority: string[]): number {
  const list = rows ?? [];
  for (const t of priority) {
    const hit = list.find(a => a.action_type === t);
    if (hit) return parseFloat(hit.value || "0");
  }
  return 0;
}
const PURCHASE = ["omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase", "purchase"];
const INITIATE_CHECKOUT = ["omni_initiated_checkout", "offsite_conversion.fb_pixel_initiate_checkout", "onsite_web_initiate_checkout", "initiate_checkout"];

function getPurchaseRevenue(ins: Insights): number {
  return pickAction(ins.action_values, PURCHASE);
}
function getPurchaseCount(ins: Insights): number {
  return pickAction(ins.actions, PURCHASE);
}
// IC = Initiate Checkout (evento de Meta), NO inline link clicks.
function getInitiateCheckout(ins: Insights): number {
  return pickAction(ins.actions, INITIATE_CHECKOUT);
}

function calcMetrics(ins: Insights | undefined) {
  if (!ins) return null;
  const spend = parseFloat(ins.spend || "0");
  const revenue = getPurchaseRevenue(ins);
  const sales = getPurchaseCount(ins);
  const profit = revenue - spend;
  const cpa = sales > 0 && spend > 0 ? spend / sales : null;
  const roi = spend > 0 ? (profit / spend) * 100 : null;
  const cpm = ins.cpm ? parseFloat(ins.cpm) : spend > 0 && parseFloat(ins.impressions || "0") > 0
    ? (spend / parseFloat(ins.impressions)) * 1000 : null;
  const cpc = ins.cpc ? parseFloat(ins.cpc) : null;
  const ctr = ins.ctr ? parseFloat(ins.ctr) : null;
  const uctr = ins.unique_link_clicks_ctr ? parseFloat(ins.unique_link_clicks_ctr) : null;
  const icRaw = getInitiateCheckout(ins);
  const ic = icRaw > 0 ? icRaw : null;
  const costPerIc = ic && ic > 0 && spend > 0 ? spend / ic : null;
  return { spend, revenue, sales, profit, cpa, roi, cpm, cpc, ctr, uctr, ic, costPerIc };
}

const ROW_GREEN = "bg-green-50 border-l-4 border-l-green-400 hover:bg-green-100/60";
const ROW_RED = "bg-red-50 border-l-4 border-l-red-400 hover:bg-red-100/60";

// Traduce errores crudos de Meta a algo accionable para el usuario.
function friendlyMetaError(msg?: string | null): string | null {
  if (!msg) return msg ?? null;
  if (/\berror 17\b|request limit/i.test(msg)) {
    return "Meta está limitando esta cuenta por demasiadas solicitudes (error 17). Espera unos minutos o cambia a otra cuenta; los datos se recuperan solos.";
  }
  if (/\berror 4\b/i.test(msg)) {
    return "Límite de solicitudes de la app alcanzado (error 4). Espera unos minutos e intenta de nuevo.";
  }
  if (/\berror 190\b|access token/i.test(msg)) {
    return "El token del Business Manager expiró o es inválido (error 190). Actualízalo en Ajustes.";
  }
  return msg;
}
const ROW_BLUE = "bg-blue-50 border-l-4 border-l-blue-400 hover:bg-blue-100/60";
function rowColorClass(ins: Insights | undefined, loaded: boolean): string {
  // Sin insights: si ya terminó de cargar = sin actividad (profit 0) → azul; si aún carga → neutro.
  if (!ins) return loaded ? ROW_BLUE : "hover:bg-muted/30";
  const spend = parseFloat(ins.spend || "0");
  const revenue = getPurchaseRevenue(ins);
  const profit = revenue - spend;
  if (profit > 0) return ROW_GREEN;   // ganancia
  if (profit < 0) return ROW_RED;     // pérdida
  return ROW_BLUE;                    // profit 0
}

function Ldr({ loading }: { loading: boolean }) {
  return loading ? <span className="inline-block w-10 h-3 bg-muted animate-pulse rounded" /> : null;
}

// ¿El string formateado representa cero? ("0", "$0.00", "0.00%", "0%", "-$0.00")
function isZeroStr(v: string): boolean {
  return /^-?\$?0([.,]0+)?%?$/.test(v.trim());
}
function MC({ v, loading }: { v: string | null; loading: boolean }) {
  if (loading) return <Ldr loading />;
  const cls = (v == null || isZeroStr(v)) ? "text-muted-foreground/40" : "";
  return <span className={`text-xs tabular-nums ${cls}`}>{v ?? "—"}</span>;
}
function ProfitCell({ v, loading }: { v: number | null; loading: boolean }) {
  if (loading) return <Ldr loading />;
  const val = v ?? 0;
  if (val === 0) return <span className="text-xs tabular-nums text-muted-foreground/60">$0.00</span>;
  const pos = val > 0;
  return <span className={`text-xs tabular-nums font-medium ${pos ? "text-green-700" : "text-red-600"}`}>
    {pos ? "" : "-"}{fmtC(Math.abs(val))}
  </span>;
}
function RoiCell({ v, loading }: { v: number | null; loading: boolean }) {
  if (loading) return <Ldr loading />;
  const val = v ?? 0;
  if (val === 0) return <span className="text-xs tabular-nums text-muted-foreground/60">0%</span>;
  const pos = val > 0;
  return <span className={`text-xs tabular-nums font-medium ${pos ? "text-green-700" : "text-red-600"}`}>
    {val.toFixed(0)}%
  </span>;
}

// ─── Status toggle ─────────────────────────────────────────────────────────────

function StatusCell({
  entityId, status, entityType, accountId, loadingSet, onToggle,
}: {
  entityId: string; status: string; entityType: "campaign" | "adset" | "ad";
  accountId: string; loadingSet: Set<string>;
  onToggle: (id: string, currentStatus: string, type: "campaign" | "adset" | "ad") => void;
}) {
  const loading = loadingSet.has(entityId);
  const isActive = status === "ACTIVE";
  return (
    <div className="flex items-center gap-1">
      <Badge
        variant={isActive ? "default" : status === "ARCHIVED" ? "outline" : "secondary"}
        className="text-[10px] px-1.5 py-0 shrink-0"
      >
        {status}
      </Badge>
      {(status === "ACTIVE" || status === "PAUSED") && (
        <button
          onClick={e => { e.stopPropagation(); onToggle(entityId, status, entityType); }}
          disabled={loading}
          className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40"
          title={isActive ? "Pausar" : "Activar"}
        >
          {loading
            ? <RefreshCw className="h-3 w-3 animate-spin" />
            : isActive
              ? <Pause className="h-3 w-3" />
              : <Play className="h-3 w-3" />
          }
        </button>
      )}
    </div>
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────

function ManagerInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const accountId = searchParams.get("accountId");
  const bmId = searchParams.get("bmId") ?? undefined;

  const [accountName, setAccountName] = useState<string>("");

  const [level, setLevel] = useState<Level>("campaign");
  const [selCampaign, setSelCampaign] = useState<Selection | null>(null);
  const [selAdset, setSelAdset] = useState<Selection | null>(null);

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [adsets, setAdsets] = useState<AdSet[]>([]);
  const [ads, setAds] = useState<Ad[]>([]);

  const [insightsMap, setInsightsMap] = useState<Record<string, Insights>>({});
  const [datePreset, setDatePreset] = useState("last_7d");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);

  const [loadingData, setLoadingData] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [nameFilter, setNameFilter] = useState("");
  const [duplicateTarget, setDuplicateTarget] = useState<Campaign | null>(null);
  const [selectedAdsetIds, setSelectedAdsetIds] = useState<Set<string>>(new Set());
  const [showDuplicateAdsetsModal, setShowDuplicateAdsetsModal] = useState(false);
  const [selectedAdIds, setSelectedAdIds] = useState<Set<string>>(new Set());
  const [showDuplicateAdsModal, setShowDuplicateAdsModal] = useState(false);

  // Snapshots para caché client-side (sobreviven re-renders, no recargas de página)
  const campSnap = useRef<Snap<{ list: Campaign[]; cur: string | null }> | null>(null);
  const adsetSnap = useRef<Snap<AdSet[]> | null>(null);
  const adSnap = useRef<Snap<Ad[]> | null>(null);
  const insSnap = useRef<Snap<Record<string, Insights>> | null>(null);
  // Checkbox header refs — DEBEN declararse antes de cualquier early return (regla de hooks).
  const adsetCheckRef = useRef<HTMLInputElement>(null);
  const adCheckRef = useRef<HTMLInputElement>(null);

  // ── Loaders ───────────────────────────────────────────────────────────────

  const loadCampaigns = useCallback(async (refresh = false, cursor?: string) => {
    if (!accountId) return;
    cursor ? setLoadingMore(true) : setLoadingData(true);
    setError(null);
    const p = new URLSearchParams({ accountId });
    if (cursor) p.set("cursor", cursor);
    if (refresh) p.set("refresh", "true");
    if (bmId) p.set("bmId", bmId);
    const res = await fetch(`/api/meta/campaigns?${p}`);
    const json = await res.json();
    cursor ? setLoadingMore(false) : setLoadingData(false);
    if (!res.ok) { setError(friendlyMetaError(json.error) ?? "Error al cargar campañas"); return; }
    setStale(!!json.stale);
    setCampaigns(prev => cursor ? [...prev, ...json.campaigns] : json.campaigns);
    setNextCursor(json.nextCursor);
    if (!cursor) campSnap.current = { data: { list: json.campaigns, cur: json.nextCursor }, key: accountId, ts: Date.now() };
    if (refresh) toast.success("Campañas actualizadas");
  }, [accountId]);

  const loadAdsets = useCallback(async (campaignId?: string) => {
    if (!accountId) return;
    setLoadingData(true); setError(null); setStale(false);
    const url = campaignId
      ? `/api/meta/adsets?accountId=${accountId}&campaignId=${campaignId}${bmId ? `&bmId=${bmId}` : ""}`
      : `/api/meta/adsets?accountId=${accountId}${bmId ? `&bmId=${bmId}` : ""}`;
    const res = await fetch(url);
    const json = await res.json();
    setLoadingData(false);
    if (!res.ok) { setError(friendlyMetaError(json.error) ?? "Error"); return; }
    setAdsets(json.adsets);
    adsetSnap.current = { data: json.adsets, key: `adsets:${accountId}:${campaignId || "all"}`, ts: Date.now() };
  }, [accountId]);

  const loadAds = useCallback(async (adsetId?: string) => {
    if (!accountId) return;
    setLoadingData(true); setError(null); setStale(false);
    const url = adsetId
      ? `/api/meta/ads?accountId=${accountId}&adsetId=${adsetId}${bmId ? `&bmId=${bmId}` : ""}`
      : `/api/meta/ads?accountId=${accountId}${bmId ? `&bmId=${bmId}` : ""}`;
    const res = await fetch(url);
    const json = await res.json();
    setLoadingData(false);
    if (!res.ok) { setError(friendlyMetaError(json.error) ?? "Error"); return; }
    setAds(json.ads);
    adSnap.current = { data: json.ads, key: `ads:${accountId}:${adsetId || "all"}`, ts: Date.now() };
  }, [accountId]);

  const loadInsights = useCallback(async (lvl: Level, date: string) => {
    if (!accountId) return;
    setLoadingInsights(true);
    try {
      const res = await fetch(`/api/meta/insights?accountId=${accountId}&level=${lvl}&datePreset=${date}${bmId ? `&bmId=${bmId}` : ""}`);
      const json = await res.json();
      if (!res.ok) {
        console.error(`[insights] ${lvl} error:`, json.error);
        toast.error(`Error métricas (${lvl}): ${json.error ?? "desconocido"}`);
        return;
      }
      const idField = lvl === "campaign" ? "campaign_id" : lvl === "adset" ? "adset_id" : "ad_id";
      const map: Record<string, Insights> = {};
      for (const item of json.data ?? []) {
        if (item[idField]) map[item[idField]] = item;
      }
      setInsightsMap(map);
      insSnap.current = { data: map, key: `${lvl}:${accountId}:${date}`, ts: Date.now() };
    } catch (e) {
      console.error(`[insights] fetch error:`, e);
    } finally {
      setLoadingInsights(false);
    }
  }, [accountId]);

  // ── Effects ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (accountId) { loadCampaigns(); loadInsights("campaign", datePreset); }
  }, [accountId]); // eslint-disable-line

  // Nombre de la cuenta actual (para mostrar en qué cuenta estás). Usa el listado cacheado.
  useEffect(() => {
    if (!accountId) return;
    fetch(`/api/meta/accounts${bmId ? `?bmId=${bmId}` : ""}`)
      .then(r => r.json())
      .then(j => {
        const acc = (j.accounts ?? []).find((a: { id: string; name: string }) => a.id === `act_${accountId}` || a.id === accountId);
        if (acc) setAccountName(acc.name);
      })
      .catch(() => { });
  }, [accountId, bmId]);

  useEffect(() => {
    setInsightsMap({});
    loadInsights(level, datePreset);
  }, [datePreset]); // eslint-disable-line

  // ── Navigation ────────────────────────────────────────────────────────────

  async function drillAdsets(campaign: Campaign) {
    setSelCampaign({ id: campaign.id, name: campaign.name });
    setSelAdset(null);
    setLevel("adset"); setNameFilter(""); setStatusFilter("ACTIVE");
    setSelectedAdsetIds(new Set()); setSelectedAdIds(new Set());
    const dKey = `adsets:${accountId}:${campaign.id}`;
    const iKey = `adset:${accountId}:${datePreset}`;
    const dataFresh = fresh(adsetSnap.current, dKey);
    const insFresh = fresh(insSnap.current, iKey);
    if (dataFresh) setAdsets(adsetSnap.current!.data); else setAdsets([]);
    if (insFresh) setInsightsMap(insSnap.current!.data); else setInsightsMap({});
    if (!dataFresh) await loadAdsets(campaign.id);
    if (!insFresh) loadInsights("adset", datePreset);
  }

  async function drillAds(adset: AdSet) {
    setSelAdset({ id: adset.id, name: adset.name });
    setLevel("ad"); setNameFilter(""); setStatusFilter("ACTIVE");
    const dKey = `ads:${accountId}:${adset.id}`;
    const iKey = `ad:${accountId}:${datePreset}`;
    const dataFresh = fresh(adSnap.current, dKey);
    const insFresh = fresh(insSnap.current, iKey);
    if (dataFresh) setAds(adSnap.current!.data); else setAds([]);
    if (insFresh) setInsightsMap(insSnap.current!.data); else setInsightsMap({});
    if (!dataFresh) await loadAds(adset.id);
    if (!insFresh) loadInsights("ad", datePreset);
  }

  // Tabs siempre clickeables → nivel cuenta
  async function goToCampaigns() {
    setSelCampaign(null); setSelAdset(null);
    setLevel("campaign"); setNameFilter(""); setStatusFilter("ACTIVE");
    const dKey = accountId!;
    const iKey = `campaign:${accountId}:${datePreset}`;
    const dataFresh = fresh(campSnap.current, dKey);
    const insFresh = fresh(insSnap.current, iKey);
    if (dataFresh) { setCampaigns(campSnap.current!.data.list); setNextCursor(campSnap.current!.data.cur); }
    else { setCampaigns([]); setNextCursor(null); }
    if (insFresh) setInsightsMap(insSnap.current!.data); else setInsightsMap({});
    if (!dataFresh) await loadCampaigns();
    if (!insFresh) loadInsights("campaign", datePreset);
  }

  async function goToAdsets() {
    setSelCampaign(null); setSelAdset(null);
    setLevel("adset"); setNameFilter(""); setStatusFilter("ACTIVE");
    setSelectedAdsetIds(new Set()); setSelectedAdIds(new Set());
    const dKey = `adsets:${accountId}:all`;
    const iKey = `adset:${accountId}:${datePreset}`;
    const dataFresh = fresh(adsetSnap.current, dKey);
    const insFresh = fresh(insSnap.current, iKey);
    if (dataFresh) setAdsets(adsetSnap.current!.data); else setAdsets([]);
    if (insFresh) setInsightsMap(insSnap.current!.data); else setInsightsMap({});
    if (!dataFresh) await loadAdsets();
    if (!insFresh) loadInsights("adset", datePreset);
  }

  async function goToAds() {
    setSelAdset(null);
    setLevel("ad"); setNameFilter(""); setStatusFilter("ACTIVE");
    setSelectedAdIds(new Set());
    const dKey = `ads:${accountId}:all`;
    const iKey = `ad:${accountId}:${datePreset}`;
    const dataFresh = fresh(adSnap.current, dKey);
    const insFresh = fresh(insSnap.current, iKey);
    if (dataFresh) setAds(adSnap.current!.data); else setAds([]);
    if (insFresh) setInsightsMap(insSnap.current!.data); else setInsightsMap({});
    if (!dataFresh) await loadAds();
    if (!insFresh) loadInsights("ad", datePreset);
  }

  async function refresh() {
    // Invalidar snapshot del nivel actual para forzar re-fetch
    if (level === "campaign") { campSnap.current = null; insSnap.current = null; }
    else if (level === "adset") { adsetSnap.current = null; insSnap.current = null; }
    else { adSnap.current = null; insSnap.current = null; }
    setInsightsMap({});
    if (level === "campaign") await loadCampaigns(true);
    else if (level === "adset") await loadAdsets(selCampaign?.id);
    else if (level === "ad") await loadAds(selAdset?.id);
    loadInsights(level, datePreset);
  }

  // ── Status toggle ─────────────────────────────────────────────────────────

  async function toggleStatus(entityId: string, currentStatus: string, entityType: "campaign" | "adset" | "ad") {
    if (loadingStatus.has(entityId) || !accountId) return;
    const newStatus = currentStatus === "ACTIVE" ? "PAUSED" : "ACTIVE";

    // Actualización optimista
    if (entityType === "campaign") setCampaigns(p => p.map(c => c.id === entityId ? { ...c, status: newStatus } : c));
    else if (entityType === "adset") setAdsets(p => p.map(a => a.id === entityId ? { ...a, status: newStatus } : a));
    else setAds(p => p.map(a => a.id === entityId ? { ...a, status: newStatus } : a));

    setLoadingStatus(p => new Set([...p, entityId]));

    try {
      const res = await fetch("/api/meta/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId, status: newStatus, accountId, entityType, bmId }),
      });
      if (!res.ok) throw new Error("Error en API");
      toast.success(newStatus === "ACTIVE" ? "Activado" : "Pausado");
    } catch {
      // Revertir
      if (entityType === "campaign") setCampaigns(p => p.map(c => c.id === entityId ? { ...c, status: currentStatus } : c));
      else if (entityType === "adset") setAdsets(p => p.map(a => a.id === entityId ? { ...a, status: currentStatus } : a));
      else setAds(p => p.map(a => a.id === entityId ? { ...a, status: currentStatus } : a));
      toast.error("Error al cambiar estado");
    } finally {
      setLoadingStatus(p => { const n = new Set(p); n.delete(entityId); return n; });
    }
  }

  // ── Filter ────────────────────────────────────────────────────────────────

  function filterData<T extends { name: string; status: string }>(data: T[]): T[] {
    return data.filter(d =>
      (statusFilter === "ALL" || d.status === statusFilter) &&
      d.name.toLowerCase().includes(nameFilter.toLowerCase())
    );
  }

  // ── Sort ─────────────────────────────────────────────────────────────────
  function toggleSort(key: string) {
    setSort(s => s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
  }
  // Valor de orden de una fila para una columna (name o métrica calculada de insights).
  function sortVal(key: string, row: { id: string; name: string }): number | string {
    if (key === "name") return row.name.toLowerCase();
    const m = calcMetrics(insightsMap[row.id]) as Record<string, number | null> | null;
    const v = m ? m[key] : null;
    return v == null ? -Infinity : v; // sin dato → al fondo
  }
  function applySort<T extends { id: string; name: string }>(rows: T[]): T[] {
    if (!sort) return rows;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = sortVal(sort.key, a), vb = sortVal(sort.key, b);
      if (typeof va === "string" && typeof vb === "string") return va.localeCompare(vb) * dir;
      return ((va as number) - (vb as number)) * dir;
    });
  }

  const visCampaigns = applySort(filterData(campaigns));
  const visAdsets = applySort(filterData(adsets));
  const visAds = applySort(filterData(ads));

  if (!accountId) {
    return <GlobalCampaignsView />;
  }

  // ── Tab labels ────────────────────────────────────────────────────────────

  const adsetTabLabel = level === "adset" && selCampaign
    ? `Ad Sets · ${selCampaign.name.length > 18 ? selCampaign.name.slice(0, 18) + "…" : selCampaign.name}`
    : "Ad Sets";
  const adTabLabel = level === "ad" && selAdset
    ? `Anuncios · ${selAdset.name.length > 18 ? selAdset.name.slice(0, 18) + "…" : selAdset.name}`
    : "Anuncios";

  const tabBtn = (id: Level, label: string, active: boolean, onClick: () => void) => (
    <button
      key={id}
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
      }`}
    >
      {label}
    </button>
  );

  // ── Column headers ────────────────────────────────────────────────────────

  const sh = (key: string, label: string, w: string) => (
    <TableHead
      className={`py-2 text-[10px] font-semibold text-right ${w} cursor-pointer select-none hover:text-foreground ${sort?.key === key ? "text-primary" : ""}`}
      onClick={() => toggleSort(key)}
    >
      <span className="inline-flex items-center justify-end gap-0.5">
        {label}{sort?.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
      </span>
    </TableHead>
  );
  const metricHeaders = (
    <>
      {sh("sales", "SALES", "w-12")}
      {sh("spend", "SPEND", "w-20")}
      {sh("revenue", "REVENUE", "w-20")}
      {sh("profit", "PROFIT", "w-20")}
      {sh("cpa", "CPA", "w-20")}
      {sh("roi", "ROI", "w-14")}
      {sh("cpm", "CPM", "w-20")}
      {sh("cpc", "CPC", "w-20")}
      {sh("ctr", "CTR", "w-14")}
      {sh("uctr", "U-CTR", "w-14")}
      {sh("ic", "IC", "w-16")}
      {sh("costPerIc", "$/IC", "w-20")}
    </>
  );

  function MetricCells({ ins, loading }: { ins: Insights | undefined; loading: boolean }) {
    const m = calcMetrics(ins);
    return (
      <>
        <TableCell className="py-2 text-right"><MC v={fmtI(m?.sales ?? 0)} loading={loading} /></TableCell>
        <TableCell className="py-2 text-right"><MC v={fmtC(m?.spend ?? 0)} loading={loading} /></TableCell>
        <TableCell className="py-2 text-right"><MC v={fmtC(m?.revenue ?? 0)} loading={loading} /></TableCell>
        <TableCell className="py-2 text-right"><ProfitCell v={m?.profit ?? 0} loading={loading} /></TableCell>
        <TableCell className="py-2 text-right"><MC v={fmtC(m?.cpa ?? 0)} loading={loading} /></TableCell>
        <TableCell className="py-2 text-right"><RoiCell v={m?.roi ?? 0} loading={loading} /></TableCell>
        <TableCell className="py-2 text-right"><MC v={fmtC(m?.cpm ?? 0)} loading={loading} /></TableCell>
        <TableCell className="py-2 text-right"><MC v={fmtC(m?.cpc ?? 0)} loading={loading} /></TableCell>
        <TableCell className="py-2 text-right"><MC v={fmtP(m?.ctr ?? 0)} loading={loading} /></TableCell>
        <TableCell className="py-2 text-right"><MC v={fmtP(m?.uctr ?? 0)} loading={loading} /></TableCell>
        <TableCell className="py-2 text-right"><MC v={fmtI(m?.ic ?? 0)} loading={loading} /></TableCell>
        <TableCell className="py-2 text-right"><MC v={fmtC(m?.costPerIc ?? 0)} loading={loading} /></TableCell>
      </>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-0">

      {/* Cuenta actual */}
      <div className="flex items-center gap-2 pb-2 text-sm">
        <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="font-semibold truncate">{accountName || "Cuenta"}</span>
        <span className="text-muted-foreground text-xs">· {accountId}</span>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0 border-b bg-white -mx-5 px-5">
        {tabBtn("campaign", "Campañas", level === "campaign", goToCampaigns)}
        {tabBtn("adset", adsetTabLabel, level === "adset", goToAdsets)}
        {tabBtn("ad", adTabLabel, level === "ad", goToAds)}

        <div className="ml-auto flex items-center gap-2 py-1">
          <TrendingUp className={`h-3.5 w-3.5 ${loadingInsights ? "animate-pulse text-primary" : "text-muted-foreground/40"}`} />
          <Select value={datePreset} onValueChange={v => v && setDatePreset(v)}>
            <SelectTrigger className="h-7 text-xs w-24 border-0 shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_PRESETS.map(p => <SelectItem key={p.value} value={p.value} className="text-xs">{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={refresh} disabled={loadingData}>
            <RefreshCw className={`h-3.5 w-3.5 ${loadingData ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 pt-3 pb-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Buscar..." className="pl-8 h-8 text-sm w-44 bg-white"
            value={nameFilter} onChange={e => setNameFilter(e.target.value)}
          />
        </div>

        <Select value={statusFilter} onValueChange={v => v && setStatusFilter(v)}>
          <SelectTrigger className="h-8 w-32 text-xs bg-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTS.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
          </SelectContent>
        </Select>

        <span className="text-xs text-muted-foreground">
          {!loadingData && (level === "campaign" ? visCampaigns.length : level === "adset" ? visAdsets.length : visAds.length)} elementos
        </span>

        <Button
          variant="outline" size="sm" className="h-8 text-xs ml-1"
          onClick={() => router.push("/meta/jobs")}
        >
          <Briefcase className="h-3.5 w-3.5 mr-1" /> Trabajos
        </Button>

        {level === "adset" && selectedAdsetIds.size > 0 && (
          <Button size="sm" className="ml-auto h-8" onClick={() => setShowDuplicateAdsetsModal(true)}>
            <Copy className="h-3.5 w-3.5 mr-1" />
            Duplicar {selectedAdsetIds.size} ad set{selectedAdsetIds.size > 1 ? "s" : ""}
          </Button>
        )}
        {level === "ad" && selectedAdIds.size > 0 && (
          <Button size="sm" className="ml-auto h-8" onClick={() => setShowDuplicateAdsModal(true)}>
            <Copy className="h-3.5 w-3.5 mr-1" />
            Duplicar {selectedAdIds.size} anuncio{selectedAdIds.size > 1 ? "s" : ""}
          </Button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" /><span>{error}</span>
        </div>
      )}

      {/* Datos en caché (Meta limitó la cuenta y servimos la última copia buena) */}
      {stale && !error && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>Mostrando datos en caché — Meta está limitando esta cuenta (error 17). Se actualizarán solos en unos minutos.</span>
        </div>
      )}

      {/* Table */}
      {loadingData ? (
        <div className="space-y-1.5 pt-1">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 rounded" />)}
        </div>
      ) : (
        <div className="rounded-lg border bg-white shadow-sm overflow-x-auto">
          <Table className="w-full min-w-[1200px]">
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40 border-b">
                {(level === "adset" || level === "ad") && (
                  <TableHead className="py-2 w-8">
                    <input
                      type="checkbox"
                      ref={level === "adset" ? adsetCheckRef : adCheckRef}
                      checked={
                        level === "adset"
                          ? visAdsets.length > 0 && selectedAdsetIds.size === visAdsets.length
                          : visAds.length > 0 && selectedAdIds.size === visAds.length
                      }
                      onChange={() => {}}
                      onClick={e => {
                        e.stopPropagation();
                        if (level === "adset") {
                          setSelectedAdsetIds(prev =>
                            prev.size === visAdsets.length ? new Set() : new Set(visAdsets.map(a => a.id))
                          );
                        } else {
                          setSelectedAdIds(prev =>
                            prev.size === visAds.length ? new Set() : new Set(visAds.map(a => a.id))
                          );
                        }
                      }}
                      className="cursor-pointer"
                    />
                  </TableHead>
                )}
                <TableHead
                  className={`py-2 text-[10px] font-semibold min-w-[240px] cursor-pointer select-none hover:text-foreground ${sort?.key === "name" ? "text-primary" : ""}`}
                  onClick={() => toggleSort("name")}
                >
                  NOMBRE{sort?.key === "name" ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                </TableHead>
                {metricHeaders}
                <TableHead className="py-2 text-[10px] font-semibold w-28">STATUS</TableHead>
                {level !== "ad" && <TableHead className="py-2 text-[10px] font-semibold w-20">PRESUP.</TableHead>}
                {level === "ad" && <TableHead className="py-2 text-[10px] font-semibold w-20">CREATIVE</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>

              {/* ── CAMPAÑAS */}
              {level === "campaign" && (
                visCampaigns.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={16} className="text-center py-12 text-muted-foreground text-sm">
                      Sin campañas{statusFilter !== "ALL" ? ` (filtro: ${statusFilter})` : ""}
                    </TableCell>
                  </TableRow>
                ) : visCampaigns.map(c => {
                  const ins = insightsMap[c.id];
                  return (
                    <TableRow key={c.id} className={`cursor-pointer ${rowColorClass(ins, !loadingInsights)}`} onClick={() => drillAdsets(c)}>
                      <TableCell className="py-2 min-w-[240px]">
                        <div className="flex items-center gap-1">
                          <p className="font-medium text-xs leading-tight truncate hover:text-primary transition-colors flex-1" title={c.name}>{c.name}</p>
                          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 shrink-0 opacity-50 hover:opacity-100"
                            onClick={e => { e.stopPropagation(); setDuplicateTarget(c); }}>
                            <Copy className="h-3 w-3" />
                          </Button>
                        </div>
                      </TableCell>
                      <MetricCells ins={ins} loading={loadingInsights} />
                      <TableCell className="py-2" onClick={e => e.stopPropagation()}>
                        <StatusCell entityId={c.id} status={c.status} entityType="campaign"
                          accountId={accountId ?? ""} loadingSet={loadingStatus} onToggle={toggleStatus} />
                      </TableCell>
                      <TableCell className="py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {fmtBudget(c.daily_budget ?? c.lifetime_budget)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}

              {/* ── AD SETS */}
              {level === "adset" && (
                visAdsets.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={16} className="text-center py-12 text-muted-foreground text-sm">
                      Sin ad sets{statusFilter !== "ALL" ? ` (filtro: ${statusFilter})` : ""}
                    </TableCell>
                  </TableRow>
                ) : visAdsets.map(a => {
                  const ins = insightsMap[a.id];
                  const checked = selectedAdsetIds.has(a.id);
                  return (
                    <TableRow key={a.id} className={`cursor-pointer ${rowColorClass(ins, !loadingInsights)}`} onClick={() => drillAds(a)}>
                      <TableCell className="py-2 w-8" onClick={e => {
                        e.stopPropagation();
                        setSelectedAdsetIds(prev => { const n = new Set(prev); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n; });
                      }}>
                        <input type="checkbox" checked={checked} onChange={() => {}} className="cursor-pointer" />
                      </TableCell>
                      <TableCell className="py-2 min-w-[240px]">
                        <p className="font-medium text-xs leading-tight truncate hover:text-primary transition-colors" title={a.name}>{a.name}</p>
                      </TableCell>
                      <MetricCells ins={ins} loading={loadingInsights} />
                      <TableCell className="py-2" onClick={e => e.stopPropagation()}>
                        <StatusCell entityId={a.id} status={a.status} entityType="adset"
                          accountId={accountId ?? ""} loadingSet={loadingStatus} onToggle={toggleStatus} />
                      </TableCell>
                      <TableCell className="py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {fmtBudget(a.daily_budget ?? a.lifetime_budget)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}

              {/* ── ADS */}
              {level === "ad" && (
                visAds.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={16} className="text-center py-12 text-muted-foreground text-sm">
                      Sin anuncios{statusFilter !== "ALL" ? ` (filtro: ${statusFilter})` : ""}
                    </TableCell>
                  </TableRow>
                ) : visAds.map(ad => {
                  const ins = insightsMap[ad.id];
                  const checked = selectedAdIds.has(ad.id);
                  return (
                    <TableRow key={ad.id} className={rowColorClass(ins, !loadingInsights)}>
                      <TableCell className="py-2 w-8" onClick={e => {
                        e.stopPropagation();
                        setSelectedAdIds(prev => { const n = new Set(prev); n.has(ad.id) ? n.delete(ad.id) : n.add(ad.id); return n; });
                      }}>
                        <input type="checkbox" checked={checked} onChange={() => {}} className="cursor-pointer" />
                      </TableCell>
                      <TableCell className="py-2 min-w-[240px]">
                        <p className="font-medium text-xs leading-tight truncate" title={ad.name}>{ad.name}</p>
                      </TableCell>
                      <MetricCells ins={ins} loading={loadingInsights} />
                      <TableCell className="py-2" onClick={e => e.stopPropagation()}>
                        <StatusCell entityId={ad.id} status={ad.status} entityType="ad"
                          accountId={accountId ?? ""} loadingSet={loadingStatus} onToggle={toggleStatus} />
                      </TableCell>
                      <TableCell className="py-2 text-[10px] text-muted-foreground font-mono truncate max-w-[80px]">
                        {ad.creative_id ?? "—"}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}

            </TableBody>
          </Table>
        </div>
      )}

      {/* Load more */}
      {level === "campaign" && nextCursor && !loadingData && (
        <div className="flex justify-center pt-2">
          <Button variant="outline" size="sm" onClick={() => loadCampaigns(false, nextCursor!)} disabled={loadingMore}>
            {loadingMore && <RefreshCw className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Cargar más
          </Button>
        </div>
      )}

      {/* Modales */}
      {duplicateTarget && (
        <DuplicateCampaignModal
          campaign={duplicateTarget} accountId={accountId ?? ""} bmId={bmId}
          onClose={() => setDuplicateTarget(null)}
          onSuccess={() => setDuplicateTarget(null)}
        />
      )}

      {showDuplicateAdsetsModal && accountId && (
        <DuplicateAdsetsModal
          selectedAdsets={adsets.filter(a => selectedAdsetIds.has(a.id))}
          accountId={accountId} bmId={bmId}
          onClose={() => setShowDuplicateAdsetsModal(false)}
          onSuccess={() => { setShowDuplicateAdsetsModal(false); setSelectedAdsetIds(new Set()); }}
        />
      )}

      {showDuplicateAdsModal && accountId && (
        <DuplicateAdsModal
          selectedAds={ads.filter(a => selectedAdIds.has(a.id)).map(a => ({ name: a.name, creativeId: a.creative_id ?? "" })).filter(a => a.creativeId)}
          accountId={accountId} bmId={bmId}
          onClose={() => setShowDuplicateAdsModal(false)}
          onSuccess={() => { setShowDuplicateAdsModal(false); setSelectedAdIds(new Set()); }}
        />
      )}
    </div>
  );
}

// ─── Vista GLOBAL: campañas de TODAS las cuentas (carga progresiva) ─────────────
interface GAcct { id: string; name: string; account_status: number; bmId: string }
interface GRow { camp: Campaign; accId: string; accName: string; bmId: string }

function GlobalCampaignsView() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<GAcct[]>([]);
  const [rows, setRows] = useState<GRow[]>([]);
  const [insMap, setInsMap] = useState<Record<string, Insights>>({});
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [loading, setLoading] = useState(true);
  const [datePreset, setDatePreset] = useState("last_7d");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ACTIVE");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>({ key: "spend", dir: "desc" });
  // Invalida corridas viejas (StrictMode monta el efecto 2× en dev y dispararía cargas duplicadas).
  const runId = useRef(0);

  const run = useCallback(async () => {
    const myRun = ++runId.current;
    setLoading(true); setRows([]); setInsMap({}); setDone(0);
    let accs: GAcct[] = [];
    try { accs = ((await fetch("/api/meta/accounts").then(r => r.json())).accounts ?? []) as GAcct[]; } catch { }
    if (myRun !== runId.current) return; // otra corrida la reemplazó
    setAccounts(accs);
    const active = accs.filter(a => a.account_status === 1);
    setTotal(active.length);
    // Progresivo: cada cuenta agrega sus campañas+insights apenas llega (rate-limit es por cuenta).
    await Promise.all(active.map(async (acc) => {
      const rawId = acc.id.replace("act_", "");
      try {
        const [cj, ij] = await Promise.all([
          fetch(`/api/meta/campaigns?accountId=${rawId}&bmId=${acc.bmId}`).then(r => r.json()),
          fetch(`/api/meta/insights?accountId=${rawId}&level=campaign&datePreset=${datePreset}&bmId=${acc.bmId}`).then(r => r.json()),
        ]);
        if (myRun !== runId.current) return; // descartar respuestas de corrida obsoleta
        const camps: Campaign[] = cj.campaigns ?? [];
        const ins: Array<Insights & { campaign_id?: string }> = ij.data ?? [];
        if (ins.length) setInsMap(prev => { const n = { ...prev }; for (const it of ins) if (it.campaign_id) n[it.campaign_id] = it; return n; });
        if (camps.length) setRows(prev => {
          // dedupe por accId:campId (misma cuenta puede aparecer en 2 BMs)
          const seen = new Set(prev.map(r => `${r.accId}:${r.camp.id}`));
          const fresh = camps
            .filter(c => !seen.has(`${rawId}:${c.id}`))
            .map(c => ({ camp: c, accId: rawId, accName: acc.name, bmId: acc.bmId }));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
      } catch { }
      if (myRun === runId.current) setDone(d => d + 1);
    }));
    if (myRun === runId.current) setLoading(false);
  }, [datePreset]);

  useEffect(() => { run(); }, [run]);

  const toggleSort = (key: string) => setSort(s => s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });

  const q = query.toLowerCase().trim();
  let vis = rows.filter(r =>
    (statusFilter === "ALL" || r.camp.status === statusFilter) &&
    (!q || r.camp.name.toLowerCase().includes(q) || r.accName.toLowerCase().includes(q))
  );
  if (sort) {
    const dir = sort.dir === "asc" ? 1 : -1;
    const val = (r: GRow): number | string => {
      if (sort.key === "name") return r.camp.name.toLowerCase();
      if (sort.key === "account") return r.accName.toLowerCase();
      const m = calcMetrics(insMap[r.camp.id]) as Record<string, number | null> | null;
      const v = m ? m[sort.key] : null;
      return v == null ? -Infinity : v;
    };
    vis = [...vis].sort((a, b) => {
      const va = val(a), vb = val(b);
      return typeof va === "string" && typeof vb === "string" ? va.localeCompare(vb) * dir : ((va as number) - (vb as number)) * dir;
    });
  }

  const arrow = (key: string) => sort?.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
  const sh = (key: string, label: string, w: string) => (
    <TableHead className={`py-2 text-[10px] font-semibold text-right ${w} cursor-pointer select-none hover:text-foreground ${sort?.key === key ? "text-primary" : ""}`} onClick={() => toggleSort(key)}>
      <span className="inline-flex items-center justify-end gap-0.5">{label}{arrow(key)}</span>
    </TableHead>
  );

  return (
    <div className="space-y-0">
      <div className="flex items-center gap-2 pb-2 flex-wrap">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <span className="font-semibold text-sm">Todas las cuentas</span>
        <Select value="" onValueChange={(v) => { const a = accounts.find(x => x.id === v); if (a) router.push(`/meta/campaigns?accountId=${a.id.replace("act_", "")}&bmId=${a.bmId}`); }}>
          <SelectTrigger className="h-7 text-xs w-52 ml-1"><SelectValue placeholder="Ver una cuenta…">Ver una cuenta…</SelectValue></SelectTrigger>
          <SelectContent>
            {accounts.map(a => <SelectItem key={a.id} value={a.id} className="text-xs">{a.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <TrendingUp className={`h-3.5 w-3.5 ${loading ? "animate-pulse text-primary" : "text-muted-foreground/40"}`} />
          <Select value={datePreset} onValueChange={v => v && setDatePreset(v)}>
            <SelectTrigger className="h-7 text-xs w-24 border-0 shadow-none"><SelectValue /></SelectTrigger>
            <SelectContent>{DATE_PRESETS.map(p => <SelectItem key={p.value} value={p.value} className="text-xs">{p.label}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={run} disabled={loading}><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /></Button>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-1 pb-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Buscar campaña o cuenta..." className="pl-8 h-8 text-sm w-56 bg-white" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={v => v && setStatusFilter(v)}>
          <SelectTrigger className="h-8 w-32 text-xs bg-white"><SelectValue /></SelectTrigger>
          <SelectContent>{STATUS_OPTS.map(o => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}</SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground ml-1">
          {loading ? `Cargando ${done}/${total} cuentas…` : `${vis.length} campañas · ${total} cuentas`}
        </span>
      </div>

      <Table>
        <TableHeader>
          <TableRow className="border-b">
            <TableHead className={`py-2 text-[10px] font-semibold min-w-[220px] cursor-pointer select-none hover:text-foreground ${sort?.key === "name" ? "text-primary" : ""}`} onClick={() => toggleSort("name")}>NOMBRE{arrow("name")}</TableHead>
            <TableHead className={`py-2 text-[10px] font-semibold min-w-[140px] cursor-pointer select-none hover:text-foreground ${sort?.key === "account" ? "text-primary" : ""}`} onClick={() => toggleSort("account")}>CUENTA{arrow("account")}</TableHead>
            {sh("sales", "SALES", "w-12")}{sh("spend", "SPEND", "w-20")}{sh("revenue", "REVENUE", "w-20")}{sh("profit", "PROFIT", "w-20")}{sh("cpa", "CPA", "w-20")}{sh("roi", "ROI", "w-14")}{sh("cpm", "CPM", "w-20")}{sh("cpc", "CPC", "w-20")}{sh("ctr", "CTR", "w-14")}{sh("uctr", "U-CTR", "w-14")}{sh("ic", "IC", "w-16")}{sh("costPerIc", "$/IC", "w-20")}
          </TableRow>
        </TableHeader>
        <TableBody>
          {vis.length === 0 ? (
            <TableRow><TableCell colSpan={14} className="text-center py-16 text-muted-foreground text-sm">{loading ? "Cargando…" : "Sin campañas"}</TableCell></TableRow>
          ) : vis.map(r => {
            const ins = insMap[r.camp.id];
            const m = calcMetrics(ins);
            return (
              <TableRow key={`${r.accId}:${r.camp.id}`} className={`cursor-pointer ${rowColorClass(ins, true)}`} onClick={() => router.push(`/meta/campaigns?accountId=${r.accId}&bmId=${r.bmId}`)}>
                <TableCell className="py-2"><span className="text-xs font-medium line-clamp-1">{r.camp.name}</span></TableCell>
                <TableCell className="py-2"><span className="text-[11px] text-muted-foreground line-clamp-1">{r.accName}</span></TableCell>
                <TableCell className="py-2 text-right"><MC v={fmtI(m?.sales ?? 0)} loading={false} /></TableCell>
                <TableCell className="py-2 text-right"><MC v={fmtC(m?.spend ?? 0)} loading={false} /></TableCell>
                <TableCell className="py-2 text-right"><MC v={fmtC(m?.revenue ?? 0)} loading={false} /></TableCell>
                <TableCell className="py-2 text-right"><ProfitCell v={m?.profit ?? 0} loading={false} /></TableCell>
                <TableCell className="py-2 text-right"><MC v={fmtC(m?.cpa ?? 0)} loading={false} /></TableCell>
                <TableCell className="py-2 text-right"><RoiCell v={m?.roi ?? 0} loading={false} /></TableCell>
                <TableCell className="py-2 text-right"><MC v={fmtC(m?.cpm ?? 0)} loading={false} /></TableCell>
                <TableCell className="py-2 text-right"><MC v={fmtC(m?.cpc ?? 0)} loading={false} /></TableCell>
                <TableCell className="py-2 text-right"><MC v={fmtP(m?.ctr ?? 0)} loading={false} /></TableCell>
                <TableCell className="py-2 text-right"><MC v={fmtP(m?.uctr ?? 0)} loading={false} /></TableCell>
                <TableCell className="py-2 text-right"><MC v={fmtI(m?.ic ?? 0)} loading={false} /></TableCell>
                <TableCell className="py-2 text-right"><MC v={fmtC(m?.costPerIc ?? 0)} loading={false} /></TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

export default function CampaignsView() {

  return (
    <Suspense fallback={
      <div className="space-y-1.5 pt-4">
        {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 rounded" />)}
      </div>
    }>
      <ManagerInner />
    </Suspense>
  );
}
