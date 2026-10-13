"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

// Diálogo de confirmación reutilizable (mismo diseño que el de Trabajos).
// Reemplaza a los confirm() nativos del navegador.
export function ConfirmDialog({
  open, onOpenChange, title, description, detail,
  confirmLabel = "Confirmar", cancelLabel = "Cancelar",
  destructive = false, loading = false, onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  detail?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => !loading && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {destructive && <AlertTriangle className="h-4 w-4 text-red-600" />}
            {title}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {detail && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">{detail}</div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            className={destructive ? "bg-red-600 hover:bg-red-700 text-white" : ""}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Procesando…</> : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
