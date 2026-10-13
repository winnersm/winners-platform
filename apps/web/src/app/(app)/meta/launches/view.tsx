"use client";

import { useState, useEffect, useRef } from "react";
import { Rocket, Plus, Trash2, Search, Contact, Check, Loader2, CloudCheck, CopyPlus, Copy, ExternalLink, Link2, X, Pencil } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FreeSheetGrid, type FreeColumn } from "./free-sheet";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

// ─── Columnas de la hoja de lanzamientos ─────────────────────────────────────
interface Column { key: string; label: string; w: number; }
const COLUMNS: Column[] = [
  { key: "mlaNombre", label: "MLA Nombre", w: 150 },
  { key: "businessName", label: "Business Name", w: 150 },
  { key: "businessId", label: "Business ID", w: 140 },
  { key: "adAccount", label: "Ad account", w: 160 },
  { key: "fanPage", label: "Fan Page", w: 180 },
  { key: "fanPageBm", label: "BM FanPage", w: 150 },
  { key: "nameAds", label: "Name Ads", w: 150 },
  { key: "oferta", label: "Oferta", w: 80 },
  { key: "tipoAnuncio", label: "Tipo Anuncio", w: 110 },
  { key: "strategy", label: "Strategy", w: 120 },
  { key: "dominios", label: "Dominios", w: 150 },
  { key: "urlLanzar", label: "URL para Lanzar", w: 200 },
  { key: "suffixUrl", label: "Suffix URL", w: 200 },
  { key: "nombrePixel", label: "Nombre Pixel", w: 140 },
  { key: "pixelId", label: "Pixel ID", w: 140 },
  { key: "token", label: "Token", w: 180 },
  { key: "notes", label: "Notes", w: 220 },
];
const STATUS_W = 120;
const ACTIONS_W = 72;

// Tinte de fila según el estado.
const STATUS_TINT: Record<string, string> = {
  pendiente: "bg-yellow-50",
  borrador: "bg-gray-50",
  listo: "bg-sky-50",
  lanzado: "bg-indigo-50",
  activo: "bg-green-50",
  pausado: "bg-amber-50",
  ganador: "bg-emerald-50",
  muerto: "bg-red-50",
};

// Estados de lanzamiento (provisionales — ajustamos a tu flujo real)
const STATUS_OPTS = [
  { value: "pendiente", label: "Pendiente", color: "bg-yellow-500" },
  { value: "borrador", label: "Borrador", color: "bg-gray-400" },
  { value: "listo", label: "Listo", color: "bg-blue-500" },
  { value: "lanzado", label: "Lanzado", color: "bg-indigo-500" },
  { value: "activo", label: "Activo", color: "bg-green-500" },
  { value: "pausado", label: "Pausado", color: "bg-yellow-500" },
  { value: "ganador", label: "Ganador", color: "bg-emerald-600" },
  { value: "muerto", label: "Muerto", color: "bg-red-500" },
];

type Row = { id: string } & Record<string, string>;
interface Sheet { id: string; name: string; sortOrder: number; kind?: string; columns?: FreeColumn[] | null; }

interface Fanpage { id: string; name: string; bm: { id: string; name: string } | null; }

