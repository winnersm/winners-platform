"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, Pencil, Trash2 } from "lucide-react";
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
} from "@/components/ui/dialog";
import { saveFunnelUrl, deleteFunnelUrl, type ActionResult } from "./generate-actions";
import { useConfirm } from "@/components/use-confirm";

interface FunnelUrl {
  id: string;
  name: string;
  urlTemplate: string;
}

/**
 * URLs de FunnelFlux guardadas.
 *
 * Evitan tener que ir a buscar la URL con macros cada vez que se generan
 * enlaces para el mismo funnel — que es el paso donde es fácil equivocarse.
 */
export function FunnelUrls({ urls }: { urls: FunnelUrl[] }) {
  const [editando, setEditando] = useState<FunnelUrl | null>(null);
  const [creando, setCreando] = useState(false);
  const [pending, startTransition] = useTransition();
  const { confirmar, dialogo } = useConfirm();

  function run(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setCreando(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          Guardar una URL
        </Button>
      </div>

      <div className="rounded-lg border bg-card divide-y">
        {urls.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            Aún no hay URLs guardadas. Guarda las de los funnels que uses a menudo
            para no tener que buscarlas cada vez.
          </p>
        )}

        {urls.map((u) => (
          <div key={u.id} className="flex items-start justify-between gap-4 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{u.name}</p>
              <code className="block truncate text-xs text-muted-foreground" title={u.urlTemplate}>
                {u.urlTemplate}
              </code>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                title="Editar"
                onClick={() => setEditando(u)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                title="Eliminar"
                onClick={async () => {
                  if (
                    await confirmar({
                      title: `¿Eliminar «${u.name}»?`,
                      description:
                        "Los enlaces ya generados con ella siguen funcionando: su destino está guardado.",
                      confirmLabel: "Eliminar",
                      destructive: true,
                    })
                  ) {
                    run(() => deleteFunnelUrl(u.id));
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <FunnelDialog
        url={editando}
        open={editando !== null || creando}
        onClose={() => {
          setEditando(null);
          setCreando(false);
        }}
      />
      {dialogo}
    </div>
  );
}

function FunnelDialog({
  url,
  open,
  onClose,
}: {
  url: FunnelUrl | null;
  open: boolean;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    saveFunnelUrl,
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

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{url ? `Editar ${url.name}` : "Guardar una URL de FunnelFlux"}</DialogTitle>
          <DialogDescription>
            Se guarda con sus {"{{macros}}"} tal cual. Al generar enlaces, las macros se
            sustituyen por los IDs reales de cada anuncio.
          </DialogDescription>
        </DialogHeader>

        <form action={action} className="space-y-4">
          {url && <input type="hidden" name="id" value={url.id} />}

          <div className="space-y-1.5">
            <Label htmlFor="name">Nombre</Label>
            <Input
              id="name"
              name="name"
              required
              defaultValue={url?.name}
              placeholder="GlycoCare — funnel principal"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="urlTemplate">URL con macros</Label>
            <Textarea
              id="urlTemplate"
              name="urlTemplate"
              required
              rows={4}
              defaultValue={url?.urlTemplate}
              className="font-mono text-xs"
              placeholder="https://track.tudominio.com/fts/FUNNEL-TS?ad_id={{ad.id}}&adset_id={{adset.id}}"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
