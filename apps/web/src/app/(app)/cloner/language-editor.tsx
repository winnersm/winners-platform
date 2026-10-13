"use client";

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Upload, Film, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  alElegir, subirVideo, urlMiniatura,
  type AdDetalle, type BloqueIdioma, type CampoIdioma, type Edicion,
} from "./api";

/**
 * Editor del contenido por idioma de los creativos dinámicos.
 *
 * La unidad de trabajo es EL IDIOMA, no el anuncio: se elige un idioma y se
 * edita de una vez el texto que comparten todos los anuncios en ese idioma,
 * porque en la práctica el copy de un idioma es el mismo para todos.
 *
 * Los vídeos sí son distintos en cada anuncio, así que se muestran todos a la
 * vez, con su miniatura, y cada uno se sustituye por separado.
 *
 * Los anuncios no siempre listan los idiomas en el mismo orden, así que se
 * emparejan por sus `locales` (los ids de idioma de Meta), nunca por posición.
 */

/** Marca de "esto lo has cambiado tú", igual que en la app original. */
const EDITADO = "border-primary/60 bg-primary/5";

/** Tarjetas de vídeo que se muestran antes de pedir el resto. */
const VIDEOS_VISIBLES = 9;

const CAMPOS_TEXTO: [string, string][] = [
  ["link_url", "URL de destino"],
  ["title", "Título"],
  ["body", "Texto principal"],
  ["description", "Descripción"],
];

/** Un idioma con el bloque equivalente de cada anuncio que lo tiene. */
interface GrupoIdioma {
  clave: string;
  idioma: string;
  entradas: { adId: string; adNombre: string; bloque: BloqueIdioma }[];
}

export interface EstadoEditor {
  /** { adId: { "indice|tipo": Edicion } } — cambios por idioma */
  ediciones: Record<string, Record<string, Edicion>>;
  /** { adId: { url_tags } } — cambios del anuncio entero */
  creative: Record<string, Record<string, string>>;
  /**
   * { cuentaDestino: { videoIdViejo: videoIdNuevo } }.
   *
   * Va por cuenta y no en global porque en Meta un `video_id` pertenece a la
   * cuenta donde se subió: el mismo id en otra cuenta o no vale, o deja el
   * anuncio colgando del asset ajeno, que es justo el contagio que este
   * clonador existe para evitar. Por eso el archivo se sube una vez por cuenta
   * destino, aunque el usuario solo lo elija una vez.
   */
  videos: Record<string, Record<string, string>>;
  /** { videoIdViejo: nombre de archivo } */
  subidas: Record<string, string>;
  /** ffmpeg no pudo con el formato de estos */
  sinLimpiar: Record<string, boolean>;
}

export const ESTADO_VACIO: EstadoEditor = {
  ediciones: {},
  creative: {},
  videos: {},
  subidas: {},
  sinLimpiar: {},
};

/** Lo que se envía al motor: { adId: [ediciones] }. */
export function edicionesParaEnviar(est: EstadoEditor): Record<string, Edicion[]> {
  const salida: Record<string, Edicion[]> = {};
  for (const [ad, cambios] of Object.entries(est.ediciones)) {
    const lista = Object.values(cambios);
    if (lista.length) salida[ad] = lista;
  }
  for (const [ad, campos] of Object.entries(est.creative)) {
    salida[ad] = salida[ad] ?? [];
    for (const [tipo, valor] of Object.entries(campos)) {
      salida[ad].push({ tipo, valor });
    }
  }
  return salida;
}

/** Los vídeos originales ya sustituidos. Toda cuenta lleva las mismas claves. */
export function videosSustituidos(est: EstadoEditor): Record<string, string> {
  return Object.values(est.videos)[0] ?? {};
}

export function resumenEditor(est: EstadoEditor) {
  const todas = Object.values(est.ediciones).flatMap((c) => Object.values(c));
  // Los vídeos se cuentan por archivo nuevo, no por anuncio: "cambiar solo en
  // este idioma" escribe una edición por cada anuncio que comparta el vídeo, y
  // contarlas todas haría creer que se han sustituido más de los que hay.
  const porEdicion = new Set(
    todas.filter((e) => e.tipo === "video").map((e) => e.valor),
  );
  return {
    textos: todas.filter((e) => e.tipo !== "video").length,
    videos: Object.keys(videosSustituidos(est)).length + porEdicion.size,
    tags: Object.keys(est.creative).length,
  };
}

