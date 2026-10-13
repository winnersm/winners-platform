"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { post, type Edicion, type HuecoVideo } from "./api";

export interface PeticionPlantilla {
  /** Token con el que leer la campaña que se congela. */
  alias: string;
  /** Campaña a congelar (la de origen, o la recién creada en destino). */
  campana: string;
  nombreSugerido: string;
  nota?: string;
  /** Ediciones de idioma a aplicar antes de congelar. */
  ediciones?: Record<string, Edicion[]>;
}

/**
 * Guardar una campaña como plantilla.
 *
 * Sustituye al `prompt()` del original, que además de feo no dejaba explicar
 * qué se está guardando ni avisar de cuántos vídeos habrá que sustituir al
 * lanzarla.
 */
export function SaveTemplateDialog({
  peticion,
  onClose,
  onGuardada,
}: {
  peticion: PeticionPlantilla | null;
  onClose: () => void;
  onGuardada?: () => void;
}) {
  // El padre remonta este diálogo con una `key` por petición, así que los
  // campos arrancan ya con lo sugerido en lugar de sincronizarse después.
  const [nombre, setNombre] = useState(peticion?.nombreSugerido ?? "");
  const [nota, setNota] = useState(peticion?.nota ?? "");
  const [guardando, setGuardando] = useState(false);

  async function guardar() {
    if (!peticion) return;
    if (!nombre.trim()) {
      toast.error("Ponle un nombre a la plantilla");
      return;
    }
    setGuardando(true);
    try {
      const r = await post<{ huecos: HuecoVideo[]; ads: number }>("plantillas", {
        nombre: nombre.trim(),
        nota: nota.trim(),
        alias: peticion.alias,
        campana: peticion.campana,
        ediciones: peticion.ediciones ?? {},
      });
      toast.success(
        `Plantilla «${nombre.trim()}» guardada: ${r.ads} anuncio(s) y ` +
          `${r.huecos.length} vídeo(s) que podrás sustituir al lanzarla.`,
      );
      onGuardada?.();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Dialog open={peticion !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Guardar como plantilla</DialogTitle>
          <DialogDescription>
            Congela la campaña entera —adsets, anuncios y el contenido de todos los
            idiomas— para lanzarla en cualquier cuenta, aunque la original se borre.
            Los vídeos no se congelan: se sustituyen al lanzarla.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="nombre-plantilla">Nombre</Label>
            <Input
              id="nombre-plantilla"
              value={nombre}
              onChange={(e) => setNombre(e.target.value)}
              placeholder="BloSug — CBO"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Si ya existe una con este nombre, se sobrescribe.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="nota-plantilla">Nota (opcional)</Label>
            <Textarea
              id="nota-plantilla"
              value={nota}
              onChange={(e) => setNota(e.target.value)}
              rows={2}
              placeholder="Para qué sirve, qué tiene de particular…"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} disabled={guardando}>
              Cancelar
            </Button>
            <Button onClick={guardar} disabled={guardando}>
              {guardando ? "Guardando…" : "Guardar plantilla"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
