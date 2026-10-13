"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Eye, Pencil, Trash2, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SECTIONS } from "./create-secret-dialog";
import { deleteSecret, revealSecret, updateSecret } from "./actions";

export interface SecretRow {
  id: string;
  key: string;
  label: string;
  section: string;
  hint: string | null;
  updatedAt: string;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString("es", { dateStyle: "medium", timeStyle: "short" });
}

export function SecretsClient({ secrets }: { secrets: SecretRow[] }) {
  const [pending, startTransition] = useTransition();

  // Diálogo de revelado
  const [revealed, setRevealed] = useState<{ key: string; value: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Diálogo de edición
  const [editing, setEditing] = useState<SecretRow | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editSection, setEditSection] = useState("");
  const [editValue, setEditValue] = useState("");

  // Diálogo de borrado
  const [deleting, setDeleting] = useState<SecretRow | null>(null);

  function onReveal(s: SecretRow) {
    startTransition(async () => {
      const res = await revealSecret(s.id);
      if (res.ok) {
        setRevealed({ key: s.key, value: res.value });
        setCopied(false);
      } else {
        toast.error(res.error);
      }
    });
  }

  function openEdit(s: SecretRow) {
    setEditing(s);
    setEditLabel(s.label);
    setEditSection(s.section);
    setEditValue("");
  }

  function onSaveEdit() {
    if (!editing) return;
    startTransition(async () => {
      const res = await updateSecret(editing.id, {
        label: editLabel,
        section: editSection,
        value: editValue.trim() ? editValue : undefined,
      });
      if (res.ok) {
        toast.success(res.message);
        setEditing(null);
      } else {
        toast.error(res.error);
      }
    });
  }

  function onConfirmDelete() {
    if (!deleting) return;
    const target = deleting;
    startTransition(async () => {
      const res = await deleteSecret(target.id);
      if (res.ok) {
        toast.success(res.message);
        setDeleting(null);
      } else {
        toast.error(res.error);
      }
    });
  }

  async function copyValue() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("No se pudo copiar al portapapeles");
    }
  }

  if (secrets.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
        No hay secretos todavía. Crea el primero con «Nuevo secreto».
      </div>
    );
  }

  return (
    <>
      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Clave</TableHead>
              <TableHead>Etiqueta</TableHead>
              <TableHead>Sección</TableHead>
              <TableHead>Pista</TableHead>
              <TableHead>Actualizado</TableHead>
              <TableHead className="text-right">Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {secrets.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs">{s.key}</TableCell>
                <TableCell className="text-sm">{s.label}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{s.section}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {s.hint ? `••••${s.hint}` : "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {fmtDate(s.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      disabled={pending}
                      onClick={() => onReveal(s)}
                      title="Revelar valor"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      disabled={pending}
                      onClick={() => openEdit(s)}
                      title="Editar"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-red-600 hover:text-red-700"
                      disabled={pending}
                      onClick={() => setDeleting(s)}
                      title="Eliminar"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Revelar */}
      <Dialog open={!!revealed} onOpenChange={(o) => !o && setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{revealed?.key}</DialogTitle>
            <DialogDescription>
              Valor en claro. No lo dejes a la vista; se cerró el resto de la sesión por algo.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2">
            <pre className="flex-1 overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs break-all whitespace-pre-wrap">
              {revealed?.value}
            </pre>
            <Button variant="outline" size="sm" className="h-8 px-2 shrink-0" onClick={copyValue}>
              {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevealed(null)}>
              Cerrar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Editar */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{editing?.key}</DialogTitle>
            <DialogDescription>
              La clave no se cambia (la usa el código). Deja el valor vacío para conservar el actual,
              o escribe uno nuevo para rotarlo.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="edit-label">Etiqueta</Label>
              <Input id="edit-label" value={editLabel} onChange={(e) => setEditLabel(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-section">Sección</Label>
              <Input
                id="edit-section"
                value={editSection}
                onChange={(e) => setEditSection(e.target.value)}
                list="secret-sections-edit"
              />
              <datalist id="secret-sections-edit">
                {SECTIONS.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-value">Nuevo valor (opcional)</Label>
              <Textarea
                id="edit-value"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                rows={3}
                placeholder="Dejar vacío para no rotar el valor"
                className="font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancelar
            </Button>
            <Button onClick={onSaveEdit} disabled={pending}>
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Eliminar */}
      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Eliminar secreto</DialogTitle>
            <DialogDescription>
              Vas a borrar <code className="font-mono">{deleting?.key}</code>. Si alguna app lo usa,
              dejará de funcionar. Esta acción no se puede deshacer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancelar
            </Button>
            <Button
              onClick={onConfirmDelete}
              disabled={pending}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {pending ? "Eliminando…" : "Eliminar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