// Celda "Name Ads": modal con nombre + URL del creativo. La celda muestra el nombre + abrir.
function NameAdsCell({
  name, url, onChange,
}: { name: string; url: string; onChange: (name: string, url: string) => void }) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(name);
  const [u, setU] = useState(url);
  function openModal() { setN(name); setU(url); setOpen(true); }
  function save() { onChange(n.trim(), u.trim()); setOpen(false); }

  return (
    <div className="flex items-center gap-1 w-full">
      <button
        onClick={openModal}
        className="min-w-0 flex-1 text-left text-xs truncate hover:text-primary"
        title={url ? `${name}\n${url}` : "Agregar creativo"}
      >
        {name || <span className="text-muted-foreground/40">+ creativo</span>}
      </button>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
          className="p-1 text-muted-foreground hover:text-primary shrink-0" title="Abrir creativo en nueva pestaña">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Link2 className="h-4 w-4" /> Creativo</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">Nombre del creativo</label>
              <Input autoFocus value={n} onChange={(e) => setN(e.target.value)} placeholder="Ej. 2605_L03_V1.mp4" className="text-xs" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">URL del creativo (video o imagen)</label>
              <Input value={u} onChange={(e) => setU(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); }} placeholder="https://…" className="text-xs" />
            </div>
          </div>
          <DialogFooter>
            {url && <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1 mr-auto"><ExternalLink className="h-3.5 w-3.5" /> Abrir actual</a>}
            <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={save}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Botón para copiar un valor al portapapeles (con feedback ✓).
function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1000); }}
      className="p-1 text-muted-foreground hover:text-primary shrink-0"
      title="Copiar nombre + ID"
    >
      {ok ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

// Selector de Fan Page en 2 pasos (BM → página) con etiqueta "En uso".
function FanPagePicker({
  fanpages, valueId, valueName, usedIds, onSelect, onClear,
}: {
  fanpages: Fanpage[];
  valueId: string;
  valueName: string;
  usedIds: Set<string>;
  onSelect: (id: string, name: string, bmName: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [bm, setBm] = useState("");
  const [q, setQ] = useState("");

  const bms = Array.from(new Map(fanpages.filter((f) => f.bm).map((f) => [f.bm!.id, f.bm!.name])).entries())
    .sort((a, b) => a[1].localeCompare(b[1], "es"));
  const qq = q.toLowerCase().trim();
  const list = fanpages
    .filter((f) => f.bm?.id === bm && (!qq || f.name.toLowerCase().includes(qq)))
    .sort((a, b) => a.name.localeCompare(b.name, "es", { numeric: true }));

  return (
    <>
      {valueId ? (
        <div className="w-full flex items-center gap-1">
          <button
            onClick={() => setOpen(true)}
            className="min-w-0 flex-1 text-left rounded border border-input hover:border-primary bg-white px-2 py-1"
            title="Cambiar Fan Page"
          >
            <span className="block truncate text-xs">{valueName}</span>
            <span className="block truncate text-[10px] text-muted-foreground font-mono">{valueId}</span>
          </button>
          <CopyBtn text={`${valueName} - ${valueId}`} />
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="w-full h-8 px-2 text-xs text-left rounded border border-dashed text-muted-foreground hover:border-primary bg-white"
        >
          Seleccionar…
        </button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Contact className="h-4 w-4" /> Seleccionar Fan Page</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs font-medium">1. Business Manager</label>
              <Select value={bm} onValueChange={(v) => { setBm(v ?? ""); setQ(""); }}>
                <SelectTrigger className="h-9 text-xs bg-white">
                  <SelectValue placeholder="Elige un BM…">{bm ? (bms.find(([id]) => id === bm)?.[1] ?? "BM") : undefined}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {bms.length === 0
                    ? <div className="px-2 py-3 text-xs text-muted-foreground">No hay fanpages sincronizadas todavía</div>
                    : bms.map(([id, name]) => <SelectItem key={id} value={id} className="text-xs">{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            {bm && (
              <div className="space-y-1">
                <label className="text-xs font-medium">2. Fan Page ({list.length})</label>
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                  <Input placeholder="Buscar página…" className="pl-8 h-8 text-xs bg-white" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
                <div className="border rounded-md divide-y max-h-64 overflow-y-auto">
                  {list.length === 0
                    ? <div className="px-3 py-4 text-xs text-muted-foreground text-center">Sin páginas</div>
                    : list.map((f) => {
                      const inUse = usedIds.has(f.id) && f.id !== valueId;
                      const selected = f.id === valueId;
                      return (
                        <div key={f.id} className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/40">
                          <button
                            onClick={() => { onSelect(f.id, f.name, f.bm?.name ?? ""); setOpen(false); }}
                            className="flex items-center gap-2 min-w-0 flex-1 text-left"
                          >
                            {selected && <Check className="h-3.5 w-3.5 text-primary shrink-0" />}
                            <span className="min-w-0">
                              <span className="block truncate">{f.name}</span>
                              <span className="block text-[10px] text-muted-foreground font-mono">{f.id}</span>
                            </span>
                          </button>
                          {inUse && <Badge variant="secondary" className="text-[10px] shrink-0 bg-amber-100 text-amber-700">En uso</Badge>}
                          <CopyBtn text={`${f.name} - ${f.id}`} />
                        </div>
                      );
                    })}
                </div>
              </div>
            )}

            {valueId && (
              <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => { onClear(); setOpen(false); }}>
                Quitar selección
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function LaunchesView() {

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [fanpages, setFanpages] = useState<Fanpage[]>([]);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [flashId, setFlashId] = useState<string | null>(null);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [activeSheet, setActiveSheet] = useState<string>("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [sheetToDelete, setSheetToDelete] = useState<Sheet | null>(null);
  const [deletingSheet, setDeletingSheet] = useState(false);

  const pending = useRef<Map<string, Record<string, string>>>(new Map());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Anchos de columna redimensionables (persisten en localStorage).
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    const def: Record<string, number> = { status: STATUS_W };
    for (const c of COLUMNS) def[c.key] = c.w;
    return def;
  });
  useEffect(() => {
    try { const s = localStorage.getItem("launchWidths"); if (s) setWidths((w) => ({ ...w, ...JSON.parse(s) })); } catch {}
  }, []);
  const resizing = useRef<{ key: string; startX: number; startW: number } | null>(null);
  function startResize(e: React.MouseEvent, key: string) {
    e.preventDefault(); e.stopPropagation();
    resizing.current = { key, startX: e.clientX, startW: widths[key] ?? 120 };
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const { key: k, startX, startW } = resizing.current;
      setWidths((w) => ({ ...w, [k]: Math.max(60, startW + (ev.clientX - startX)) }));
    };
    const onUp = () => {
      resizing.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setWidths((w) => { try { localStorage.setItem("launchWidths", JSON.stringify(w)); } catch {} return w; });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  // Cargar filas de lanzamiento de una hoja (solo hojas "launches").
  async function loadRows(sheetId: string) {
    setLoading(true);
    try {
      const j = await fetch(`/api/launches?sheetId=${sheetId}`).then((r) => (r.ok ? r.json() : { launches: [] }));
      setRows(j.launches ?? []);
    } catch { setRows([]); }
    setLoading(false);
  }

  // Abrir una hoja: las libres las maneja FreeSheetGrid; las de lanzamiento cargan aquí.
  async function openSheet(sheet: Sheet) {
    setActiveSheet(sheet.id);
    setQuery("");
    if (sheet.kind === "free") { setRows([]); setLoading(false); }
    else await loadRows(sheet.id);
  }

  // Al montar: cargar hojas (auto-crea "Hoja 1" si no hay) y abrir la primera.
  useEffect(() => {
    (async () => {
      const j = await fetch("/api/launches/sheets").then((r) => (r.ok ? r.json() : { sheets: [] })).catch(() => ({ sheets: [] }));
      const list: Sheet[] = j.sheets ?? [];
      setSheets(list);
      if (list[0]) await openSheet(list[0]);
      else setLoading(false);
    })();
    fetch("/api/fanpages")
      .then((r) => (r.ok ? r.json() : { pages: [] }))
      .then((j) => setFanpages(j.pages ?? []))
      .catch(() => {});
  }, []);

  // Cambiar de hoja.
  async function selectSheet(id: string) {
    if (!id || id === activeSheet) return;
    const sheet = sheets.find((s) => s.id === id);
    if (sheet) await openSheet(sheet);
  }

  async function addSheet() {
    const res = await fetch("/api/launches/sheets", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.sheet) {
      setSheets((s) => [...s, j.sheet]);
      await openSheet(j.sheet);
    } else toast.error(j.error ?? "No se pudo crear la hoja");
  }

  async function renameSheet(id: string, name: string) {
    const nm = name.trim();
    setRenaming(null);
    const cur = sheets.find((s) => s.id === id);
    if (!nm || nm === cur?.name) return;
    setSheets((s) => s.map((x) => (x.id === id ? { ...x, name: nm } : x)));
    await fetch(`/api/launches/sheets/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nm }),
    }).catch(() => {});
  }

  async function confirmDeleteSheet() {
    const id = sheetToDelete?.id;
    if (!id) return;
    setDeletingSheet(true);
    const res = await fetch(`/api/launches/sheets/${id}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    setDeletingSheet(false);
    if (!res.ok) { toast.error(j.error ?? "No se pudo eliminar"); return; }
    const remaining = sheets.filter((s) => s.id !== id);
    setSheets(remaining);
    if (activeSheet === id) {
      if (remaining[0]) await openSheet(remaining[0]);
      else { setActiveSheet(""); setRows([]); }
    }
    setSheetToDelete(null);
    toast.success("Hoja eliminada");
  }

  const usedFanpageIds = new Set(rows.map((r) => r.fanPageId).filter(Boolean) as string[]);

  // Autoguardado: acumula cambios por fila y hace PATCH con debounce.
  function flush(rowId: string) {
    const patch = pending.current.get(rowId);
    if (!patch) return;
    pending.current.delete(rowId);
    setSaveState("saving");
    fetch(`/api/launches/${rowId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    })
      .then((r) => { if (!r.ok) throw new Error(); setSaveState("saved"); })
      .catch(() => { setSaveState("idle"); toast.error("No se pudo guardar"); });
  }
  function scheduleSave(rowId: string, patch: Record<string, string>) {
    pending.current.set(rowId, { ...(pending.current.get(rowId) ?? {}), ...patch });
    const t = timers.current.get(rowId);
    if (t) clearTimeout(t);
    timers.current.set(rowId, setTimeout(() => flush(rowId), 800));
  }

  function setCell(id: string, patch: Record<string, string>) {
    setRows((r) => r.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    scheduleSave(id, patch);
  }
  function updateCell(id: string, key: string, value: string) {
    setCell(id, { [key]: value });
  }

  async function addRow() {
    const res = await fetch("/api/launches", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sheetId: activeSheet }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.launch) setRows((r) => [...r, j.launch]);
    else toast.error(j.error ?? "No se pudo agregar");
  }
  async function removeRow(id: string) {
    setRows((r) => r.filter((row) => row.id !== id));
    await fetch(`/api/launches/${id}`, { method: "DELETE" }).catch(() => {});
  }
  async function duplicateRow(id: string) {
    const res = await fetch(`/api/launches/${id}/duplicate`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.launch) {
      // Insertar la copia justo debajo del original + resaltarla un momento.
      setRows((r) => { const i = r.findIndex((x) => x.id === id); const n = [...r]; n.splice(i + 1, 0, j.launch); return n; });
      setFlashId(j.launch.id);
      setTimeout(() => setFlashId((cur) => (cur === j.launch.id ? null : cur)), 2000);
      toast.success("✓ Copia creada debajo del original");
    } else toast.error(j.error ?? "No se pudo duplicar");
  }

  function updateSheetColumns(sheetId: string, columns: FreeColumn[]) {
    setSheets((s) => s.map((x) => (x.id === sheetId ? { ...x, columns } : x)));
  }

  const activeSheetObj = sheets.find((s) => s.id === activeSheet);
  const isFree = activeSheetObj?.kind === "free";

  const q = query.toLowerCase().trim();
  const visible = q
    ? rows.filter((row) => COLUMNS.some((c) => (row[c.key] ?? "").toLowerCase().includes(q)))
    : rows;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Rocket className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Lanzamientos</h1>
        {!isFree && <span className="text-sm text-muted-foreground">{rows.length} {rows.length === 1 ? "lanzamiento" : "lanzamientos"}</span>}
        {!isFree && saveState === "saving" && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Guardando…</span>}
        {!isFree && saveState === "saved" && <span className="inline-flex items-center gap-1 text-[11px] text-green-600"><CloudCheck className="h-3 w-3" /> Guardado</span>}
      </div>

      {/* Pestañas de hojas */}
      <div className="flex items-stretch gap-1 border-b overflow-x-auto">
        {sheets.map((s) => {
          const active = s.id === activeSheet;
          if (renaming === s.id) {
            return (
              <input
                key={s.id}
                autoFocus
                defaultValue={s.name}
                onBlur={(e) => renameSheet(s.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") { e.currentTarget.value = s.name; setRenaming(null); }
                }}
                className="h-9 w-32 px-2 text-sm rounded-t border border-b-0 border-primary bg-white outline-none"
              />
            );
          }
          return (
            <div
              key={s.id}
              className={`group inline-flex items-center gap-1 px-3 h-9 text-sm border-b-2 -mb-px cursor-pointer whitespace-nowrap transition-colors ${
                active ? "border-primary text-foreground font-medium bg-muted/40 rounded-t" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => selectSheet(s.id)}
              onDoubleClick={() => setRenaming(s.id)}
              title="Doble clic para renombrar"
            >
              {s.name}
              {active && (
                <button
                  onClick={(e) => { e.stopPropagation(); setRenaming(s.id); }}
                  className="ml-0.5 rounded p-0.5 text-muted-foreground/60 hover:text-primary hover:bg-muted"
                  title="Renombrar hoja"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
              {active && s.kind === "free" && (
                <button
                  onClick={(e) => { e.stopPropagation(); setSheetToDelete(s); }}
                  className="rounded p-0.5 text-muted-foreground/60 hover:text-red-600 hover:bg-red-50"
                  title="Eliminar hoja"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          );
        })}
        <button
          onClick={addSheet}
          className="inline-flex items-center gap-1 px-2.5 h-9 text-sm text-muted-foreground hover:text-primary whitespace-nowrap"
          title="Nueva hoja"
        >
          <Plus className="h-4 w-4" /> Hoja
        </button>
      </div>

      {isFree && activeSheetObj ? (
        <FreeSheetGrid
          key={activeSheetObj.id}
          sheetId={activeSheetObj.id}
          initialColumns={(activeSheetObj.columns ?? []) as FreeColumn[]}
          onColumnsChange={(cols) => updateSheetColumns(activeSheetObj.id, cols)}
        />
      ) : (
      <>
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" onClick={addRow}>
          <Plus className="h-4 w-4 mr-1" /> Nueva Celda
        </Button>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar…" className="pl-8 h-9 w-56 bg-white" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      <div className="rounded-lg border bg-white overflow-x-auto">
        <table className="text-sm table-fixed" style={{ width: (widths.status ?? STATUS_W) + COLUMNS.reduce((s, c) => s + (widths[c.key] ?? c.w), 0) + ACTIONS_W }}>
          <colgroup>
            <col style={{ width: ACTIONS_W }} />
            <col style={{ width: widths.status ?? STATUS_W }} />
            {COLUMNS.map((c) => <col key={c.key} style={{ width: widths[c.key] ?? c.w }} />)}
          </colgroup>
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="px-2 py-2"></th>
              <th className="relative px-2 py-2 text-[10px] font-semibold text-left select-none">
                Status
                <span onMouseDown={(e) => startResize(e, "status")} className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40" />
              </th>
              {COLUMNS.map((c) => (
                <th key={c.key} className="relative px-2 py-2 text-[10px] font-semibold text-left whitespace-nowrap overflow-hidden select-none">
                  {c.label}
                  <span onMouseDown={(e) => startResize(e, c.key)} className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={COLUMNS.length + 2} className="p-3"><Skeleton className="h-8 w-full" /></td></tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 2} className="text-center py-16 text-muted-foreground text-sm">
                  {rows.length === 0 ? "Sin lanzamientos aún — agrega el primero." : "Nada coincide con la búsqueda."}
                </td>
              </tr>
            ) : visible.map((row) => (
              <tr key={row.id} className={`border-b hover:brightness-95 transition-all duration-700 ${STATUS_TINT[row.status] ?? ""} ${flashId === row.id ? "ring-2 ring-inset ring-blue-500 bg-blue-100/50" : ""}`}>
                <td className="px-1 py-1">
                  <div className="flex items-center gap-0.5">
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-primary" onClick={() => duplicateRow(row.id)} title="Duplicar lanzamiento">
                      <CopyPlus className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-red-600" onClick={() => removeRow(row.id)} title="Eliminar fila">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
                <td className="px-2 py-1">
                  <Select value={row.status} onValueChange={(v) => v && updateCell(row.id, "status", v)}>
                    <SelectTrigger className="h-8 w-28 text-xs">
                      <SelectValue>
                        <span className="inline-flex items-center gap-1.5">
                          <span className={`inline-block w-2 h-2 rounded-full ${STATUS_OPTS.find((s) => s.value === row.status)?.color ?? "bg-gray-300"}`} />
                          {STATUS_OPTS.find((s) => s.value === row.status)?.label ?? "—"}
                        </span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTS.map((s) => (
                        <SelectItem key={s.value} value={s.value} className="text-xs">
                          <span className="inline-flex items-center gap-1.5"><span className={`inline-block w-2 h-2 rounded-full ${s.color}`} />{s.label}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                {COLUMNS.map((c) => (
                  <td key={c.key} className="px-1 py-1">
                    {c.key === "nameAds" ? (
                      <NameAdsCell
                        name={row.nameAds ?? ""}
                        url={row.nameAdsUrl ?? ""}
                        onChange={(nm, u) => setCell(row.id, { nameAds: nm, nameAdsUrl: u })}
                      />
                    ) : c.key === "fanPageBm" ? (
                      <span className={`flex items-center w-full h-8 px-2 text-xs truncate ${row.fanPageBm ? "text-muted-foreground" : "text-muted-foreground/40"}`} title={row.fanPageBm || ""}>
                        {row.fanPageBm || "—"}
                      </span>
                    ) : c.key === "fanPage" ? (
                      <FanPagePicker
                        fanpages={fanpages}
                        valueId={row.fanPageId ?? ""}
                        valueName={row.fanPage ?? ""}
                        usedIds={usedFanpageIds}
                        onSelect={(id, name, bmName) => setCell(row.id, { fanPageId: id, fanPage: name, fanPageBm: bmName })}
                        onClear={() => setCell(row.id, { fanPageId: "", fanPage: "", fanPageBm: "" })}
                      />
                    ) : (
                      <Input
                        value={row[c.key] ?? ""}
                        onChange={(e) => updateCell(row.id, c.key, e.target.value)}
                        className="h-8 text-xs w-full border-transparent hover:border-input focus:border-input bg-transparent"
                      />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground/70">
        Los cambios se guardan solos. El <strong>Token</strong> se almacena cifrado.
      </p>
      </>
      )}

      <ConfirmDialog
        open={!!sheetToDelete}
        onOpenChange={(v) => { if (!v) setSheetToDelete(null); }}
        destructive
        title="Eliminar hoja"
        description="Se eliminará la hoja y TODOS sus lanzamientos. Esta acción no se puede deshacer."
        detail={sheetToDelete ? <span className="font-medium">{sheetToDelete.name}</span> : null}
        confirmLabel="Sí, eliminar"
        cancelLabel="Volver"
        loading={deletingSheet}
        onConfirm={confirmDeleteSheet}
      />
    </div>
  );
}
