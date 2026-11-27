"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Pencil, Trash2, Send, Check, X, CheckCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useConfirm } from "@/components/use-confirm";
import { cn } from "@/lib/utils";

/**
 * Notas en vivo por cuenta (Rendimiento).
 *
 *  - `useAccountNotes`: resumen por cuenta (total y no leídas) + canal SSE.
 *  - `NotesButton`: icono de la fila con el contador de no leídas.
 *  - `NotesPanel`: el chat de una cuenta (escribir, editar, borrar, visto por).
 */

type Summary = Record<string, { total: number; unread: number }>;
type LiveEvent =
  | { type: "created" | "updated" | "deleted"; accountId: string; noteId: string; authorId: string; authorName: string }
  | { type: "read"; accountId: string; userId: string };

export interface NotesTarget { accountId: string; name: string }

const rawId = (id: string) => id.replace(/^act_/, "");

export function useAccountNotes(accountNames: Record<string, string>) {
  const [summary, setSummary] = useState<Summary>({});
  const [me, setMe] = useState<string | null>(null);
  const [open, setOpen] = useState<NotesTarget | null>(null);
  // Cada vez que llega un cambio de la cuenta abierta, el panel recarga el hilo.
  const [threadTick, setThreadTick] = useState(0);
  const openRef = useRef<NotesTarget | null>(null);
  const namesRef = useRef(accountNames);
  const meRef = useRef<string | null>(null);
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => { namesRef.current = accountNames; }, [accountNames]);
  useEffect(() => { meRef.current = me; }, [me]);

  const loadSummary = useCallback(async () => {
    try {
      const r = await fetch("/api/notes/summary", { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      setSummary(j.accounts ?? {});
      setMe(j.me ?? null);
    } catch {}
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource("/api/notes/stream");
    es.onmessage = (e) => {
      let ev: LiveEvent;
      try { ev = JSON.parse(e.data); } catch { return; }
      const viewing = openRef.current?.accountId === ev.accountId;
      if (viewing) setThreadTick((t) => t + 1);
      if (ev.type === "created" && ev.authorId !== meRef.current && !viewing) {
        const name = namesRef.current[ev.accountId] ?? ev.accountId;
        toast(`${ev.authorName} dejó una nota`, {
          description: name,
          action: { label: "Ver", onClick: () => setOpen({ accountId: ev.accountId, name }) },
        });
      }
      // Varios eventos seguidos → una sola recarga del resumen.
      if (timer) clearTimeout(timer);
      timer = setTimeout(loadSummary, 250);
    };
    // Al reconectar (caída de red, redespliegue) se pudieron perder eventos.
    // La primera conexión también carga el resumen; si el canal falla, se carga igual.
    es.onopen = () => { loadSummary(); };
    es.onerror = () => { loadSummary(); };
    return () => { es.close(); if (timer) clearTimeout(timer); };
  }, [loadSummary]);

  const totalUnread = useMemo(() => Object.values(summary).reduce((s, v) => s + v.unread, 0), [summary]);

  return {
    summary, me, open, threadTick, totalUnread,
    openNotes: (accountId: string, name: string) => setOpen({ accountId: rawId(accountId), name }),
    closeNotes: () => setOpen(null),
    refreshSummary: loadSummary,
    countsFor: (accountId: string) => summary[rawId(accountId)] ?? { total: 0, unread: 0 },
  };
}

/** Icono de notas de una fila. Sin notas solo se insinúa al pasar el ratón. */
export function NotesButton({ total, unread, onClick, className }: {
  total: number; unread: number; onClick: () => void; className?: string;
}) {
  const label = unread > 0 ? `${unread} ${unread === 1 ? "nota nueva" : "notas nuevas"}` : total > 0 ? `${total} notas` : "Dejar una nota";
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        "relative inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground",
        unread > 0 ? "text-primary" : total > 0 ? "text-muted-foreground" : "text-muted-foreground/60 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100",
        className,
      )}
    >
      <MessageSquare className="h-3.5 w-3.5" />
      {unread > 0 && (
        <span className="absolute -top-1 -right-1.5 min-w-[16px] h-4 rounded-full bg-red-500 px-1 text-[10px] font-bold leading-4 text-white text-center tabular-nums shadow-sm">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}

interface Note { id: string; body: string; createdAt: string; editedAt: string | null; author: { id: string; name: string } }
interface Read { userId: string; name: string; lastReadAt: string }

function timeLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? hm : `${d.toLocaleDateString("es", { day: "numeric", month: "short" })} ${hm}`;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
}

