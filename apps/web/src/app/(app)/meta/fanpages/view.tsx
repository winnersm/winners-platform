"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Contact, RefreshCw, Search, ArrowDownAZ, ArrowUpZA, Copy, Check,
  KeyRound, Loader2, Sparkles, Download, ShieldCheck, Megaphone, ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

interface FanPage {
  id: string;
  name: string;
  category: string | null;
  picture: string | null;
  tasks: string[];
  igReal: string | null;
  igId: string | null;   // PBIA guardado en DB
  pbiaCheckedAt: string | null;
  isPublished: boolean | null;
  verificationStatus: string | null;
  activeAds: number | null;
  adsSyncedAt: string | null;
  bm: { id: string; name: string } | null;
}

// undefined = sin verificar · null = no tiene · string = ig_id
type PbiaState = Record<string, string | null | undefined>;

// ─── Setup del token (cuando no hay ninguno configurado) ─────────────────────
function TokenSetup({ onSaved }: { onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!token.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/fanpages/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), name: name.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Error al guardar"); return; }
      toast.success(`Token de Fanpages guardado (${json.name})`);
      onSaved();
    } catch {
      toast.error("Error de red");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-lg mx-auto mt-10 border rounded-xl bg-white p-6 space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-primary" />
        <h2 className="font-semibold">Conectar token de Fanpages</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Este token es <strong>exclusivo</strong> para la sección Fanpages (listar páginas y gestionar PBIA).
        No se mezcla con los Business Managers. Necesita los permisos <code>pages_show_list</code>,{" "}
        <code>pages_read_engagement</code> y <code>business_management</code>.
      </p>
      <div className="space-y-1.5">
        <label className="text-xs font-medium">Nombre (opcional)</label>
        <Input placeholder="Ej. Fanpages Indonesia" value={name} onChange={(e) => setName(e.target.value)} className="bg-white" />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium">Access Token</label>
        <Input placeholder="EAA..." value={token} onChange={(e) => setToken(e.target.value)} className="bg-white font-mono text-xs" />
      </div>
      <Button onClick={save} disabled={saving || !token.trim()} className="w-full">
        {saving ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Validando…</> : "Guardar token"}
      </Button>
    </div>
  );
}