export function LanguageEditor({
  ads,
  estado,
  onChange,
  aliasMiniatura,
  destino,
  textoVacio,
}: {
  ads: AdDetalle[];
  estado: EstadoEditor;
  onChange: (e: EstadoEditor) => void;
  /** Con qué token se piden las miniaturas (el del origen). */
  aliasMiniatura: string;
  /** A dónde se suben los vídeos nuevos: una subida por cuenta destino. */
  destino: { alias: string; cuentas: string[] };
  textoVacio?: string;
}) {
  const [indiceIdioma, setIndiceIdioma] = useState(0);
  const [subiendo, setSubiendo] = useState<Record<string, string>>({});
  const [todosLosVideos, setTodosLosVideos] = useState(false);

  const dinamicos = useMemo(() => ads.filter((a) => a.dinamico), [ads]);

  // Los vídeos ya sustituidos, para pintar. Da igual la cuenta: todas llevan
  // las mismas claves, solo cambia el id nuevo de cada una.
  const sustituidos = videosSustituidos(estado);

  // Agrupar por idioma: un idioma reúne el bloque equivalente de cada anuncio.
  const idiomas = useMemo<GrupoIdioma[]>(() => {
    const lista: GrupoIdioma[] = [];
    const porClave = new Map<string, GrupoIdioma>();
    for (const ad of dinamicos) {
      for (const b of ad.bloques ?? []) {
        const clave = (b.locales ?? []).join(",") || b.idioma;
        let g = porClave.get(clave);
        if (!g) {
          g = { clave, idioma: b.idioma, entradas: [] };
          porClave.set(clave, g);
          lista.push(g);
        }
        g.entradas.push({ adId: ad.id, adNombre: ad.nombre, bloque: b });
      }
    }
    return lista;
  }, [dinamicos]);

  const actual = idiomas[Math.min(indiceIdioma, Math.max(0, idiomas.length - 1))];

  /** Igual que el original: un campo de texto escribe en todos los anuncios de ese idioma. */
  function escribirTexto(g: GrupoIdioma, tipo: string, valor: string) {
    const ediciones = { ...estado.ediciones };
    for (const e of g.entradas) {
      if (!e.bloque.campos[tipo]?.label) continue;
      const cambios = { ...(ediciones[e.adId] ?? {}) };
      const clave = `${e.bloque.indice}|${tipo}`;
      const original = e.bloque.campos[tipo]?.valor ?? "";
      if (valor === original) delete cambios[clave];
      else cambios[clave] = { indice: e.bloque.indice, tipo, valor };
      if (Object.keys(cambios).length) ediciones[e.adId] = cambios;
      else delete ediciones[e.adId];
    }
    onChange({ ...estado, ediciones });
  }

  function escribirTags(valor: string) {
    const creative = { ...estado.creative };
    for (const a of dinamicos) {
      const campos = { ...(creative[a.id] ?? {}) };
      if (valor === (a.url_tags ?? "")) delete campos.url_tags;
      else campos.url_tags = valor;
      if (Object.keys(campos).length) creative[a.id] = campos;
      else delete creative[a.id];
    }
    onChange({ ...estado, creative });
  }

  /** El valor que hoy comparten todos los anuncios de este idioma. */
  function valorComun(g: GrupoIdioma, tipo: string) {
    const valores = g.entradas.map((e) => {
      const editado = estado.ediciones[e.adId]?.[`${e.bloque.indice}|${tipo}`];
      return editado ? editado.valor : (e.bloque.campos[tipo]?.valor ?? "");
    });
    return { valor: valores[0] ?? "", uniforme: valores.every((v) => v === valores[0]) };
  }

  function tagsComunes() {
    const valores = dinamicos.map((a) => {
      const e = estado.creative[a.id]?.url_tags;
      return e !== undefined ? e : (a.url_tags ?? "");
    });
    return { valor: valores[0] ?? "", uniforme: valores.every((v) => v === valores[0]) };
  }

  /** ¿Se ha tocado este campo en este idioma? Marca el recuadro. */
  function tocadoCampo(g: GrupoIdioma, tipo: string): boolean {
    return g.entradas.some(
      (e) => !!estado.ediciones[e.adId]?.[`${e.bloque.indice}|${tipo}`],
    );
  }

  function tocado(g: GrupoIdioma): boolean {
    return g.entradas.some((e) => {
      const cambios = estado.ediciones[e.adId] ?? {};
      const porTexto = Object.values(cambios).some((c) => c.indice === e.bloque.indice);
      const v = e.bloque.campos.video;
      return porTexto || (!!v && !!sustituidos[v.valor]);
    });
  }

  /**
   * Sube el archivo a TODAS las cuentas destino y devuelve el id que le tocó en
   * cada una. Es una subida por cuenta porque un `video_id` no cruza de cuenta:
   * reutilizar el de la primera dejaría a las demás con un anuncio colgando de
   * un asset ajeno —y sin avisar—.
   */
  async function subirACadaCuenta(
    archivo: File,
  ): Promise<{ porCuenta: Record<string, string>; limpiado: boolean; listo: boolean }> {
    const porCuenta: Record<string, string> = {};
    let limpiado = true;
    let listo = true;
    for (const cuenta of destino.cuentas) {
      const r = await subirVideo(destino.alias, cuenta, archivo);
      porCuenta[cuenta] = r.video_id;
      if (r.limpiado === false) limpiado = false;
      if (r.estado && r.estado !== "ready") listo = false;
    }
    return { porCuenta, limpiado, listo };
  }

  function avisoSubida(archivo: File, limpiado: boolean, listo: boolean, cuantos: number) {
    const cuentas = destino.cuentas.length;
    toast.success(
      `${archivo.name} subido` +
        (cuentas > 1 ? ` a las ${cuentas} cuentas` : "") +
        (cuantos > 1 ? ` y aplicado a ${cuantos} vídeo(s)` : "") +
        (!limpiado ? ", sin poder limpiar sus metadatos" : "") +
        (!listo ? ". Meta lo está procesando: dale un minuto antes de clonar" : ""),
    );
  }

  async function subir(
    archivo: File,
    original: string,
    /** Los bloques de ESTE idioma que usan ese vídeo: pueden ser varios anuncios. */
    entradas: { adId: string; indice: number }[],
    soloEsteIdioma: boolean,
  ) {
    if (!destino.cuentas.length) {
      toast.error("Elige primero la cuenta de destino: el vídeo se sube a esa cuenta.");
      return;
    }
    setSubiendo((s) => ({
      ...s,
      [original]: `subiendo ${archivo.name} (${(archivo.size / 1048576).toFixed(1)} MB)…`,
    }));
    try {
      const { porCuenta, limpiado, listo } = await subirACadaCuenta(archivo);
      const nuevo = { ...estado };
      nuevo.subidas = { ...estado.subidas, [original]: archivo.name };
      // Si ffmpeg no pudo con el formato, el vídeo sube igual pero hay que decirlo.
      nuevo.sinLimpiar = { ...estado.sinLimpiar };
      if (!limpiado) nuevo.sinLimpiar[original] = true;
      else delete nuevo.sinLimpiar[original];

      if (soloEsteIdioma) {
        // Una edición lleva un solo id, así que esta vía solo vale con una
        // cuenta; la casilla se desactiva cuando hay más (ver TarjetaVideo).
        //
        // Va una edición por cada anuncio que use ese vídeo en este idioma:
        // cuando varios comparten el mismo `video_id`, "solo en este idioma"
        // significa en todos ellos, no en uno al azar.
        const ediciones = { ...estado.ediciones };
        for (const { adId, indice } of entradas) {
          const cambios = { ...(ediciones[adId] ?? {}) };
          cambios[`${indice}|video`] = {
            indice,
            tipo: "video",
            valor: porCuenta[destino.cuentas[0]],
          };
          ediciones[adId] = cambios;
        }
        nuevo.ediciones = ediciones;
      } else {
        nuevo.videos = { ...estado.videos };
        for (const [cuenta, id] of Object.entries(porCuenta)) {
          nuevo.videos[cuenta] = { ...(nuevo.videos[cuenta] ?? {}), [original]: id };
        }
      }
      onChange(nuevo);
      avisoSubida(archivo, limpiado, listo, 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo subir el vídeo");
    } finally {
      setSubiendo((s) => {
        const copia = { ...s };
        delete copia[original];
        return copia;
      });
    }
  }

  /**
   * Un solo archivo para muchos vídeos a la vez.
   *
   * Una campaña de cien adsets suele llevar cien anuncios con el MISMO vídeo,
   * pero cada uno con su propio `video_id` —son cien copias del mismo archivo
   * en Meta—. Tarjeta por tarjeta habría que subirlo cien veces.
   *
   * Como la sustitución es un mapa `video viejo → video nuevo`, basta con subir
   * una vez y apuntar los cien al mismo archivo. De paso, la clonación va mucho
   * más rápida: el motor ya no descarga y resube cien vídeos, solo cambia ids.
   */
  async function subirParaTodos(archivo: File, originales: string[]) {
    if (!destino.cuentas.length) {
      toast.error("Elige primero la cuenta de destino: el vídeo se sube a esa cuenta.");
      return;
    }
    const aviso =
      `subiendo ${archivo.name} (${(archivo.size / 1048576).toFixed(1)} MB) ` +
      `para ${originales.length} vídeos…`;
    setSubiendo(Object.fromEntries(originales.map((o) => [o, aviso])));
    try {
      const { porCuenta, limpiado, listo } = await subirACadaCuenta(archivo);

      const videos = { ...estado.videos };
      for (const [cuenta, id] of Object.entries(porCuenta)) {
        const mapa = { ...(videos[cuenta] ?? {}) };
        for (const original of originales) mapa[original] = id;
        videos[cuenta] = mapa;
      }

      const subidas = { ...estado.subidas };
      const sinLimpiar = { ...estado.sinLimpiar };
      for (const original of originales) {
        subidas[original] = archivo.name;
        if (!limpiado) sinLimpiar[original] = true;
        else delete sinLimpiar[original];
      }
      onChange({ ...estado, videos, subidas, sinLimpiar });
      avisoSubida(archivo, limpiado, listo, originales.length);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo subir el vídeo");
    } finally {
      setSubiendo({});
    }
  }

  if (!dinamicos.length || !idiomas.length) {
    return (
      <p className="rounded-lg border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground">
        {textoVacio ??
          "Ningún anuncio usa contenido por idioma, así que no hay nada que editar. La copia se hará tal cual."}
      </p>
    );
  }

  const n = resumenEditor(estado);
  const tags = tagsComunes();
  const conVideo = actual.entradas.filter((e) => e.bloque.campos.video?.label);

  /**
   * Una tarjeta por VÍDEO, no por anuncio.
   *
   * En estas campañas lo normal es que varios anuncios del mismo idioma usen
   * el mismo `video_id`. Pintar una tarjeta idéntica por anuncio llenaba la
   * pantalla y daba a entender que había que subir el archivo una vez por
   * tarjeta, cuando la sustitución va por id: con una basta y se aplica a
   * todos los anuncios que lo usen.
   */
  const grupos: {
    videoId: string;
    campo: CampoIdioma;
    anuncios: string[];
    entradas: { adId: string; indice: number }[];
  }[] = [];
  const posicion = new Map<string, number>();
  for (const e of conVideo) {
    const id = e.bloque.campos.video.valor;
    let i = posicion.get(id);
    if (i === undefined) {
      i = grupos.length;
      posicion.set(id, i);
      grupos.push({ videoId: id, campo: e.bloque.campos.video, anuncios: [], entradas: [] });
    }
    grupos[i].anuncios.push(e.adNombre);
    grupos[i].entradas.push({ adId: e.adId, indice: e.bloque.indice });
  }
  const visibles = todosLosVideos ? grupos : grupos.slice(0, VIDEOS_VISIBLES);

  // Los vídeos distintos de este idioma y los de toda la campaña. Se cuentan
  // por video_id, y los anuncios aparte: un mismo archivo puede estar repetido
  // en cien anuncios con cien ids, o ser un solo id compartido por los cien.
  const idsIdioma = grupos.map((g) => g.videoId);
  const bloquesCampana = idiomas.flatMap((g) =>
    g.entradas.filter((e) => e.bloque.campos.video?.label),
  );
  const idsCampana = [...new Set(bloquesCampana.map((e) => e.bloque.campos.video.valor))];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 space-y-1.5">
          <Label>Idioma</Label>
          <Select
            value={String(indiceIdioma)}
            onValueChange={alElegir((v) => {
              setIndiceIdioma(Number(v));
              // Cada idioma tiene sus propios vídeos: el "ver todos" del
              // anterior no debe arrastrarse al siguiente.
              setTodosLosVideos(false);
            })}
          >
            <SelectTrigger className="w-full">
              <SelectValue>{actual.idioma}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {idiomas.map((g, i) => (
                <SelectItem key={g.clave} value={String(i)}>
                  {g.idioma}
                  {tocado(g) ? "  •  editado" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Badge variant="secondary" className="mb-1.5">
          Se edita en {actual.entradas.length} anuncio(s)
        </Badge>
      </div>

      {/* Con cien anuncios, la lista entera de nombres tapaba el editor. */}
      <p className="text-xs text-muted-foreground">
        {actual.entradas
          .slice(0, 6)
          .map((e) => e.adNombre)
          .join(", ")}
        {actual.entradas.length > 6 && ` y ${actual.entradas.length - 6} más`}
      </p>

      {conVideo.length > 0 && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-sm font-medium">
              Vídeos en {actual.idioma}
              <span className="ml-1.5 font-normal text-muted-foreground">
                {grupos.length}
                {conVideo.length > grupos.length && ` en ${conVideo.length} anuncios`}
              </span>
            </h4>
            {/* Una campaña de cien anuncios son cien tarjetas: se muestran las
                primeras y el resto bajo demanda, para poder llegar a los pasos
                siguientes sin recorrer media pantalla de vídeos. */}
            {grupos.length > VIDEOS_VISIBLES && (
              <button
                type="button"
                onClick={() => setTodosLosVideos((v) => !v)}
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
              >
                {todosLosVideos
                  ? `mostrar solo ${VIDEOS_VISIBLES}`
                  : `ver los ${grupos.length - VIDEOS_VISIBLES} restantes`}
              </button>
            )}
          </div>

          <SubidaParaTodos
            idsIdioma={idsIdioma}
            idsCampana={idsCampana}
            anunciosIdioma={conVideo.length}
            anunciosCampana={bloquesCampana.length}
            idioma={actual.idioma}
            ocupado={Object.keys(subiendo).length > 0}
            sustituidos={idsIdioma.filter((id) => !!sustituidos[id]).length}
            onSubir={subirParaTodos}
          />

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibles.map((g) => (
              <TarjetaVideo
                key={g.videoId}
                anuncios={g.anuncios}
                campo={g.campo}
                aliasMiniatura={aliasMiniatura}
                sustituto={
                  estado.ediciones[g.entradas[0].adId]?.[`${g.entradas[0].indice}|video`]?.valor ??
                  sustituidos[g.videoId]
                }
                nombreArchivo={estado.subidas[g.videoId]}
                sinLimpiar={!!estado.sinLimpiar[g.videoId]}
                estadoSubida={subiendo[g.videoId]}
                variasCuentas={destino.cuentas.length > 1}
                onSubir={(archivo, soloEste) =>
                  subir(archivo, g.videoId, g.entradas, soloEste)
                }
              />
            ))}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <h4 className="text-sm font-medium">Textos en {actual.idioma}</h4>

        {CAMPOS_TEXTO.map(([tipo, etiqueta]) => {
          if (!actual.entradas.some((e) => e.bloque.campos[tipo]?.label)) return null;
          const c = valorComun(actual, tipo);
          const largo = tipo === "body" || tipo === "description";
          return (
            <div key={tipo} className="space-y-1.5">
              <Label>
                {etiqueta}
                {!c.uniforme && (
                  <span className="ml-2 text-xs font-normal text-amber-700">
                    los anuncios tenían textos distintos: al escribir aquí quedarán iguales
                  </span>
                )}
              </Label>
              {largo ? (
                <Textarea
                  key={`${actual.clave}-${tipo}`}
                  defaultValue={c.valor}
                  rows={3}
                  className={tocadoCampo(actual, tipo) ? EDITADO : undefined}
                  onChange={(ev) => escribirTexto(actual, tipo, ev.target.value)}
                />
              ) : (
                <Input
                  key={`${actual.clave}-${tipo}`}
                  defaultValue={c.valor}
                  className={`${tipo === "link_url" ? "font-mono text-xs" : ""} ${
                    tocadoCampo(actual, tipo) ? EDITADO : ""
                  }`}
                  onChange={(ev) => escribirTexto(actual, tipo, ev.target.value)}
                />
              )}
            </div>
          );
        })}

        <div className="space-y-1.5">
          <Label>
            Parámetros de URL
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              se aplican a todos los idiomas del anuncio
            </span>
            {!tags.uniforme && (
              <span className="ml-2 text-xs font-normal text-amber-700">
                los anuncios tenían parámetros distintos
              </span>
            )}
          </Label>
          <Textarea
            defaultValue={tags.valor}
            rows={2}
            spellCheck={false}
            className={`font-mono text-xs ${
              Object.keys(estado.creative).length ? EDITADO : ""
            }`}
            placeholder="vacío = sin parámetros"
            onChange={(ev) => escribirTags(ev.target.value)}
          />
        </div>
      </div>

      <p className="text-xs">
        {n.textos || n.videos || n.tags ? (
          <span className="text-foreground">
            {n.textos} cambio(s) de texto · {n.videos} vídeo(s) sustituido(s)
            {n.tags ? ` · parámetros de URL en ${n.tags} anuncio(s)` : ""}
          </span>
        ) : (
          <span className="text-muted-foreground">sin cambios: se copia tal cual</span>
        )}
      </p>
    </div>
  );
}

/**
 * Subir un archivo una vez y aplicarlo a muchos vídeos.
 *
 * Aparece siempre que el idioma tenga algún vídeo, porque los dos casos que
 * importan se parecen poco:
 *
 * - Cien adsets con el mismo creativo: cada anuncio tiene su propia copia del
 *   archivo en Meta y, por tanto, su propio `video_id`. Son cien tarjetas.
 * - Tres anuncios en veintiséis idiomas que comparten un puñado de vídeos: en
 *   cada idioma hay UN solo id, así que por tarjeta no se nota, pero sustituir
 *   el vídeo de toda la campaña exigiría recorrer los veintiséis idiomas. Para
 *   eso está el ámbito "toda la campaña".
 *
 * Condicionarlo a "más de un vídeo en este idioma" escondía justo el segundo.
 */
function SubidaParaTodos({
  idsIdioma,
  idsCampana,
  anunciosIdioma,
  anunciosCampana,
  idioma,
  ocupado,
  sustituidos,
  onSubir,
}: {
  idsIdioma: string[];
  idsCampana: string[];
  /** Anuncios de este idioma que llevan vídeo (pueden compartir id). */
  anunciosIdioma: number;
  /** Lo mismo, contando todos los idiomas. */
  anunciosCampana: number;
  idioma: string;
  ocupado: boolean;
  sustituidos: number;
  onSubir: (archivo: File, originales: string[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [ambito, setAmbito] = useState<"idioma" | "campana">("idioma");

  // Si todos los idiomas comparten los mismos vídeos, elegir ámbito no aporta.
  const hayMasFuera = idsCampana.length > idsIdioma.length;
  const objetivo = ambito === "campana" ? idsCampana : idsIdioma;
  const campana = ambito === "campana";
  const anuncios = campana ? anunciosCampana : anunciosIdioma;
  const donde = campana ? "toda la campaña" : idioma;

  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">¿Es el mismo vídeo para todos?</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {objetivo.length === 1
              ? `Los ${anuncios} anuncios de ${donde} usan el mismo vídeo: súbelo una vez y se cambia en todos.`
              : `Súbelo una vez y sustituye los ${objetivo.length} vídeos de ${donde} ` +
                `(${anuncios} anuncios) de golpe, en vez de ir tarjeta por tarjeta. ` +
                `Además la copia va mucho más rápida.`}
            {sustituidos > 0 && ` Ya has sustituido ${sustituidos} de ${idsIdioma.length}.`}
          </p>
        </div>

        {hayMasFuera && (
          <Select
            value={ambito}
            onValueChange={alElegir((v) => setAmbito(v as "idioma" | "campana"))}
          >
            <SelectTrigger className="w-fit" size="sm">
              <SelectValue>
                {ambito === "campana"
                  ? `toda la campaña (${idsCampana.length})`
                  : `solo ${idioma} (${idsIdioma.length})`}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="idioma">
                solo {idioma} ({idsIdioma.length})
              </SelectItem>
              <SelectItem value="campana">
                toda la campaña ({idsCampana.length})
              </SelectItem>
            </SelectContent>
          </Select>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onSubir(f, objetivo);
            e.target.value = "";
          }}
        />
        <Button size="sm" disabled={ocupado} onClick={() => fileRef.current?.click()}>
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          {objetivo.length === 1
            ? `Subir uno para los ${anuncios} anuncios`
            : `Subir uno para los ${objetivo.length}`}
        </Button>
      </div>
    </div>
  );
}

function TarjetaVideo({
  anuncios,
  campo,
  aliasMiniatura,
  sustituto,
  nombreArchivo,
  sinLimpiar,
  estadoSubida,
  variasCuentas,
  onSubir,
}: {
  /** Los anuncios de este idioma que usan este vídeo. Casi siempre varios. */
  anuncios: string[];
  campo: { valor: string; compartido_con: number };
  aliasMiniatura: string;
  sustituto?: string;
  nombreArchivo?: string;
  sinLimpiar: boolean;
  estadoSubida?: string;
  variasCuentas: boolean;
  onSubir: (archivo: File, soloEsteIdioma: boolean) => void;
}) {
  const [soloEste, setSoloEste] = useState(false);
  const [falloMiniatura, setFalloMiniatura] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const url = urlMiniatura(aliasMiniatura, campo.valor);

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
        <p className="truncate text-sm font-medium" title={anuncios.join("\n")}>
          {anuncios[0]}
        </p>
        {anuncios.length > 1 && (
          <p className="text-xs text-muted-foreground">
            y {anuncios.length - 1} anuncio(s) más con este mismo vídeo
          </p>
        )}

        {estadoSubida ? (
          <p className="text-xs text-muted-foreground">{estadoSubida}</p>
        ) : sustituto ? (
          <p className="flex items-start gap-1 text-xs text-green-700">
            <Check className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0 break-all">
              nuevo: {sustituto}
              {nombreArchivo ? ` · ${nombreArchivo}` : ""}
              {sinLimpiar ? " · sin limpiar metadatos" : ""}
            </span>
          </p>
        ) : (
          <p className="break-all font-mono text-xs text-muted-foreground">
            actual: {campo.valor}
          </p>
        )}

        {campo.compartido_con > 0 && (
          <p className="text-xs text-amber-700">
            lo usan {campo.compartido_con} idioma(s) más
          </p>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onSubir(f, soloEste);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          disabled={!!estadoSubida}
          onClick={() => fileRef.current?.click()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors hover:bg-accent disabled:opacity-50"
        >
          <Upload className="h-3 w-3" />
          Sustituir vídeo
        </button>

        {campo.compartido_con > 0 && (
          <label
            className="flex items-center gap-2 text-xs text-muted-foreground"
            // Desdoblar la etiqueta guarda UN id de vídeo, y con varias cuentas
            // destino haría falta uno por cuenta: no hay dónde ponerlos.
            title={
              variasCuentas
                ? "Solo disponible con una cuenta de destino: el vídeo de cada cuenta es distinto"
                : undefined
            }
          >
            <input
              type="checkbox"
              className="rounded border"
              disabled={variasCuentas}
              checked={soloEste && !variasCuentas}
              onChange={(e) => setSoloEste(e.target.checked)}
            />
            cambiar solo en este idioma
          </label>
        )}
      </div>
    </div>
  );
}
