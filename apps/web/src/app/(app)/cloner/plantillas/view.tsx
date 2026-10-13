"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Rocket, Trash2, RefreshCw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useConfirm } from "@/components/use-confirm";
import { get, post, type PlantillaResumen } from "../api";
import { useDatos } from "../use-datos";
import { TemplateLauncher } from "./launcher";

export function PlantillasView({
  puedeEscribir,
  puedeLanzar,
}: {
  puedeEscribir: boolean;
  puedeLanzar: boolean;
}) {
  const [abierta, setAbierta] = useState<string | null>(null);
  const { confirmar, dialogo } = useConfirm();

  const { datos, cargando, recargar } = useDatos(
    () => get<{ plantillas: PlantillaResumen[] }>("plantillas"),
    { plantillas: [] as PlantillaResumen[] },
  );
  const plantillas = datos.plantillas;

  async function borrar(p: PlantillaResumen) {
    const ok = await confirmar({
      title: `¿Borrar la plantilla «${p.nombre}»?`,
      description:
        "No se puede deshacer. Las campañas que ya lanzaste con ella no se tocan.",
      detail: `${p.adsets} adset(s) y ${p.ads} anuncio(s) congelados`,
      confirmLabel: "Borrar",
      destructive: true,
    });
    if (!ok) return;
    try {
      await post("plantillas/borrar", {}, { id: p.id });
      toast.success("Plantilla borrada");
      if (abierta === p.id) setAbierta(null);
      recargar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo borrar");
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-medium">Plantillas guardadas</h2>
          <Button size="sm" variant="ghost" onClick={recargar} disabled={cargando}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Actualizar
          </Button>
        </div>

        {cargando && !plantillas.length ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : !plantillas.length ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Aún no hay plantillas. Configura una campaña en{" "}
            <strong>Clonar</strong> y pulsa «Guardar como plantilla».
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Contenido</TableHead>
                  <TableHead>Vídeos</TableHead>
                  <TableHead>Creada</TableHead>
                  <TableHead className="w-40" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {plantillas.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="max-w-64">
                      <p className="truncate font-medium" title={p.nombre}>
                        {p.nombre}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">{p.objetivo}</p>
                      {p.nota && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={p.nota}>
                          {p.nota}
                        </p>
                      )}
                    </TableCell>

                    <TableCell className="text-sm">
                      {p.adsets} adset(s), {p.ads} anuncio(s)
                      {!p.ads && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-destructive">
                          <AlertTriangle className="h-3 w-3" />
                          sin anuncios: no sirve para lanzar
                        </p>
                      )}
                    </TableCell>

                    <TableCell className="max-w-48 text-sm">
                      {p.huecos.length} vídeo(s)
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {p.huecos
                          .map((h) => h.etiquetas.join("/") || "sin idioma")
                          .join(", ")}
                      </p>
                    </TableCell>

                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {new Date(p.creada).toLocaleDateString("es-CO", {
                        day: "2-digit",
                        month: "short",
                        year: "2-digit",
                      })}
                    </TableCell>

                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          disabled={!puedeLanzar || !p.ads}
                          onClick={() => setAbierta(p.id)}
                          title={
                            !p.ads
                              ? "Esta plantilla no tiene anuncios"
                              : "Lanzar en una cuenta"
                          }
                        >
                          <Rocket className="mr-1.5 h-3.5 w-3.5" />
                          Lanzar
                        </Button>
                        {puedeEscribir && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Borrar"
                            onClick={() => borrar(p)}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {abierta && (
        <TemplateLauncher
          plantillaId={abierta}
          onCerrar={() => setAbierta(null)}
          onGuardada={recargar}
        />
      )}

      {dialogo}
    </div>
  );
}
