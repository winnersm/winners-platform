"use client";

import { useState, useEffect, useRef } from "react";
import { Plus, Trash2, X, Search, Columns3, Loader2, CloudCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

export interface FreeColumn { id: string; name: string; w: number; }
type FreeRow = { id: string; data: Record<string, string>; sortOrder: number };

const ACTIONS_W = 44;

export function FreeSheetGrid({
  sheetId, initialColumns, onColumnsChange,
}: {
  sheetId: string;
  initialColumns: FreeColumn[];
  onColumnsChange: (cols: FreeColumn[]) => void; // sincroniza el estado del padre (sin fetch)
}) {
  const [cols, setCols] = useState<FreeColumn[]>(initialColumns);
  const [rows, setRows] = useState<FreeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [renamingCol, setRenamingCol] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  const pending = useRef<Map<string, Record<string, string>>>(new Map());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const colTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-sembrar columnas y recargar filas al cambiar de hoja.
  useEffect(() => { setCols(initialColumns); }, [sheetId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setLoading(true);
    fetch(`/api/launches/sheets/${sheetId}/rows`)
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((j) => setRows(j.rows ?? []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [sheetId]);

  // ─── Autoguardado de celdas ───
  function flush(rowId: string) {
    const patch = pending.current.get(rowId);
    if (!patch) return;
    pending.current.delete(rowId);
    setSaveState("saving");
    fetch(`/api/launches/sheets/rows/${rowId}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: patch }),
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
  function setCell(rowId: string, colId: string, value: string) {
    setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, data: { ...r.data, [colId]: value } } : r)));
    scheduleSave(rowId, { [colId]: value });
  }

  async function addRow() {
    const res = await fetch(`/api/launches/sheets/${sheetId}/rows`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.row) setRows((rs) => [...rs, j.row]);
    else toast.error(j.error ?? "No se pudo agregar");
  }
  async function removeRow(id: string) {
    setRows((rs) => rs.filter((r) => r.id !== id));
    await fetch(`/api/launches/sheets/rows/${id}`, { method: "DELETE" }).catch(() => {});
  }

  // ─── Columnas (persisten con debounce) ───
  function commitCols(next: FreeColumn[]) {
    setCols(next);
    onColumnsChange(next);
    setSaveState("saving");
    if (colTimer.current) clearTimeout(colTimer.current);
    colTimer.current = setTimeout(() => {
      fetch(`/api/launches/sheets/${sheetId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ columns: next }),
      })
        .then((r) => { if (!r.ok) throw new Error(); setSaveState("saved"); })
        .catch(() => { setSaveState("idle"); toast.error("No se pudieron guardar las columnas"); });
    }, 500);
  }
  function addColumn() {
    commitCols([...cols, { id: crypto.randomUUID(), name: `Columna ${cols.length + 1}`, w: 180 }]);
  }
  function renameColumn(id: string, name: string) {
    setRenamingCol(null);
    const nm = name.trim();
    const cur = cols.find((c) => c.id === id);
    if (!nm || nm === cur?.name) return;
    commitCols(cols.map((c) => (c.id === id ? { ...c, name: nm } : c)));
  }
  function removeColumn(id: string) {
    if (cols.length <= 1) { toast.error("Debe quedar al menos una columna"); return; }
    commitCols(cols.filter((c) => c.id !== id));
  }

  // Redimensionar columna (persistir al soltar).
  const resizing = useRef<{ id: string; startX: number; startW: number } | null>(null);
  function startResize(e: React.MouseEvent, id: string) {
    e.preventDefault(); e.stopPropagation();
    const col = cols.find((c) => c.id === id);
    resizing.current = { id, startX: e.clientX, startW: col?.w ?? 180 };
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return;
      const { id: k, startX, startW } = resizing.current;
      const w = Math.max(80, startW + (ev.clientX - startX));
      setCols((cs) => cs.map((c) => (c.id === k ? { ...c, w } : c)));
    };
    const onUp = () => {
      resizing.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setCols((cs) => { commitCols(cs); return cs; });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const q = query.toLowerCase().trim();
  const visible = q
    ? rows.filter((r) => cols.some((c) => (r.data[c.id] ?? "").toLowerCase().includes(q)))
    : rows;

  const tableWidth = ACTIONS_W + cols.reduce((s, c) => s + c.w, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" onClick={addRow}><Plus className="h-4 w-4 mr-1" /> Nueva fila</Button>
        <Button size="sm" variant="outline" onClick={addColumn}><Columns3 className="h-4 w-4 mr-1" /> Nueva columna</Button>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar…" className="pl-8 h-9 w-56 bg-white" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {saveState === "saving" && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Guardando…</span>}
        {saveState === "saved" && <span className="inline-flex items-center gap-1 text-[11px] text-green-600"><CloudCheck className="h-3 w-3" /> Guardado</span>}
      </div>

      <div className="rounded-lg border bg-white overflow-x-auto">
        <table className="text-sm table-fixed" style={{ width: tableWidth }}>
          <colgroup>
            <col style={{ width: ACTIONS_W }} />
            {cols.map((c) => <col key={c.id} style={{ width: c.w }} />)}
          </colgroup>
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="px-2 py-2"></th>
              {cols.map((c) => (
                <th key={c.id} className="group relative px-2 py-1.5 text-[11px] font-semibold text-left select-none">
                  {renamingCol === c.id ? (
                    <input
                      autoFocus
                      defaultValue={c.name}
                      onBlur={(e) => renameColumn(c.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") { e.currentTarget.value = c.name; setRenamingCol(null); }
                      }}
                      className="w-full h-6 px-1 text-[11px] rounded border border-primary bg-white outline-none"
                    />
                  ) : (
                    <div className="flex items-center gap-1">
                      <span
                        className="truncate cursor-text hover:text-primary"
                        title="Doble clic para renombrar"
                        onDoubleClick={() => setRenamingCol(c.id)}
                      >
                        {c.name || <span className="text-muted-foreground/40">sin nombre</span>}
                      </span>
                      {cols.length > 1 && (
                        <button
                          onClick={() => removeColumn(c.id)}
                          className="ml-auto opacity-0 group-hover:opacity-100 rounded p-0.5 text-muted-foreground/60 hover:text-red-600 hover:bg-red-50 transition-opacity"
                          title="Eliminar columna"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  )}
                  <span onMouseDown={(e) => startResize(e, c.id)} className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/40" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={cols.length + 1} className="p-3"><Skeleton className="h-8 w-full" /></td></tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={cols.length + 1} className="text-center py-16 text-muted-foreground text-sm">
                  {rows.length === 0 ? "Hoja vacía — agrega la primera fila." : "Nada coincide con la búsqueda."}
                </td>
              </tr>
            ) : visible.map((row) => (
              <tr key={row.id} className="border-b hover:bg-muted/20">
                <td className="px-1 py-1">
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-red-600" onClick={() => removeRow(row.id)} title="Eliminar fila">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </td>
                {cols.map((c) => (
                  <td key={c.id} className="px-1 py-1">
                    <Input
                      value={row.data[c.id] ?? ""}
                      onChange={(e) => setCell(row.id, c.id, e.target.value)}
                      className="h-8 text-xs w-full border-transparent hover:border-input focus:border-input bg-transparent"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-muted-foreground/70">Hoja libre — los cambios se guardan solos.</p>
    </div>
  );
}
