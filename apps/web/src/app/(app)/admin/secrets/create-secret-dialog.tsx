"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createSecret, type ActionResult } from "./actions";

/** Secciones habituales. Es texto libre, pero sugerir las comunes evita duplicados. */
export const SECTIONS = ["meta", "affiliates", "slack", "google", "general"];

export function CreateSecretDialog() {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    createSecret,
    null,
  );

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      toast.success(state.message);
      setOpen(false);
    } else {
      toast.error(state.error);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <KeyRound className="mr-1.5 h-4 w-4" />
            Nuevo secreto
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo secreto</DialogTitle>
          <DialogDescription>
            Se cifra con AES-256-GCM antes de guardarse. Solo se conservarán los últimos 4
            caracteres como pista; el valor completo no vuelve a mostrarse salvo que lo reveles.
          </DialogDescription>
        </DialogHeader>

        <form action={action} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="key">Clave</Label>
            <Input
              id="key"
              name="key"
              required
              placeholder="fb_token_primary"
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Identificador único. Minúsculas, números y <code>_ . -</code>. Es como la busca el código.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="label">Etiqueta</Label>
            <Input id="label" name="label" required placeholder="Token principal de Meta" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="section">Sección</Label>
            <Input
              id="section"
              name="section"
              required
              list="secret-sections"
              defaultValue="general"
              placeholder="meta"
            />
            <datalist id="secret-sections">
              {SECTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="value">Valor</Label>
            <Textarea
              id="value"
              name="value"
              required
              rows={3}
              placeholder="Pega aquí el token / API key / webhook…"
              className="font-mono text-xs"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Guardando…" : "Guardar secreto"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
