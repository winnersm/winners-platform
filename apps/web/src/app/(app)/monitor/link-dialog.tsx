"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { saveLink, type ActionResult } from "./actions";

export interface LinkFormData {
  id: string;
  name: string;
  url: string;
  expectedUrl: string | null;
  expectedText: string | null;
  expectRedirect: boolean;
  maxResponseMs: number;
}

export function LinkDialog({
  link,
  open,
  onClose,
}: {
  link: LinkFormData | null;
  open: boolean;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    saveLink,
    null,
  );

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      toast.success(state.message);
      onClose();
    } else {
      toast.error(state.error);
    }
  }, [state, onClose]);

  const esNuevo = link === null;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{esNuevo ? "Vigilar un link nuevo" : `Editar ${link.name}`}</DialogTitle>
          <DialogDescription>
            El monitor comprueba cada 30 minutos que el link responda, acabe donde
            debe y que el lander muestre el texto esperado.
          </DialogDescription>
        </DialogHeader>

        <form action={action} className="space-y-4">
          {!esNuevo && <input type="hidden" name="id" value={link.id} />}

          <div className="space-y-1.5">
            <Label htmlFor="name">Nombre</Label>
            <Input
              id="name"
              name="name"
              required
              defaultValue={link?.name}
              placeholder="GlycoCare US"
            />
            <p className="text-xs text-muted-foreground">
              Es el nombre que aparece en las alertas de Slack
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="url">URL a comprobar</Label>
            <Input
              id="url"
              name="url"
              type="url"
              required
              defaultValue={link?.url}
              className="font-mono text-xs"
              placeholder="https://go.midominio.com/fts/..."
            />
            <p className="text-xs text-muted-foreground">
              El tracking link tal cual, con sus macros si las lleva
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="expectedUrl">Destino esperado (opcional)</Label>
            <Input
              id="expectedUrl"
              name="expectedUrl"
              defaultValue={link?.expectedUrl ?? ""}
              className="font-mono text-xs"
              placeholder="https://mi-lander.com/oferta/"
            />
            <p className="text-xs text-muted-foreground">
              Dónde debe acabar tras seguir los redirects. Si acaba en otro sitio,
              salta la alerta — así se detectan los secuestros de tráfico.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="expectedText">Texto que debe aparecer (opcional)</Label>
            <Input
              id="expectedText"
              name="expectedText"
              defaultValue={link?.expectedText ?? ""}
              placeholder="¿Azúcar alta? HAZ ESTO."
            />
            <p className="text-xs text-muted-foreground">
              Se abre el lander en un navegador real y se busca este texto. Detecta
              landers en blanco o cambiados, que responden 200 pero no sirven.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="maxResponseMs">Tiempo máximo (ms)</Label>
              <Input
                id="maxResponseMs"
                name="maxResponseMs"
                type="number"
                min={500}
                max={60000}
                step={500}
                required
                defaultValue={link?.maxResponseMs ?? 8000}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="expectRedirect">¿Debe redirigir?</Label>
              <label className="flex h-9 items-center gap-2 text-sm">
                <input
                  id="expectRedirect"
                  name="expectRedirect"
                  type="checkbox"
                  className="rounded border"
                  defaultChecked={link?.expectRedirect ?? true}
                />
                Sí, es un tracking link
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Guardando…" : esNuevo ? "Empezar a vigilar" : "Guardar"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
