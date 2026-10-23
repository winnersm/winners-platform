"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Plus, Trash2, CheckCircle, XCircle, RefreshCw, RotateCcw, AlertTriangle, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

interface BM {
  id: string;
  name: string;
  bmIdMeta: string;
  systemUserId: string;
  status: string;
  tokenLast4?: string | null;
  updatedAt: Date | string;
  deletedAt?: Date | string | null;
  deletedByName?: string | null;
  deletedReason?: string | null;
}

const schema = z.object({
  name: z.string().min(1, "Nombre requerido"),
  bmIdMeta: z.string().min(1, "BM ID requerido"),
  token: z.string().min(10, "Token requerido"),
});
type FormData = z.infer<typeof schema>;

const fmtDate = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" }) : "—";

/** El estado del token, no el de la papelera: "invalid" = dejó de funcionar. */
function StatusBadge({ status }: { status: string }) {
  if (status === "active") return <Badge variant="default">Activo</Badge>;
  if (status === "invalid") return <Badge variant="destructive">Token inválido</Badge>;
  return <Badge variant="secondary">Inactivo</Badge>;
}

export function SettingsClient({
  initialBMs,
  initialTrash,
}: {
  initialBMs: BM[];
  initialTrash: BM[];
}) {
  const [bms, setBms] = useState<BM[]>(initialBMs);
  const [trash, setTrash] = useState<BM[]>(initialTrash);
  const [tab, setTab] = useState<"activos" | "papelera">("activos");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Eliminar exige motivo, así que va en su propio diálogo.
  const [toDelete, setToDelete] = useState<BM | null>(null);
  const [reason, setReason] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Editar nombre/token sin borrar y volver a crear.
  const [toEdit, setToEdit] = useState<BM | null>(null);
  const [editName, setEditName] = useState("");
  const [editToken, setEditToken] = useState("");
  const [editing, setEditing] = useState(false);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  function openEdit(bm: BM) {
    setToEdit(bm);
    setEditName(bm.name);
    setEditToken("");
  }

  async function confirmEdit() {
    if (!toEdit) return;
    const name = editName.trim();
    const token = editToken.trim();
    if (!name) { toast.error("El nombre no puede quedar vacío"); return; }
    if (token && token.length < 10) { toast.error("El token parece incompleto"); return; }
    const payload: { name?: string; token?: string } = {};
    if (name !== toEdit.name) payload.name = name;
    if (token) payload.token = token;
    if (!payload.name && !payload.token) { setToEdit(null); return; }
    setEditing(true);
    try {
      const res = await fetch(`/api/settings/business-manager?id=${toEdit.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error ?? "Error al actualizar"); return; }
      toast.success(payload.token ? `Token de "${json.name}" actualizado` : `"${json.name}" actualizado`);
      setToEdit(null);
      await refresh();
    } catch {
      toast.error("No se pudo conectar con el servidor");
    } finally {
      setEditing(false);
    }
  }

  async function refresh() {
    const [a, t] = await Promise.all([
      fetch("/api/settings/business-manager").then((r) => r.json()),
      fetch("/api/settings/business-manager?trash=1").then((r) => r.json()),
    ]);
    setBms(Array.isArray(a) ? a : []);
    setTrash(Array.isArray(t) ? t : []);
  }

  async function onSubmit(data: FormData) {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/business-manager", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      // Si el servidor falla con HTML, res.json() lanzaría y no se vería ningún aviso.
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error ?? "Error al guardar"); return; }
      toast.success(json.restored
        ? `"${json.name}" estaba en la papelera: se restauró con el nuevo token`
        : `Business Manager "${json.name}" configurado`);
      reset();
      setOpen(false);
      setTab("activos");
      await refresh();
    } catch {
      toast.error("No se pudo conectar con el servidor");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!toDelete) return;
    if (reason.trim().length < 3) { toast.error("Indica el motivo de la eliminación"); return; }
    setDeleting(true);
    try {
      const res = await fetch(`/api/settings/business-manager?id=${toDelete.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(json.error ?? "Error al eliminar"); return; }
      toast.success(`"${toDelete.name}" movido a la papelera`);
      setToDelete(null);
      setReason("");
      await refresh();
    } finally {
      setDeleting(false);
    }
  }

  async function restore(bm: BM) {
    const res = await fetch(`/api/settings/business-manager?id=${bm.id}`, { method: "PATCH" });
    if (!res.ok) { toast.error("Error al restaurar"); return; }
    toast.success(`"${bm.name}" restaurado`);
    await refresh();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center rounded-md border p-0.5">
          <Button
            variant={tab === "activos" ? "secondary" : "ghost"}
            size="sm" className="h-7 px-2.5 text-xs"
            onClick={() => setTab("activos")}
          >
            Business Managers ({bms.length})
          </Button>
          <Button
            variant={tab === "papelera" ? "secondary" : "ghost"}
            size="sm" className="h-7 px-2.5 text-xs"
            onClick={() => setTab("papelera")}
          >
            Papelera ({trash.length})
          </Button>
        </div>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            render={
              <button className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 transition-colors">
                <Plus className="h-4 w-4" />
                Añadir BM
              </button>
            }
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Configurar Business Manager</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 mt-2">
              <div className="space-y-1.5">
                <Label>Nombre</Label>
                <Input placeholder="BM Principal" {...register("name")} />
                {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>BM ID de Meta</Label>
                <Input placeholder="123456789012345" {...register("bmIdMeta")} />
                {errors.bmIdMeta && <p className="text-xs text-destructive">{errors.bmIdMeta.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Token de System User</Label>
                <Input type="text" autoComplete="off" placeholder="EAA..." {...register("token")} />
                {errors.token && <p className="text-xs text-destructive">{errors.token.message}</p>}
                <p className="text-xs text-muted-foreground">
                  Se verificará contra Meta API antes de guardar. Se almacena cifrado (AES-256-GCM).
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" type="button" onClick={() => setOpen(false)}>Cancelar</Button>
                <Button type="submit" disabled={saving}>
                  {saving ? <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> : null}
                  {saving ? "Verificando..." : "Guardar"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {tab === "activos" ? (
        bms.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground text-sm">
              No hay Business Managers configurados. Añade uno para empezar.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {bms.map((bm) => (
              <Card key={bm.id}>
                <CardHeader className="pb-2 pt-4 px-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {bm.status === "active"
                        ? <CheckCircle className="h-4 w-4 text-green-500" />
                        : <XCircle className="h-4 w-4 text-muted-foreground" />}
                      <CardTitle className="text-base">{bm.name}</CardTitle>
                      <StatusBadge status={bm.status} />
                    </div>
                    <div className="flex items-center">
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => openEdit(bm)}
                        title="Editar nombre o token"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost" size="sm"
                        onClick={() => { setToDelete(bm); setReason(""); }}
                        className="text-destructive hover:text-destructive"
                        title="Mover a la papelera"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <CardDescription className="text-xs">
                    BM ID: {bm.bmIdMeta} · System User: {bm.systemUserId}
                    {bm.tokenLast4 ? ` · Token: …${bm.tokenLast4}` : ""} · Actualizado: {fmtDate(bm.updatedAt)}
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        )
      ) : trash.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground text-sm">
            La papelera está vacía.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {trash.map((bm) => (
            <Card key={bm.id} className="opacity-80">
              <CardHeader className="pb-2 pt-4 px-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                    <CardTitle className="text-base line-through decoration-muted-foreground/50">{bm.name}</CardTitle>
                    <Badge variant="secondary">Eliminado</Badge>
                  </div>
                  <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => restore(bm)}>
                    <RotateCcw className="h-3.5 w-3.5 mr-1" />
                    Restaurar
                  </Button>
                </div>
                <CardDescription className="text-xs space-y-0.5">
                  <span className="block">
                    Eliminado el {fmtDate(bm.deletedAt)}
                    {bm.deletedByName ? ` por ${bm.deletedByName}` : ""}
                  </span>
                  <span className="block">
                    <span className="text-muted-foreground/70">Motivo:</span>{" "}
                    {bm.deletedReason ?? "—"}
                  </span>
                  <span className="block text-muted-foreground/60">
                    BM ID: {bm.bmIdMeta} · System User: {bm.systemUserId}
                  </span>
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      {/* Editar: nombre y/o token; el token vacío conserva el actual */}
      <Dialog open={!!toEdit} onOpenChange={(o) => { if (!o) setToEdit(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar Business Manager</DialogTitle>
            <DialogDescription>
              BM ID {toEdit?.bmIdMeta}. El nuevo token se verifica contra Meta antes de guardarse.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Nombre</Label>
              <Input id="edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-token">Nuevo token de System User</Label>
              <Input
                id="edit-token" type="text" autoComplete="off" placeholder="EAA..."
                value={editToken} onChange={(e) => setEditToken(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Déjalo vacío para conservar el token actual
                {toEdit?.tokenLast4 ? ` (…${toEdit.tokenLast4})` : ""}.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToEdit(null)}>Cancelar</Button>
            <Button onClick={confirmEdit} disabled={editing}>
              {editing ? <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> : null}
              {editing ? "Verificando..." : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Eliminar: el motivo es obligatorio */}
      <Dialog open={!!toDelete} onOpenChange={(o) => { if (!o) { setToDelete(null); setReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Eliminar Business Manager
            </DialogTitle>
            <DialogDescription>
              <strong>{toDelete?.name}</strong> pasará a la papelera. No se borra nada: queda el
              registro de quién, cuándo y por qué, y se puede restaurar.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reason">Motivo de la eliminación</Label>
            <Textarea
              id="reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ej.: el cliente cerró la cuenta, token revocado, BM duplicado…"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setToDelete(null); setReason(""); }}>Cancelar</Button>
            <Button
              onClick={confirmDelete}
              disabled={deleting || reason.trim().length < 3}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {deleting ? "Eliminando…" : "Mover a la papelera"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
