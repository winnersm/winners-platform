"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2, Upload, Film, Check, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  aCentavos, aMoneda, alElegir, subirVideo, urlMiniatura,
  type AdsetDetalle, type CampanaDetalle,
} from "./api";

/** Marca de "esto lo has cambiado tú", igual que en la app original. */
const EDITADO = "border-primary/60 bg-primary/5";

/** Ajustes de un adset original en la copia. */
export interface AjusteAdset {
  copias: number;
  nombre: string;
  /** En centavos, como los espera Meta. Vacío = el del original. */
  presupuesto: string;
}

/** Un adset que no existía en la campaña original. */
export interface AdsetExtra {
  uid: number;
  /** Adset del que copia targeting, presupuesto y anuncios. */
  base: string;
  nombre: string;
  presupuesto: string;
  /**
   * { cuentaDestino: { videoIdOriginal: videoIdNuevo } } — solo de este adset.
   * Por cuenta porque un `video_id` no cruza de una cuenta de Meta a otra.
   */
  videos: Record<string, Record<string, string>>;
  subidas: Record<string, string>;
}

export const AJUSTE_POR_DEFECTO: AjusteAdset = { copias: 1, nombre: "", presupuesto: "" };

export interface OpcionesEstructura {
  unAdPorAdset: boolean;
  forzarAbo: boolean;
  /** En centavos. Obligatorio al convertir a ABO. */
  presupuestoAbo: string;
  /** En centavos. Solo en campañas CBO que siguen siendo CBO. */
  presupuestoCampana: string;
}