interface Thread { accountId: string; notes: Note[]; reads: Read[] }

/** Carga el hilo y lo marca como leído. Devuelve null si falló (ya avisó). */
async function fetchThread(accountId: string): Promise<{ thread: Thread; readChanged: boolean } | null> {
  try {
    const r = await fetch(`/api/notes?accountId=${accountId}`, { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) { toast.error(j.error ?? "No se pudieron cargar las notas"); return null; }
    // Abrir el hilo = leerlo. El servidor solo avisa si había algo nuevo.
    const mr = await fetch("/api/notes/read", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId }),
    }).then((x) => x.json()).catch(() => null);
    return { thread: { accountId, notes: j.notes ?? [], reads: j.reads ?? [] }, readChanged: !!mr?.changed };
  } catch {
    toast.error("Error de red al cargar las notas");
    return null;
  }
}

export function NotesPanel({ target, me, tick, onClose, onChanged }: {
  target: NotesTarget | null;
  me: string | null;
  /** Sube cuando llega un cambio en vivo de la cuenta abierta. */
  tick: number;
  onClose: () => void;
  /** Tras leer o escribir, para refrescar los contadores. */
  onChanged: () => void;
}) {
  return (
    <Sheet open={target !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            Notas
          </SheetTitle>
          <SheetDescription className="truncate">{target?.name}</SheetDescription>
        </SheetHeader>
        {/* `key`: cambiar de cuenta empieza un hilo limpio (borrador, edición, scroll). */}
        {target && <NotesThread key={target.accountId} accountId={target.accountId} me={me} tick={tick} onChanged={onChanged} />}
      </SheetContent>
    </Sheet>
  );
}

function NotesThread({ accountId, me, tick, onChanged }: {
  accountId: string; me: string | null; tick: number; onChanged: () => void;
}) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const { confirmar, dialogo } = useConfirm();
  const notes = useMemo(() => thread?.notes ?? [], [thread]);
  const reads = useMemo(() => thread?.reads ?? [], [thread]);
  const reload = () => setReloadKey((k) => k + 1);

  // Al abrir, con cada cambio en vivo (`tick`) y tras una acción propia.
  useEffect(() => {
    let cancelled = false;
    fetchThread(accountId).then((res) => {
      if (cancelled || !res) return;
      setThread(res.thread);
      if (res.readChanged) onChanged();
    });
    return () => { cancelled = true; };
  }, [accountId, tick, reloadKey, onChanged]);

  // Bajar al último mensaje si ya se estaba abajo.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [notes]);

  // «Visto por»: cada persona aparece bajo el último mensaje que ha visto.
  const seenBy = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const r of reads) {
      const t = new Date(r.lastReadAt).getTime();
      let last: Note | null = null;
      for (const n of notes) if (new Date(n.createdAt).getTime() <= t) last = n;
      if (!last || last.author.id === r.userId || r.userId === me) continue;
      (out[last.id] ??= []).push(r.name);
    }
    return out;
  }, [notes, reads, me]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const r = await fetch("/api/notes", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId, body }),
      });
      const j = await r.json();
      if (!r.ok) { toast.error(j.error ?? "No se pudo enviar"); return; }
      setDraft("");
      stickToBottom.current = true;
      reload();
    } catch {
      toast.error("Error de red al enviar");
    } finally {
      setSending(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const body = editing.body.trim();
    if (!body) return;
    const r = await fetch(`/api/notes/${editing.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }),
    }).catch(() => null);
    const j = await r?.json().catch(() => null);
    if (!r?.ok) { toast.error(j?.error ?? "No se pudo editar"); return; }
    setEditing(null);
    reload();
  };

  const remove = async (n: Note) => {
    const ok = await confirmar({ title: "¿Borrar esta nota?", description: "Desaparece para todos y no se puede recuperar.", confirmLabel: "Borrar", destructive: true });
    if (!ok) return;
    const r = await fetch(`/api/notes/${n.id}`, { method: "DELETE" }).catch(() => null);
    const j = await r?.json().catch(() => null);
    if (!r?.ok) { toast.error(j?.error ?? "No se pudo borrar"); return; }
    reload();
    onChanged();
  };

  return (
    <>
        <div
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="flex-1 space-y-3 overflow-y-auto px-4 py-4"
        >
          {!thread ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Cargando…</p>
          ) : notes.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Todavía no hay notas en esta cuenta. Escribe la primera.</p>
          ) : notes.map((n) => {
            const mine = n.author.id === me;
            const isEditing = editing?.id === n.id;
            const seen = seenBy[n.id];
            return (
              <div key={n.id} className={cn("group/note flex gap-2", mine && "flex-row-reverse")}>
                <div className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold", mine ? "bg-primary text-primary-foreground" : "bg-muted text-foreground")} title={n.author.name}>
                  {initials(n.author.name)}
                </div>
                <div className={cn("flex min-w-0 max-w-[80%] flex-col", mine && "items-end")}>
                  <div className={cn("flex items-baseline gap-1.5 text-[11px] text-muted-foreground", mine && "flex-row-reverse")}>
                    <span className="font-medium text-foreground">{mine ? "Tú" : n.author.name}</span>
                    <span>{timeLabel(n.createdAt)}</span>
                    {n.editedAt && <span title={`Editada ${timeLabel(n.editedAt)}`}>· editada</span>}
                  </div>
                  {isEditing ? (
                    <div className="mt-1 w-72 max-w-full space-y-1.5">
                      <textarea
                        autoFocus
                        value={editing.body}
                        onChange={(e) => setEditing({ id: n.id, body: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                          if (e.key === "Escape") { e.stopPropagation(); setEditing(null); }
                        }}
                        maxLength={2000}
                        rows={3}
                        className="w-full resize-none rounded-lg border bg-background px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      />
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditing(null)}><X className="mr-1 h-3 w-3" />Cancelar</Button>
                        <Button size="sm" className="h-7 px-2 text-xs" onClick={saveEdit}><Check className="mr-1 h-3 w-3" />Guardar</Button>
                      </div>
                    </div>
                  ) : (
                    <div className={cn("mt-1 flex items-start gap-1", mine && "flex-row-reverse")}>
                      <div className={cn("whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm", mine ? "rounded-tr-sm bg-primary text-primary-foreground" : "rounded-tl-sm bg-muted")}>
                        {n.body}
                      </div>
                      {mine && (
                        <div className="flex shrink-0 flex-col opacity-0 transition-opacity group-hover/note:opacity-100 focus-within:opacity-100 max-md:opacity-100">
                          <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Editar" aria-label="Editar nota" onClick={() => setEditing({ id: n.id, body: n.body })}>
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button type="button" className="rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/15" title="Borrar" aria-label="Borrar nota" onClick={() => remove(n)}>
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  {seen && seen.length > 0 && (
                    <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground" title={`Visto por ${seen.join(", ")}`}>
                      <CheckCheck className="h-3 w-3 text-sky-500" />
                      Visto por {seen.length <= 3 ? seen.join(", ") : `${seen.slice(0, 2).join(", ")} y ${seen.length - 2} más`}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder="Escribe una nota… (Enter envía, Shift+Enter salto de línea)"
              aria-label="Nueva nota"
              maxLength={2000}
              rows={2}
              className="max-h-40 min-h-[44px] flex-1 resize-none rounded-lg border bg-background px-2.5 py-2 text-sm outline-none field-sizing-content focus-visible:ring-2 focus-visible:ring-ring/50 max-md:text-base"
            />
            <Button size="icon" className="h-10 w-10 shrink-0" onClick={send} disabled={!draft.trim() || sending} aria-label="Enviar nota">
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
        {dialogo}
    </>
  );
}
