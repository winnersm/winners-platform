"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { alElegir, get, type CuentaMeta, type Opcion } from "./api";

/** Lo que se elige para cada cuenta de destino. */
export interface ConfigDestino {
  page_id: string;
  page_nombre: string;
  pixel_id: string;
  instagram_id: string;
}

export const DESTINO_VACIO: ConfigDestino = {
  page_id: "",
  page_nombre: "",
  pixel_id: "",
  instagram_id: "",
};

const MANTENER = "__mantener__";

/**
 * Página, píxel e Instagram de cada cuenta de destino.
 *
 * Van por cuenta y no en global a propósito: un píxel o una página de una
 * cuenta no tienen por qué existir en otra, así que no se pueden elegir de una
 * vez para todas.
 */
export function Destinations({
  alias,
  cuentas,
  config,
  onChange,
}: {
  alias: string;
  cuentas: CuentaMeta[];
  config: Record<string, ConfigDestino>;
  onChange: (cuenta: string, cfg: ConfigDestino) => void;
}) {
  if (!cuentas.length) return null;

  return (
    <div className="space-y-3">
      {cuentas.map((c) => (
        <BloqueDestino
          key={c.id}
          alias={alias}
          cuenta={c}
          cfg={config[c.id] ?? DESTINO_VACIO}
          onChange={(cfg) => onChange(c.id, cfg)}
        />
      ))}
    </div>
  );
}

function BloqueDestino({
  alias,
  cuenta,
  cfg,
  onChange,
}: {
  alias: string;
  cuenta: CuentaMeta;
  cfg: ConfigDestino;
  onChange: (cfg: ConfigDestino) => void;
}) {
  const [paginas, setPaginas] = useState<Opcion[]>([]);
  const [pixeles, setPixeles] = useState<Opcion[]>([]);
  const [instagram, setInstagram] = useState<Opcion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [aviso, setAviso] = useState("");

  // El bloque se monta cuando se marca la cuenta, así que esto corre una vez:
  // sus páginas y píxeles no cambian mientras esté en pantalla.
  useEffect(() => {
    let vivo = true;
    Promise.all([
      get<{ paginas: Opcion[] }>("paginas", { alias, cuenta: cuenta.id }),
      get<{ pixeles: Opcion[] }>("pixeles", { alias, cuenta: cuenta.id }),
    ])
      .then(([p, px]) => {
        if (!vivo) return;
        setPaginas(p.paginas);
        setPixeles(px.pixeles);
      })
      .catch((e) => {
        if (vivo) toast.error(`${cuenta.nombre}: ${e.message}`);
      })
      .finally(() => vivo && setCargando(false));
    return () => {
      vivo = false;
    };
  }, [alias, cuenta.id, cuenta.nombre]);

  function elegirPagina(v: string) {
    const id = v === MANTENER ? "" : v;
    onChange({
      ...cfg,
      page_id: id,
      // El nombre es lo que rellena el {PAGINA} del nombre final. Vacío = el
      // servidor resuelve la del origen.
      page_nombre: id ? (paginas.find((p) => p.id === id)?.nombre ?? "") : "",
      // Al cambiar de página, la cuenta de Instagram elegida deja de valer.
      instagram_id: "",
    });

    // La cuenta de Instagram depende de la página: la del origen deja de valer
    // al cambiarla, y Meta rechaza el anuncio si no coinciden.
    setInstagram([]);
    setAviso("");
    if (!id) return;

    get<{ cuentas: Opcion[] }>("instagram", { alias, pagina: id })
      .then(({ cuentas: lista }) => {
        setInstagram(lista);
        setAviso(
          lista.length
            ? `Cambias de página: se usará una cuenta de Instagram de esa página (${lista.length} disponible/s).`
            : "Cambias de página y no tiene Instagram vinculado. Se usará la cuenta respaldada por la página, que se crea sola.",
        );
      })
      .catch((e) => {
        setInstagram([]);
        setAviso(`No se pudieron listar las cuentas de Instagram: ${e.message}`);
      });
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium">{cuenta.nombre}</span>
        <span className="font-mono text-xs text-muted-foreground">{cuenta.id}</span>
        {cuenta.moneda && (
          <span className="text-xs text-muted-foreground">{cuenta.moneda}</span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="min-w-0 space-y-1.5">
          <Label>Página</Label>
          <Select value={cfg.page_id || MANTENER} onValueChange={alElegir(elegirPagina)}>
            <SelectTrigger className="w-full" disabled={cargando}>
              <SelectValue>
                {cfg.page_id
                  ? (paginas.find((p) => p.id === cfg.page_id)?.nombre ?? cfg.page_id)
                  : cargando
                    ? "cargando…"
                    : "mantener la del origen"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={MANTENER}>mantener la del origen</SelectItem>
              {paginas.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.nombre || p.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-0 space-y-1.5">
          <Label>Píxel</Label>
          <Select
            value={cfg.pixel_id || MANTENER}
            onValueChange={alElegir((v) => onChange({ ...cfg, pixel_id: v === MANTENER ? "" : v }))}
          >
            <SelectTrigger className="w-full" disabled={cargando}>
              <SelectValue>
                {cfg.pixel_id
                  ? (pixeles.find((p) => p.id === cfg.pixel_id)?.nombre ?? cfg.pixel_id)
                  : cargando
                    ? "cargando…"
                    : "mantener el del origen"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={MANTENER}>mantener el del origen</SelectItem>
              {pixeles.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.nombre || p.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-0 space-y-1.5">
          <Label>Instagram</Label>
          <Select
            value={cfg.instagram_id || MANTENER}
            onValueChange={alElegir((v) =>
              onChange({ ...cfg, instagram_id: v === MANTENER ? "" : v }),
            )}
          >
            <SelectTrigger className="w-full" disabled={!cfg.page_id}>
              <SelectValue>
                {cfg.instagram_id
                  ? (instagram.find((i) => i.id === cfg.instagram_id)?.nombre ??
                    cfg.instagram_id)
                  : "automático según la página"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={MANTENER}>
                automático (la que respalda a la página)
              </SelectItem>
              {instagram.map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.nombre} — {i.tipo}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {aviso && <p className="mt-2 text-xs text-muted-foreground">{aviso}</p>}
    </div>
  );
}