export function AdsetsStep({
  campana,
  ajustes,
  setAjustes,
  extra,
  setExtra,
  estructura,
  setEstructura,
  destino,
  aliasMiniatura,
}: {
  campana: CampanaDetalle;
  ajustes: Record<string, AjusteAdset>;
  setAjustes: (a: Record<string, AjusteAdset>) => void;
  extra: AdsetExtra[];
  setExtra: (e: AdsetExtra[]) => void;
  estructura: OpcionesEstructura;
  setEstructura: (o: OpcionesEstructura) => void;
  destino: { alias: string; cuentas: string[] };
  aliasMiniatura: string;
}) {
  const esCbo = campana.campana.cbo;
  const [masivoPres, setMasivoPres] = useState("");
  const [masivoCopias, setMasivoCopias] = useState("");

  const ajuste = (id: string): AjusteAdset => ajustes[id] ?? AJUSTE_POR_DEFECTO;

  function cambiar(id: string, cambio: Partial<AjusteAdset>) {
    setAjustes({ ...ajustes, [id]: { ...ajuste(id), ...cambio } });
  }

  // ─── Edición masiva ────────────────────────────────────────────────────────
  // Con catorce adsets, ponerles el mismo presupuesto uno a uno es inviable.

  function aplicarPresupuesto() {
    if (!masivoPres) {
      toast.error("Escribe el presupuesto que quieres aplicar");
      return;
    }
    if (esCbo) {
      // En CBO el presupuesto vive en la campaña; y al convertir a ABO, en el
      // campo "Presupuesto de cada adset", que ya es un "aplicar a todos".
      toast.error(
        estructura.forzarAbo
          ? "Al convertir a ABO, el presupuesto se pone arriba, en «Presupuesto de cada adset»"
          : "Esta campaña es CBO: el presupuesto va en la campaña, no en los adsets",
      );
      return;
    }
    const centavos = aCentavos(masivoPres);
    const nuevos = { ...ajustes };
    let tocados = 0;
    for (const a of campana.adsets) {
      if (!a.presupuesto) continue; // sin presupuesto propio, nada que aplicar
      nuevos[a.id] = { ...ajuste(a.id), presupuesto: centavos };
      tocados++;
    }
    setAjustes(nuevos);
    // Los adsets añadidos también, para que "todos" signifique todos.
    setExtra(extra.map((e) => ({ ...e, presupuesto: centavos })));
    tocados += extra.length;
    toast.success(`Presupuesto ${Number(masivoPres).toFixed(2)} aplicado a ${tocados} adset(s).`);
  }

  function aplicarCopias() {
    if (masivoCopias === "") {
      toast.error("Escribe cuántas copias quieres");
      return;
    }
    const n = Math.max(0, Number(masivoCopias));
    const nuevos = { ...ajustes };
    for (const a of campana.adsets) nuevos[a.id] = { ...ajuste(a.id), copias: n };
    setAjustes(nuevos);
    toast.success(`${n} copia(s) aplicadas a ${campana.adsets.length} adset(s).`);
  }

  function restaurar() {
    setAjustes({});
    setExtra(extra.map((e) => ({ ...e, presupuesto: "" })));
    setEstructura({
      ...estructura,
      presupuestoCampana: esCbo ? String(campana.campana.presupuesto) : "",
    });
    setMasivoPres("");
    setMasivoCopias("");
    toast.success("Valores originales restaurados.");
  }

  // ─── Adsets añadidos ───────────────────────────────────────────────────────

  function anadirAdset() {
    if (!campana.adsets.length) return;
    const uid = Math.max(0, ...extra.map((e) => e.uid)) + 1;
    setExtra([
      ...extra,
      { uid, base: campana.adsets[0].id, nombre: "", presupuesto: "", videos: {}, subidas: {} },
    ]);
  }

  return (
    <div className="space-y-5">
      {/* Presupuesto de campaña (CBO) */}
      {esCbo && !estructura.forzarAbo && (
        <div className="max-w-xs space-y-1.5">
          <Label htmlFor="cbo">
            Presupuesto de la campaña
            <span className="ml-1 text-xs font-normal text-muted-foreground">CBO, por día</span>
          </Label>
          <Input
            id="cbo"
            type="number"
            min={1}
            step={0.01}
            className={
              estructura.presupuestoCampana &&
              estructura.presupuestoCampana !== String(campana.campana.presupuesto)
                ? EDITADO
                : undefined
            }
            value={aMoneda(estructura.presupuestoCampana || campana.campana.presupuesto)}
            onChange={(e) =>
              setEstructura({
                ...estructura,
                presupuestoCampana: e.target.value ? aCentavos(e.target.value) : "",
              })
            }
          />
        </div>
      )}

      {/* Estructura de la copia */}
      <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
        <h4 className="text-sm font-medium">Estructura de la copia</h4>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 rounded border"
            checked={estructura.unAdPorAdset}
            onChange={(e) => setEstructura({ ...estructura, unAdPorAdset: e.target.checked })}
          />
          <span>
            Un anuncio por adset
            <span className="ml-1 text-xs text-muted-foreground">
              crea un adset por cada anuncio, en vez de meterlos todos juntos
            </span>
          </span>
        </label>

        {esCbo && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 rounded border"
              checked={estructura.forzarAbo}
              onChange={(e) => setEstructura({ ...estructura, forzarAbo: e.target.checked })}
            />
            <span>
              Convertir a ABO
              <span className="ml-1 text-xs text-muted-foreground">
                quita el presupuesto de la campaña y se lo da a cada adset
              </span>
            </span>
          </label>
        )}

        {estructura.forzarAbo && (
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="abo">
              Presupuesto de cada adset
              <span className="ml-1 text-xs font-normal text-muted-foreground">por día</span>
            </Label>
            <Input
              id="abo"
              type="number"
              min={1}
              step={0.01}
              placeholder="ej. 10.00"
              value={estructura.presupuestoAbo ? aMoneda(estructura.presupuestoAbo) : ""}
              onChange={(e) =>
                setEstructura({
                  ...estructura,
                  presupuestoAbo: e.target.value ? aCentavos(e.target.value) : "",
                })
              }
            />
            <p className="text-xs text-muted-foreground">
              Hace falta: los adsets de una campaña CBO no traen presupuesto y, sin él,
              Meta los rechaza.
            </p>
          </div>
        )}

        {(estructura.unAdPorAdset || estructura.forzarAbo) && (
          <p className="text-xs text-muted-foreground">
            {estructura.unAdPorAdset && (
              <>
                Se creará <strong>un adset por cada anuncio</strong>: {campana.ads.length}{" "}
                anuncio(s) → {campana.ads.length} adset(s).{" "}
              </>
            )}
            {estructura.forzarAbo && (
              <>La campaña se creará <strong>sin presupuesto propio</strong> y cada adset llevará el suyo.</>
            )}
          </p>
        )}
      </div>

      {/* Aplicar a todos */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/30 p-4">
        <span className="w-full text-sm font-medium">Aplicar a todos</span>

        {!esCbo && (
          <>
            <div className="w-32 space-y-1.5">
              <Label htmlFor="masivo-pres">Presupuesto</Label>
              <Input
                id="masivo-pres"
                type="number"
                min={1}
                step={0.01}
                placeholder="50.00"
                value={masivoPres}
                onChange={(e) => setMasivoPres(e.target.value)}
              />
            </div>
            <Button size="sm" variant="outline" onClick={aplicarPresupuesto}>
              Aplicar presupuesto
            </Button>
          </>
        )}

        <div className="w-24 space-y-1.5">
          <Label htmlFor="masivo-copias">Copias</Label>
          <Input
            id="masivo-copias"
            type="number"
            min={0}
            max={50}
            placeholder="3"
            value={masivoCopias}
            onChange={(e) => setMasivoCopias(e.target.value)}
          />
        </div>
        <Button size="sm" variant="outline" onClick={aplicarCopias}>
          Aplicar copias
        </Button>

        <Button size="sm" variant="ghost" onClick={restaurar}>
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          Restaurar originales
        </Button>
      </div>

      {/* Tabla de adsets */}
      {campana.adsets.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Esta campaña no tiene adsets.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Adset original</TableHead>
                <TableHead>Nombre en la copia</TableHead>
                <TableHead className="w-36">Presupuesto</TableHead>
                <TableHead className="w-20">Anuncios</TableHead>
                <TableHead className="w-24">Copias</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campana.adsets.map((a) => {
                const aj = ajuste(a.id);
                const descartado = aj.copias < 1;
                return (
                  <TableRow key={a.id} className={descartado ? "opacity-50" : undefined}>
                    <TableCell className="min-w-0 max-w-64">
                      <p className="truncate text-sm font-medium" title={a.nombre}>
                        {a.nombre}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">{a.estado}</p>
                    </TableCell>
                    <TableCell>
                      <Input
                        value={aj.nombre}
                        placeholder={a.nombre}
                        onChange={(e) => cambiar(a.id, { nombre: e.target.value.trim() })}
                        className={`min-w-40 text-sm ${aj.nombre ? EDITADO : ""}`}
                      />
                    </TableCell>
                    <TableCell>
                      {a.presupuesto ? (
                        <>
                          <Input
                            type="number"
                            min={1}
                            step={0.01}
                            className={`w-28 text-sm ${aj.presupuesto ? EDITADO : ""}`}
                            value={aMoneda(aj.presupuesto || a.presupuesto)}
                            onChange={(e) =>
                              cambiar(a.id, {
                                presupuesto: e.target.value ? aCentavos(e.target.value) : "",
                              })
                            }
                          />
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {a.diario ? "por día" : "total"}
                          </p>
                        </>
                      ) : (
                        <span className="font-mono text-xs text-muted-foreground">CBO</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{a.ads}</TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        className={`w-20 text-sm ${aj.copias !== 1 ? EDITADO : ""}`}
                        value={aj.copias}
                        onChange={(e) =>
                          cambiar(a.id, { copias: Math.max(0, Number(e.target.value || 0)) })
                        }
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Adsets añadidos a mano */}
      {extra.map((e) => (
        <AdsetNuevo
          key={e.uid}
          extra={e}
          adsets={campana.adsets}
          destino={destino}
          aliasMiniatura={aliasMiniatura}
          onChange={(n) => setExtra(extra.map((x) => (x.uid === e.uid ? n : x)))}
          onQuitar={() => setExtra(extra.filter((x) => x.uid !== e.uid))}
        />
      ))}

      <div>
        <Button
          size="sm"
          variant="outline"
          onClick={anadirAdset}
          disabled={!campana.adsets.length}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          Añadir adset
        </Button>
        <p className="mt-2 text-xs text-muted-foreground">
          Un adset añadido se copia de uno existente y le pones nombre y vídeos propios.
          Es la vía para escalar con variaciones —mismo targeting, creativo distinto— en
          lugar de copias idénticas.
        </p>
      </div>
    </div>
  );
}

function AdsetNuevo({
  extra,
  adsets,
  destino,
  aliasMiniatura,
  onChange,
  onQuitar,
}: {
  extra: AdsetExtra;
  adsets: AdsetDetalle[];
  destino: { alias: string; cuentas: string[] };
  aliasMiniatura: string;
  onChange: (e: AdsetExtra) => void;
  onQuitar: () => void;
}) {
  const base = adsets.find((a) => a.id === extra.base);
  const [subiendo, setSubiendo] = useState<Record<string, boolean>>({});

  async function subir(videoId: string, archivo: File) {
    if (!destino.cuentas.length) {
      toast.error("Elige antes la cuenta de destino");
      return;
    }
    setSubiendo((s) => ({ ...s, [videoId]: true }));
    try {
      // Una subida por cuenta destino: el mismo id no vale en otra cuenta.
      const videos = { ...extra.videos };
      for (const cuenta of destino.cuentas) {
        const r = await subirVideo(destino.alias, cuenta, archivo);
        videos[cuenta] = { ...(videos[cuenta] ?? {}), [videoId]: r.video_id };
      }
      onChange({
        ...extra,
        videos,
        subidas: { ...extra.subidas, [videoId]: archivo.name },
      });
      toast.success(
        `${archivo.name} subido` +
          (destino.cuentas.length > 1 ? ` a las ${destino.cuentas.length} cuentas` : ""),
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo subir el vídeo");
    } finally {
      setSubiendo((s) => {
        const c = { ...s };
        delete c[videoId];
        return c;
      });
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-dashed bg-card p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 space-y-1.5">
          <Label>Copiar de</Label>
          <Select
            value={extra.base}
            onValueChange={alElegir((v) => onChange({ ...extra, base: v, videos: {}, subidas: {} }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue>{base?.nombre ?? "—"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {adsets.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.nombre}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-56 flex-1 space-y-1.5">
          <Label>Nombre del adset nuevo</Label>
          <Input
            value={extra.nombre}
            placeholder={base?.nombre ?? ""}
            onChange={(e) => onChange({ ...extra, nombre: e.target.value.trim() })}
          />
        </div>

        {base?.presupuesto ? (
          <div className="w-32 space-y-1.5">
            <Label>
              Presupuesto
              <span className="ml-1 text-xs font-normal text-muted-foreground">
                {base.diario ? "por día" : "total"}
              </span>
            </Label>
            <Input
              type="number"
              min={1}
              step={0.01}
              value={aMoneda(extra.presupuesto || base.presupuesto)}
              onChange={(e) =>
                onChange({
                  ...extra,
                  presupuesto: e.target.value ? aCentavos(e.target.value) : "",
                })
              }
            />
          </div>
        ) : null}

        <Button size="sm" variant="ghost" onClick={onQuitar} title="Quitar este adset">
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      <div>
        <h5 className="mb-2 text-sm font-medium">Vídeos</h5>
        {!base?.videos.length ? (
          <p className="text-xs text-muted-foreground">Este adset no tiene vídeos.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {base.videos.map((v) => (
              <VideoExtra
                key={v.id}
                video={v}
                aliasMiniatura={aliasMiniatura}
                nuevo={Object.values(extra.videos)[0]?.[v.id]}
                nombreArchivo={extra.subidas[v.id]}
                subiendo={!!subiendo[v.id]}
                onSubir={(f) => subir(v.id, f)}
              />
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          El vídeo que subas aquí <strong>solo afecta a este adset</strong>: el original y
          los demás conservan el suyo.
        </p>
      </div>
    </div>
  );
}

function VideoExtra({
  video,
  aliasMiniatura,
  nuevo,
  nombreArchivo,
  subiendo,
  onSubir,
}: {
  video: { id: string; etiquetas: string[]; anuncio: string };
  aliasMiniatura: string;
  nuevo?: string;
  nombreArchivo?: string;
  subiendo: boolean;
  onSubir: (archivo: File) => void;
}) {
  const [falloMiniatura, setFalloMiniatura] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const url = urlMiniatura(aliasMiniatura, video.id);

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex aspect-video items-center justify-center bg-muted">
        {url && !falloMiniatura ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setFalloMiniatura(true)}
          />
        ) : (
          <Film className="h-6 w-6 text-muted-foreground" />
        )}
      </div>
      <div className="space-y-2 p-3">
        <p className="truncate text-sm font-medium">
          {video.etiquetas.join("/") || "sin idioma"}
        </p>
        {subiendo ? (
          <p className="text-xs text-muted-foreground">subiendo…</p>
        ) : nuevo ? (
          <p className="flex items-start gap-1 text-xs text-green-700">
            <Check className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0 break-all">
              nuevo: {nuevo}
              {nombreArchivo ? ` · ${nombreArchivo}` : ""}
            </span>
          </p>
        ) : (
          <p className="break-all font-mono text-xs text-muted-foreground">
            actual: {video.id}
          </p>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onSubir(f);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={subiendo}
          onClick={() => fileRef.current?.click()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Upload className="h-3 w-3" />
          Sustituir vídeo
        </button>
      </div>
    </div>
  );
}