// ─── Cambiar el token de Fanpages (cuando ya hay uno configurado) ────────────
function ChangeTokenDialog({ currentName, onSaved }: { currentName: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [name, setName] = useState(currentName);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!token.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/fanpages/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), name: name.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Error al guardar"); return; }
      toast.success(`Token actualizado (${json.name})`);
      setOpen(false); setToken("");
      onSaved();
    } catch {
      toast.error("Error de red");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => { setName(currentName); setToken(""); setOpen(true); }} title="Cambiar el token de Fanpages de esta operación">
        <KeyRound className="h-4 w-4 mr-1" /> Cambiar token
      </Button>
      <Dialog open={open} onOpenChange={(v) => !saving && setOpen(v)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> Cambiar token de Fanpages</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Reemplaza el token de la <strong>operación activa</strong>. Necesita los permisos{" "}
              <code>pages_show_list</code>, <code>pages_read_engagement</code> y <code>business_management</code>.
            </p>
            <div className="space-y-1">
              <label className="text-xs font-medium">Nombre (opcional)</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="bg-white" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Nuevo Access Token</label>
              <Input placeholder="EAA..." value={token} onChange={(e) => setToken(e.target.value)} className="bg-white font-mono text-xs" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancelar</Button>
            <Button onClick={save} disabled={saving || !token.trim()}>
              {saving ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Validando…</> : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Celda de PBIA ───────────────────────────────────────────────────────────
function PbiaCell({ state, onCreate, creating }: { state: string | null | undefined; onCreate: () => void; creating: boolean }) {
  const [copied, setCopied] = useState(false);
  if (state === undefined) return <span className="text-[11px] text-muted-foreground/50">sin verificar</span>;
  if (state === null) {
    return (
      <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={onCreate} disabled={creating}>
        {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1" />}
        Crear PBIA
      </Button>
    );
  }
  return (
    <button
      className="inline-flex items-center gap-1 text-xs font-mono text-green-700 hover:text-green-800"
      title="Copiar ig_id"
      onClick={() => { navigator.clipboard.writeText(state); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {state}
    </button>
  );
}

// ─── Página ──────────────────────────────────────────────────────────────────
export default function FanpagesView() {

  const router = useRouter();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [tokenName, setTokenName] = useState<string>("");
  const [pages, setPages] = useState<FanPage[]>([]);
  const [pbia, setPbia] = useState<PbiaState>({});
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncingAds, setSyncingAds] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [bmFilter, setBmFilter] = useState("all");
  const [catFilter, setCatFilter] = useState("all");
  const [pbiaFilter, setPbiaFilter] = useState("all"); // all | yes | no | unchecked
  const [healthFilter, setHealthFilter] = useState("all"); // all | published | unpublished
  const [adsFilter, setAdsFilter] = useState("all"); // all | with | without
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [bulking, setBulking] = useState(false);
  const verifyRun = useRef(0);

  const loadToken = useCallback(async () => {
    const res = await fetch("/api/fanpages/token");
    const json = await res.json();
    setConfigured(!!json.configured);
    setTokenName(json.token?.name ?? "");
  }, []);

  const loadPages = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/fanpages");
      const json = await res.json();
      if (res.status === 409) { setConfigured(false); return; }
      if (!res.ok) { toast.error(json.error ?? "Error"); return; }
      const list: FanPage[] = json.pages ?? [];
      setPages(list);
      setLastSync(json.lastSync ?? null);
      // Estado PBIA inicial desde la DB: string=tiene · null(verificado)=no · undefined=sin verificar
      const init: PbiaState = {};
      for (const p of list) init[p.id] = p.igId ? p.igId : (p.pbiaCheckedAt ? null : undefined);
      setPbia(init);
    } finally {
      setLoading(false);
    }
  }, []);

  // Trae páginas frescas desde Facebook → DB, y recarga.
  const sync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch("/api/fanpages/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Error al sincronizar"); return; }
      toast.success(`Sincronizadas ${json.synced} páginas${json.removed ? ` · ${json.removed} eliminadas (sin acceso)` : ""}`);
      await loadPages();
    } catch {
      toast.error("Error de red");
    } finally {
      setSyncing(false);
    }
  }, [loadPages]);

  // Encola el job que cuenta los ads activos por página (recorre las cuentas).
  const syncAds = useCallback(async () => {
    setSyncingAds(true);
    try {
      const res = await fetch("/api/fanpages/ads/sync", { method: "POST" });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Error"); return; }
      toast.success("Contando ads activos… (job en segundo plano)", {
        action: { label: "Ver trabajos", onClick: () => router.push("/meta/jobs") },
      });
    } catch {
      toast.error("Error de red");
    } finally {
      setSyncingAds(false);
    }
  }, [router]);

  useEffect(() => { loadToken(); }, [loadToken]);
  useEffect(() => { if (configured) loadPages(); }, [configured, loadPages]);

  // Verificar el estado PBIA en lotes (progresivo, cacheado en el server).
  const verifyPbia = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    setVerifying(true);
    const myRun = ++verifyRun.current;
    try {
      for (let i = 0; i < ids.length; i += 50) {
        if (myRun !== verifyRun.current) return;
        const chunk = ids.slice(i, i + 50);
        const res = await fetch(`/api/fanpages/pbia?pageIds=${chunk.join(",")}`);
        const json = await res.json();
        if (json.status) setPbia((prev) => ({ ...prev, ...json.status }));
      }
    } finally {
      if (myRun === verifyRun.current) setVerifying(false);
    }
  }, []);

  // Listas únicas para los dropdowns (ordenadas).
  const bmOptions = Array.from(new Map(pages.filter((p) => p.bm).map((p) => [p.bm!.id, p.bm!.name])).entries())
    .sort((a, b) => a[1].localeCompare(b[1], "es"));
  const catOptions = Array.from(new Set(pages.map((p) => p.category).filter(Boolean) as string[]))
    .sort((a, b) => a.localeCompare(b, "es"));

  const q = query.toLowerCase().trim();
  const visible = pages
    .filter((p) => {
      if (q && !(p.name.toLowerCase().includes(q) || p.id.includes(q))) return false;
      if (bmFilter !== "all" && p.bm?.id !== bmFilter) return false;
      if (catFilter !== "all" && p.category !== catFilter) return false;
      if (pbiaFilter !== "all") {
        const s = pbia[p.id];
        if (pbiaFilter === "yes" && !s) return false;
        if (pbiaFilter === "no" && s !== null) return false;
        if (pbiaFilter === "unchecked" && s !== undefined) return false;
      }
      if (healthFilter === "published" && p.isPublished !== true) return false;
      if (healthFilter === "unpublished" && p.isPublished !== false) return false;
      if (adsFilter === "with" && !(p.activeAds && p.activeAds > 0)) return false;
      if (adsFilter === "without" && !(p.activeAds === 0)) return false;
      return true;
    })
    .sort((a, b) => {
      const c = a.name.localeCompare(b.name, "es", { numeric: true, sensitivity: "base" });
      return sortDir === "asc" ? c : -c;
    });

  function toggle(id: string) {
    setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSel((s) => s.size === visible.length ? new Set() : new Set(visible.map((p) => p.id)));
  }

  async function createOne(pageId: string) {
    setCreatingId(pageId);
    try {
      const res = await fetch("/api/fanpages/pbia", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pageId }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Error al crear PBIA"); return; }
      setPbia((p) => ({ ...p, [pageId]: json.igId }));
      toast.success("PBIA creado");
    } finally {
      setCreatingId(null);
    }
  }

  async function createBulk() {
    // Omitir las que ya tienen PBIA (idempotente igual, pero ahorra trabajo).
    const all = [...sel];
    const ids = all.filter((id) => !pbia[id]);
    const skipped = all.length - ids.length;
    if (ids.length === 0) {
      toast.info(skipped > 0 ? "Todas las seleccionadas ya tienen PBIA" : "No hay páginas seleccionadas");
      return;
    }
    setBulking(true);
    try {
      // El backend limita a 200 por job → dividir en lotes y encolar varios.
      const CHUNK = 200;
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
      let queued = 0;
      for (const c of chunks) {
        const res = await fetch("/api/fanpages/pbia/bulk", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pageIds: c }),
        });
        const json = await res.json();
        if (!res.ok) { toast.error(json.error ?? "Error al encolar"); break; }
        queued += json.count;
      }
      if (queued > 0) {
        toast.success(
          `${chunks.length > 1 ? `${chunks.length} trabajos encolados` : "Trabajo encolado"} — creando PBIA de ${queued} páginas${skipped > 0 ? ` (${skipped} ya tenían)` : ""}`,
          { action: { label: "Ver trabajos", onClick: () => router.push("/meta/jobs") } }
        );
        setSel(new Set());
      }
    } finally {
      setBulking(false);
    }
  }

  function exportCsv() {
    const rows = [["page_id", "name", "ig_id"]];
    for (const p of visible) {
      const ig = pbia[p.id];
      if (ig) rows.push([p.id, p.name, ig]);
    }
    const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url; a.download = "fanpages-pbia.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  if (configured === null) {
    return <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 rounded" />)}</div>;
  }
  if (!configured) return <TokenSetup onSaved={() => { setConfigured(true); loadToken(); }} />;

  const allChecked = visible.length > 0 && sel.size === visible.length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Contact className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Fanpages</h1>
          <span className="text-sm text-muted-foreground">
            {loading ? "Cargando…" : `${visible.length}${visible.length !== pages.length ? ` / ${pages.length}` : ""} páginas`}
          </span>
          {tokenName && <Badge variant="secondary" className="text-[11px] gap-1"><ShieldCheck className="h-3 w-3" />{tokenName}</Badge>}
          {lastSync && <span className="text-[11px] text-muted-foreground/60">· sync {new Date(lastSync).toLocaleString("es-MX", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>}
        </div>
        <div className="flex items-center gap-2">
          <ChangeTokenDialog currentName={tokenName} onSaved={() => { loadToken(); loadPages(); }} />
          <Button variant="outline" size="sm" onClick={() => verifyPbia(visible.map((p) => p.id))} disabled={verifying || loading || pages.length === 0}>
            {verifying ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-1" />}
            Verificar PBIA
          </Button>
          <Button variant="outline" size="sm" onClick={syncAds} disabled={syncingAds || loading || pages.length === 0} title="Contar ads activos por página (recorre las cuentas)">
            {syncingAds ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Megaphone className="h-4 w-4 mr-1" />}
            Ads activos
          </Button>
          <Button variant="outline" size="sm" onClick={exportCsv} title="Exportar página→ig_id (CSV)" disabled={pages.length === 0}>
            <Download className="h-4 w-4" />
          </Button>
          <Button variant="default" size="sm" onClick={sync} disabled={syncing} title="Traer páginas frescas desde Facebook">
            <RefreshCw className={`h-4 w-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Sincronizando…" : "Sincronizar"}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar por nombre o ID…" className="pl-8 h-9 w-72 bg-white" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Button variant="outline" size="sm" onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}>
          {sortDir === "asc" ? <ArrowDownAZ className="h-4 w-4 mr-1" /> : <ArrowUpZA className="h-4 w-4 mr-1" />}
          Nombre {sortDir === "asc" ? "A→Z" : "Z→A"}
        </Button>

        <Select value={bmFilter} onValueChange={(v) => v && setBmFilter(v)}>
          <SelectTrigger className="h-9 w-48 text-xs bg-white">
            <SelectValue>{bmFilter === "all" ? "BM: todos" : (bmOptions.find(([id]) => id === bmFilter)?.[1] ?? "BM")}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">BM: todos</SelectItem>
            {bmOptions.map(([id, name]) => <SelectItem key={id} value={id} className="text-xs">{name}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={catFilter} onValueChange={(v) => v && setCatFilter(v)}>
          <SelectTrigger className="h-9 w-44 text-xs bg-white">
            <SelectValue>{catFilter === "all" ? "Categoría: todas" : catFilter}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">Categoría: todas</SelectItem>
            {catOptions.map((c) => <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>)}
          </SelectContent>
        </Select>

        <Select value={pbiaFilter} onValueChange={(v) => v && setPbiaFilter(v)}>
          <SelectTrigger className="h-9 w-36 text-xs bg-white">
            <SelectValue>{{ all: "PBIA: todas", yes: "Con PBIA", no: "Sin PBIA", unchecked: "Sin verificar" }[pbiaFilter]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">PBIA: todas</SelectItem>
            <SelectItem value="yes" className="text-xs">Con PBIA</SelectItem>
            <SelectItem value="no" className="text-xs">Sin PBIA</SelectItem>
            <SelectItem value="unchecked" className="text-xs">Sin verificar</SelectItem>
          </SelectContent>
        </Select>

        <Select value={healthFilter} onValueChange={(v) => v && setHealthFilter(v)}>
          <SelectTrigger className="h-9 w-36 text-xs bg-white">
            <SelectValue>{{ all: "Estado: todas", published: "Publicadas", unpublished: "Despublicadas" }[healthFilter]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">Estado: todas</SelectItem>
            <SelectItem value="published" className="text-xs">Publicadas</SelectItem>
            <SelectItem value="unpublished" className="text-xs">Despublicadas</SelectItem>
          </SelectContent>
        </Select>

        <Select value={adsFilter} onValueChange={(v) => v && setAdsFilter(v)}>
          <SelectTrigger className="h-9 w-36 text-xs bg-white">
            <SelectValue>{{ all: "Ads: todas", with: "Con ads activos", without: "Sin ads" }[adsFilter]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">Ads: todas</SelectItem>
            <SelectItem value="with" className="text-xs">Con ads activos</SelectItem>
            <SelectItem value="without" className="text-xs">Sin ads</SelectItem>
          </SelectContent>
        </Select>

        {sel.size > 0 && (
          <Button size="sm" onClick={createBulk} disabled={bulking} className="ml-auto">
            {bulking ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Sparkles className="h-4 w-4 mr-1" />}
            Crear PBIA de {sel.size} seleccionada{sel.size > 1 ? "s" : ""}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 rounded" />)}</div>
      ) : pages.length === 0 ? (
        <div className="text-center py-16 space-y-3">
          <p className="text-sm text-muted-foreground">Aún no hay páginas guardadas.</p>
          <Button onClick={sync} disabled={syncing}>
            <RefreshCw className={`h-4 w-4 mr-1 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "Sincronizando…" : "Sincronizar desde Facebook"}
          </Button>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="border-b">
              <TableHead className="w-8 py-2">
                <input type="checkbox" checked={allChecked} onChange={toggleAll} className="cursor-pointer" />
              </TableHead>
              <TableHead className="py-2 text-[10px] font-semibold min-w-[220px]">PÁGINA</TableHead>
              <TableHead className="py-2 text-[10px] font-semibold w-10 text-center">LINK</TableHead>
              <TableHead className="py-2 text-[10px] font-semibold min-w-[150px]">BUSINESS MANAGER</TableHead>
              <TableHead className="py-2 text-[10px] font-semibold min-w-[90px]">ESTADO</TableHead>
              <TableHead className="py-2 text-[10px] font-semibold min-w-[80px] text-right">ADS ACT.</TableHead>
              <TableHead className="py-2 text-[10px] font-semibold min-w-[130px]">CATEGORÍA</TableHead>
              <TableHead className="py-2 text-[10px] font-semibold min-w-[180px]">PBIA (ig_id)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center py-16 text-muted-foreground text-sm">Sin páginas</TableCell></TableRow>
            ) : visible.map((p) => (
              <TableRow key={p.id} className={sel.has(p.id) ? "bg-primary/5" : ""}>
                <TableCell className="py-2">
                  <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} className="cursor-pointer" />
                </TableCell>
                <TableCell className="py-2">
                  <div className="flex items-center gap-2">
                    {p.picture
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <img src={p.picture} alt="" className="h-7 w-7 rounded-full object-cover shrink-0" />
                      : <div className="h-7 w-7 rounded-full bg-muted shrink-0 flex items-center justify-center"><Contact className="h-3.5 w-3.5 text-muted-foreground" /></div>}
                    <div className="min-w-0">
                      <div className="text-xs font-medium line-clamp-1">{p.name}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">{p.id}{p.igReal ? ` · IG real @${p.igReal}` : ""}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="py-2 text-center">
                  <a
                    href={`https://www.facebook.com/profile.php?id=${p.id}`}
                    target="_blank" rel="noopener noreferrer"
                    className="inline-flex text-muted-foreground hover:text-primary"
                    title="Abrir fanpage en Facebook"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </TableCell>
                <TableCell className="py-2">
                  {p.bm
                    ? <button className="text-[11px] text-left hover:text-primary line-clamp-1" title={`Filtrar por ${p.bm.name}`} onClick={() => setBmFilter(p.bm!.id)}>{p.bm.name}</button>
                    : <span className="text-[11px] text-muted-foreground/50">—</span>}
                </TableCell>
                <TableCell className="py-2">
                  {p.isPublished === null
                    ? <span className="text-[11px] text-muted-foreground/50">—</span>
                    : (
                      <span className="inline-flex items-center gap-1 text-[11px]" title={p.verificationStatus === "not_verified" ? "No verificada" : (p.verificationStatus ?? "")}>
                        <span className={`inline-block w-2 h-2 rounded-full ${p.isPublished ? "bg-green-500" : "bg-red-500"}`} />
                        {p.isPublished ? "Publicada" : "Despublicada"}
                        {p.verificationStatus && p.verificationStatus !== "not_verified" && <ShieldCheck className="h-3 w-3 text-blue-500" />}
                      </span>
                    )}
                </TableCell>
                <TableCell className="py-2 text-right">
                  {p.activeAds == null
                    ? <span className="text-[11px] text-muted-foreground/50">—</span>
                    : <span className={`text-xs tabular-nums font-medium ${p.activeAds > 0 ? "text-green-700" : "text-muted-foreground/60"}`}>{p.activeAds}</span>}
                </TableCell>
                <TableCell className="py-2"><span className="text-[11px] text-muted-foreground">{p.category ?? "—"}</span></TableCell>
                <TableCell className="py-2">
                  <PbiaCell state={pbia[p.id]} onCreate={() => createOne(p.id)} creating={creatingId === p.id} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
