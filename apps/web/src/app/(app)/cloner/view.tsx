"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Search, Play, FlaskConical, Save, AlertTriangle, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/use-confirm";
import {
  aMoneda, alElegir, cargarCampana, fechaHoy, get, post, sinMarcador,
  LIMITE_DIARIO, MARCADOR_PAGINA,
  type CampanaDetalle, type CampanaResumen, type CuentaMeta,
  type TokenInfo,
} from "./api";
import { Destinations, DESTINO_VACIO, type ConfigDestino } from "./destinations";
import {
  AdsetsStep, AJUSTE_POR_DEFECTO,
  type AdsetExtra, type AjusteAdset, type OpcionesEstructura,
} from "./adsets";
import {
  LanguageEditor, ESTADO_VACIO, edicionesParaEnviar, resumenEditor,
  type EstadoEditor,
} from "./language-editor";
import { Cola } from "./cola";
import { SaveTemplateDialog, type PeticionPlantilla } from "./save-template-dialog";

/**
 * Clonar una campaña a una o varias cuentas.
 *
 * El orden de los pasos no es decorativo: cada uno necesita lo elegido en el
 * anterior. Sin cuenta de destino no se pueden listar sus páginas, y sin página
 * no se sabe qué cuentas de Instagram sirven.
 */
export function ClonerView({ puedeEscribir }: { puedeEscribir: boolean }) {
  // Paso 1 — origen
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [aliasOrigen, setAliasOrigen] = useState("");
  const [cuentasOrigen, setCuentasOrigen] = useState<CuentaMeta[]>([]);
  const [cuentaOrigen, setCuentaOrigen] = useState("");
  const [campanas, setCampanas] = useState<CampanaResumen[]>([]);
  const [campanaId, setCampanaId] = useState("");
  const [campana, setCampana] = useState<CampanaDetalle | null>(null);
  const [cargandoCampana, setCargandoCampana] = useState(false);
  const [avanceCarga, setAvanceCarga] = useState("");

  // Paso 2 — contenido por idioma
  const [editor, setEditor] = useState<EstadoEditor>(ESTADO_VACIO);

  // Paso 3 — destinos
  const [aliasDestino, setAliasDestino] = useState("");
  const [cuentasDestino, setCuentasDestino] = useState<CuentaMeta[]>([]);
  const [elegidas, setElegidas] = useState<string[]>([]);
  const [filtro, setFiltro] = useState("");
  const [configDestinos, setConfigDestinos] = useState<Record<string, ConfigDestino>>({});

  // Paso 4 — nombre
  const [producto, setProducto] = useState("");
  const [geo, setGeo] = useState("");
  const [angulo, setAngulo] = useState("");
  const [fecha, setFecha] = useState(fechaHoy());
  const [nombreFinal, setNombreFinal] = useState("");

  // Paso 5 — adsets
  const [ajustes, setAjustes] = useState<Record<string, AjusteAdset>>({});
  const [extra, setExtra] = useState<AdsetExtra[]>([]);
  const [estructura, setEstructura] = useState<OpcionesEstructura>({
    unAdPorAdset: false,
    forzarAbo: false,
    presupuestoAbo: "",
    presupuestoCampana: "",
  });

  // Paso 6 — lanzamiento
  // Lanzar ya no bloquea: la clonación se encola y se puede preparar la
  // siguiente mientras tanto. `versionCola` solo sirve para que la lista se
  // refresque en cuanto se añade una, sin esperar al siguiente sondeo.
  const [versionCola, setVersionCola] = useState(0);
  const [encolando, setEncolando] = useState(false);
  const [peticionPlantilla, setPeticionPlantilla] = useState<PeticionPlantilla | null>(null);

  const { confirmar, dialogo } = useConfirm();

  // ─── Carga inicial de tokens ───────────────────────────────────────────────

  const cargarCuentas = useCallback(
    async (alias: string, destino: boolean) => {
      if (!alias) return;
      try {
        const { cuentas } = await get<{ cuentas: CuentaMeta[] }>("cuentas", { alias });
        // Solo las activas: una cuenta deshabilitada o con pagos pendientes no
        // puede recibir campañas, y en una lista larga solo estorba.
        const activas = cuentas.filter((c) => c.activa);
        if (destino) setCuentasDestino(activas);
        else setCuentasOrigen(activas);
        if (!activas.length) {
          toast.warning(
            `Ese token no alcanza ninguna cuenta activa (${cuentas.length} oculta/s).`,
          );
        }
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "No se pudieron cargar las cuentas");
      }
    },
    [],
  );

  useEffect(() => {
    get<{ tokens: TokenInfo[] }>("tokens")
      .then(({ tokens: lista }) => {
        const validos = lista.filter((t) => t.valido);
        setTokens(validos);
        if (!validos.length) return;
        // Se preselecciona el primero y se cargan sus cuentas: casi siempre hay
        // un solo token, y obligar a desplegarlo para elegirlo sobra.
        const primero = validos[0].alias;
        setAliasOrigen(primero);
        setAliasDestino(primero);
        cargarCuentas(primero, false);
        cargarCuentas(primero, true);
      })
      .catch((e) => toast.error(e.message));
    // Solo al montar: cargarCuentas no cambia entre renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Cambios de selección ──────────────────────────────────────────────────
  // Cada elección invalida lo que venía detrás: cambiar de token deja sin
  // sentido la cuenta elegida, y cambiar de cuenta, la campaña. Se limpia aquí,
  // en el manejador, y no en un efecto: así el reencadenado ocurre en el mismo
  // gesto del usuario en lugar de en un render posterior.

  function elegirTokenOrigen(alias: string) {
    setAliasOrigen(alias);
    setCuentaOrigen("");
    setCampanas([]);
    elegirCampana("");
    cargarCuentas(alias, false);
  }

  function elegirTokenDestino(alias: string) {
    setAliasDestino(alias);
    setElegidas([]);
    setConfigDestinos({});
    cargarCuentas(alias, true);
  }

  function elegirCuentaOrigen(cuenta: string) {
    setCuentaOrigen(cuenta);
    setCampanas([]);
    elegirCampana("");
    if (!cuenta) return;
    get<{ campanas: CampanaResumen[] }>("campanas", { alias: aliasOrigen, cuenta })
      .then(({ campanas: lista }) => setCampanas(lista))
      .catch((e) => toast.error(e.message));
  }

  function elegirCampana(id: string) {
    setCampanaId(id);
    setCampana(null);
    setEditor(ESTADO_VACIO);
    setAjustes({});
    setExtra([]);
    setEstructura({
      unAdPorAdset: false,
      forzarAbo: false,
      presupuestoAbo: "",
      presupuestoCampana: "",
    });
    if (!id) return;

    setCargandoCampana(true);
    setAvanceCarga("");
    cargarCampana(aliasOrigen, id, setAvanceCarga)
      .then((d) => {
        setCampana(d);
        if (d.campana.cbo) {
          // En CBO el presupuesto vive en la campaña, no en los adsets.
          setEstructura((e) => ({
            ...e,
            presupuestoCampana: String(d.campana.presupuesto),
          }));
        }
      })
      .catch((e) => toast.error(e.message))
      .finally(() => setCargandoCampana(false));
  }

  // ─── Nombre compuesto ──────────────────────────────────────────────────────
  // {PAGINA} lo sustituye el servidor por la página de cada cuenta destino: hay
  // una por destino y un solo campo de nombre, así que aquí no se puede resolver.
  // El campo final queda editable, así que se recompone al teclear en las
  // partes y no se deriva del estado.

  function recomponerNombre(cambio: Partial<Record<"producto" | "geo" | "angulo" | "fecha", string>>) {
    const v = { producto, geo, angulo, fecha, ...cambio };
    const partes = [v.producto, v.geo, v.angulo, MARCADOR_PAGINA, v.fecha]
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean);
    // Solo el marcador no es un nombre: hace falta algo más.
    setNombreFinal(partes.length > 1 ? partes.join("_") : "");
  }

  // ─── Cuánto se va a crear y cuánto gasta ───────────────────────────────────

  const previsión = useMemo(() => {
    if (!campana || !elegidas.length) return null;
    const destinos = elegidas.length;
    const ajuste = (id: string) => ajustes[id] ?? AJUSTE_POR_DEFECTO;

    if (estructura.unAdPorAdset) {
      // Un adset por anuncio: el presupuesto de cada uno es el indicado para
      // ABO, o el del adset del que sale si la campaña ya era ABO.
      const porAdset = Number(estructura.presupuestoAbo || 0) / 100;
      let adsets = 0;
      let ads = 0;
      let gasto = 0;
      for (const a of campana.adsets) {
        if (ajuste(a.id).copias < 1) continue;
        adsets += a.ads;
        ads += a.ads;
        const p = porAdset || Number(ajuste(a.id).presupuesto || a.presupuesto || 0) / 100;
        gasto += p * a.ads;
      }
      return {
        destinos,
        adsets: adsets * destinos,
        ads: ads * destinos,
        diario: gasto * destinos,
        origen: "un anuncio en cada adset",
        faltaPresupuesto: !gasto,
      };
    }

    // Al convertir a ABO la campaña se queda sin presupuesto y cada adset lleva
    // el indicado abajo. Es justo el caso que más multiplica el gasto —un solo
    // presupuesto pasa a ser uno por adset— así que tiene que contarse.
    const porAdsetAbo = estructura.forzarAbo
      ? Number(estructura.presupuestoAbo || 0) / 100
      : 0;

    let adsets = 0;
    let ads = 0;
    let gasto = 0;
    for (const a of campana.adsets) {
      const aj = ajuste(a.id);
      adsets += aj.copias;
      ads += aj.copias * a.ads;
      const pres = aj.presupuesto || a.presupuesto;
      if (porAdsetAbo && !aj.presupuesto) gasto += porAdsetAbo * aj.copias;
      else if (pres && (a.diario || porAdsetAbo)) gasto += (Number(pres) / 100) * aj.copias;
    }
    for (const e of extra) {
      const base = campana.adsets.find((a) => a.id === e.base);
      if (!base) continue;
      adsets += 1;
      ads += base.ads;
      const pres = e.presupuesto || base.presupuesto;
      if (porAdsetAbo && !e.presupuesto) gasto += porAdsetAbo;
      else if (pres && (base.diario || porAdsetAbo)) gasto += Number(pres) / 100;
    }

    const cbo =
      campana.campana.cbo && !estructura.forzarAbo
        ? Number(estructura.presupuestoCampana || campana.campana.presupuesto) / 100
        : 0;

    return {
      destinos,
      adsets: adsets * destinos,
      ads: ads * destinos,
      diario: (cbo || gasto) * destinos,
      origen: cbo ? "CBO por campaña" : "suma de los adsets",
      // Sin presupuesto por adset, el motor se detiene antes de crear nada:
      // los adsets de una campaña CBO no traen el suyo y Meta los rechaza.
      faltaPresupuesto: estructura.forzarAbo && !gasto,
    };
  }, [campana, elegidas, ajustes, extra, estructura]);

  // ─── Lanzar ────────────────────────────────────────────────────────────────

  async function lanzar(dryRun: boolean) {
    if (!campanaId) {
      toast.error("Elige una campaña de origen");
      return;
    }
    if (!elegidas.length) {
      toast.error("Elige al menos una cuenta de destino");
      return;
    }

    const ediciones = edicionesParaEnviar(editor);
    const n = resumenEditor(editor);

    if (!dryRun) {
      const ok = await confirmar({
        title: `¿Clonar a ${elegidas.length} cuenta(s)?`,
        description:
          (n.textos || n.videos
            ? `Se aplicarán ${n.textos} cambio(s) de texto y ${n.videos} vídeo(s) sustituido(s). `
            : "") +
          (previsión
            ? `Se crearán ${previsión.adsets} adset(s) y ${previsión.ads} anuncio(s)` +
              (previsión.diario
                ? `, que sumarían ${previsión.diario.toFixed(2)}/día si los activas. `
                : ". ")
            : "") +
          "Todo se crea en PAUSED: nada empieza a gastar solo.",
        detail:
          previsión && previsión.diario > LIMITE_DIARIO
            ? `Ojo: ${previsión.diario.toFixed(2)}/día está por encima de tu límite de ${LIMITE_DIARIO}/día.`
            : undefined,
        confirmLabel: "Clonar",
      });
      if (!ok) return;
    }

    setEncolando(true);
    try {
      await post<{ trabajo: string }>("clonar", {
        alias_origen: aliasOrigen,
        campana: campanaId,
        destinos: elegidas.map((cuenta) => ({
          cuenta,
          alias: aliasDestino,
          ...(configDestinos[cuenta] ?? DESTINO_VACIO),
        })),
        copias_por_adset: Object.fromEntries(
          Object.entries(ajustes).map(([id, a]) => [id, a.copias]),
        ),
        nombres_por_adset: Object.fromEntries(
          Object.entries(ajustes)
            .filter(([, a]) => a.nombre)
            .map(([id, a]) => [id, a.nombre]),
        ),
        presupuestos_por_adset: Object.fromEntries(
          Object.entries(ajustes)
            .filter(([, a]) => a.presupuesto)
            .map(([id, a]) => [id, a.presupuesto]),
        ),
        adsets_extra: extra.map((e) => ({
          base: e.base,
          nombre: e.nombre,
          videos: e.videos,
          presupuesto: e.presupuesto || "",
        })),
        presupuesto_campana:
          campana?.campana.cbo && !estructura.forzarAbo
            ? estructura.presupuestoCampana
            : "",
        un_ad_por_adset: estructura.unAdPorAdset,
        forzar_abo: estructura.forzarAbo,
        presupuesto_abo: estructura.presupuestoAbo,
        nombre_campana: nombreFinal.trim(),
        ediciones,
        // Un mapa por cuenta: cada una recibe el id del vídeo que se le subió.
        videos: editor.videos,
        dry_run: dryRun,
      });
      setVersionCola((n) => n + 1);
      toast.success(
        dryRun
          ? "Simulación en cola: no se creará nada en Meta"
          : "Clonación en cola. Puedes preparar la siguiente mientras se hace.",
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo lanzar");
    } finally {
      setEncolando(false);
    }
  }

  const cuentasFiltradas = cuentasDestino.filter((c) => {
    if (!filtro.trim()) return true;
    const t = filtro.toLowerCase();
    return c.nombre.toLowerCase().includes(t) || c.id.includes(t);
  });

  const elegidasDetalle = cuentasDestino.filter((c) => elegidas.includes(c.id));

  if (!tokens.length) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-medium">No hay ningún token de Meta válido guardado.</p>
        <p className="mt-1">
          Añade uno en <strong>Clonador → Tokens</strong>. Sin token no se puede leer
          ninguna cuenta.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ─── Paso 1 ─────────────────────────────────────────────────────── */}
      <Paso numero={1} titulo="Campaña de origen">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <Label>Token</Label>
            <Select value={aliasOrigen} onValueChange={alElegir(elegirTokenOrigen)}>
              <SelectTrigger className="w-full">
                <SelectValue>{aliasOrigen || "—"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {tokens.map((t) => (
                  <SelectItem key={t.alias} value={t.alias}>
                    {t.alias}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-0 space-y-1.5">
            <Label>Cuenta</Label>
            <Select value={cuentaOrigen} onValueChange={alElegir(elegirCuentaOrigen)}>
              <SelectTrigger className="w-full">
                <SelectValue>
                  {cuentasOrigen.find((c) => c.id === cuentaOrigen)?.nombre ?? "—"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {cuentasOrigen.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.nombre} — {c.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

        </div>

        {/* La campaña va en su propia fila, a todo lo ancho: los nombres siguen
            el patrón PRODUCTO_GEO_ANGULO_PAGINA_FECHA y en un tercio de fila se
            cortaban justo por donde se distinguen unos de otros. */}
        <div className="mt-3 min-w-0 space-y-1.5">
          <Label>Campaña</Label>
          <Select value={campanaId} onValueChange={alElegir(elegirCampana)} disabled={!cuentaOrigen}>
            <SelectTrigger className="w-full">
              <SelectValue>
                {campanas.find((c) => c.id === campanaId)?.nombre ?? "—"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {campanas.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.nombre} · {c.estado}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {cargandoCampana && (
          <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span>{avanceCarga || "Cargando anuncios e idiomas…"}</span>
            <span className="text-xs">
              — una campaña de cien anuncios tarda un poco; si Meta está limitando,
              más.
            </span>
          </div>
        )}

        {campana && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm">
            <span className="font-medium">{campana.campana.nombre}</span>
            <Badge variant="secondary">{campana.campana.objetivo}</Badge>
            <Badge variant="outline">{campana.campana.estado}</Badge>
            <span className="text-muted-foreground">
              {campana.adsets.length} adset(s) · {campana.ads.length} anuncio(s) ·{" "}
              {campana.campana.cbo
                ? `CBO ${aMoneda(campana.campana.presupuesto)}/día`
                : "presupuesto por adset"}
            </span>
          </div>
        )}
      </Paso>

      {/* ─── Paso 2 ─────────────────────────────────────────────────────── */}
      <Paso numero={2} titulo="Cuentas de destino">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <Label>Token</Label>
            <Select value={aliasDestino} onValueChange={alElegir(elegirTokenDestino)}>
              <SelectTrigger className="w-full">
                <SelectValue>{aliasDestino || "—"}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {tokens.map((t) => (
                  <SelectItem key={t.alias} value={t.alias}>
                    {t.alias}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="min-w-0 space-y-1.5">
            <Label>Buscar cuenta</Label>
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filtro}
                onChange={(e) => setFiltro(e.target.value)}
                placeholder="nombre o act_…"
                className="pl-8"
              />
            </div>
          </div>
        </div>

        <div className="mt-3 max-h-64 space-y-1 overflow-y-auto rounded-lg border p-2">
          {cuentasFiltradas.length === 0 && (
            <p className="p-2 text-sm text-muted-foreground">
              {cuentasDestino.length
                ? "Ninguna cuenta coincide con la búsqueda."
                : "Cargando cuentas…"}
            </p>
          )}
          {cuentasFiltradas.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
            >
              <input
                type="checkbox"
                className="rounded border"
                checked={elegidas.includes(c.id)}
                onChange={(e) =>
                  setElegidas(
                    e.target.checked
                      ? [...elegidas, c.id]
                      : elegidas.filter((x) => x !== c.id),
                  )
                }
              />
              <span className="min-w-0 flex-1 truncate">{c.nombre}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{c.id}</span>
            </label>
          ))}
        </div>

        {elegidas.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-sm font-medium">
              Página, píxel e Instagram de cada destino
            </p>
            <Destinations
              alias={aliasDestino}
              cuentas={elegidasDetalle}
              config={configDestinos}
              onChange={(cuenta, cfg) =>
                setConfigDestinos((c) => ({ ...c, [cuenta]: cfg }))
              }
            />
          </div>
        )}
      </Paso>

      {/* ─── Paso 3 ─────────────────────────────────────────────────────── */}
      <Paso
        numero={3}
        titulo="Contenido por idioma"
        opcional
        ayuda="Elige el idioma y cambia su vídeo, su URL y sus textos. Los cambios solo se aplican a la copia; la campaña original no se toca."
      >
        {/* Va después de los destinos porque los vídeos se suben a esas
            cuentas: sin ellas elegidas, el editor no puede subir nada. */}
        {campana && !elegidas.length && (
          <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Para sustituir vídeos, elige antes las cuentas de destino en el paso 2:
            cada una recibe su propia copia del archivo.
          </p>
        )}
        {campana ? (
          <LanguageEditor
            ads={campana.ads}
            estado={editor}
            onChange={setEditor}
            aliasMiniatura={aliasOrigen}
            destino={{ alias: aliasDestino, cuentas: elegidas }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Elige una campaña para ver sus anuncios.
          </p>
        )}
      </Paso>

      {/* ─── Paso 4 ─────────────────────────────────────────────────────── */}
      <Paso numero={4} titulo="Nombre de la campaña">
        <div className="grid gap-3 sm:grid-cols-4">
          <Campo
            label="Producto"
            value={producto}
            onChange={(v) => {
              setProducto(v);
              recomponerNombre({ producto: v });
            }}
            placeholder="BLOSUG"
          />
          <Campo
            label="GEO"
            value={geo}
            onChange={(v) => {
              setGeo(v);
              recomponerNombre({ geo: v });
            }}
            placeholder="US"
          />
          <Campo
            label="Ángulo"
            value={angulo}
            onChange={(v) => {
              setAngulo(v);
              recomponerNombre({ angulo: v });
            }}
            placeholder="VSL"
          />
          <Campo
            label="Fecha"
            value={fecha}
            onChange={(v) => {
              setFecha(v);
              recomponerNombre({ fecha: v });
            }}
          />
        </div>

        <div className="mt-3 space-y-1.5">
          <Label htmlFor="nombre-final">Nombre final</Label>
          <Input
            id="nombre-final"
            value={nombreFinal}
            onChange={(e) => setNombreFinal(e.target.value)}
            placeholder="vacío = mantener el nombre original"
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            <code>{MARCADOR_PAGINA}</code> lo sustituye el servidor por el nombre de la
            página de cada cuenta destino, así que cada campaña sale con la suya. Bórralo
            si no lo quieres, o muévelo de sitio.
          </p>
        </div>
      </Paso>

      {/* ─── Paso 5 ─────────────────────────────────────────────────────── */}
      <Paso
        numero={5}
        titulo="Adsets"
        ayuda="Renombra cada adset, ajusta su presupuesto y elige cuántas copias quieres. Pon 0 para no copiarlo."
      >
        {campana ? (
          <AdsetsStep
            campana={campana}
            ajustes={ajustes}
            setAjustes={setAjustes}
            extra={extra}
            setExtra={setExtra}
            estructura={estructura}
            setEstructura={setEstructura}
            destino={{ alias: aliasDestino, cuentas: elegidas }}
            aliasMiniatura={aliasOrigen}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Elige una campaña para ver sus adsets.
          </p>
        )}
      </Paso>

      {/* ─── Paso 6 ─────────────────────────────────────────────────────── */}
      <Paso numero={6} titulo="Lanzar">
        {previsión && (
          <div
            className={`mb-4 rounded-lg border p-3 text-sm ${
              previsión.diario > LIMITE_DIARIO
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "bg-muted/30"
            }`}
          >
            <p>
              Se crearán <strong>{previsión.destinos} campaña(s)</strong>,{" "}
              <strong>{previsión.adsets} adset(s)</strong> y{" "}
              <strong>{previsión.ads} anuncio(s)</strong>
              {estructura.unAdPorAdset ? ` — ${previsión.origen}` : ""}.
            </p>
            {previsión.faltaPresupuesto ? (
              <p className="mt-1 flex items-center gap-1.5">
                <AlertTriangle className="h-4 w-4" />
                Falta indicar el presupuesto de cada adset.
              </p>
            ) : previsión.diario > 0 ? (
              <p className="mt-1">
                Gasto diario si lo activas todo:{" "}
                <strong>{previsión.diario.toFixed(2)}</strong> ({previsión.origen})
                {previsión.diario > LIMITE_DIARIO && (
                  <span className="ml-1 font-medium">
                    — por encima de tu límite de {LIMITE_DIARIO}/día
                  </span>
                )}
              </p>
            ) : null}
          </div>
        )}

        <p className="mb-3 text-sm text-muted-foreground">
          Todo se crea en <strong>PAUSED</strong>. Nada empieza a gastar.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!puedeEscribir || encolando || !campanaId || !elegidas.length}
            onClick={() => lanzar(true)}
          >
            <FlaskConical className="mr-1.5 h-4 w-4" />
            Simular
          </Button>
          <Button
            disabled={!puedeEscribir || encolando || !campanaId || !elegidas.length}
            onClick={() => lanzar(false)}
          >
            <Play className="mr-1.5 h-4 w-4" />
            Clonar
          </Button>
          <Button
            variant="outline"
            disabled={!puedeEscribir || !campanaId}
            onClick={() =>
              setPeticionPlantilla({
                alias: aliasOrigen,
                campana: campanaId,
                nombreSugerido:
                  sinMarcador(nombreFinal.trim()) ||
                  (campanas.find((c) => c.id === campanaId)?.nombre ?? ""),
                ediciones: edicionesParaEnviar(editor),
              })
            }
          >
            <Save className="mr-1.5 h-4 w-4" />
            Guardar como plantilla
          </Button>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Las clonaciones se hacen de una en una. Al lanzar una, puedes seguir
          preparando la siguiente: entra en la cola y se hará cuando le toque.
        </p>

        <div className="mt-5 border-t pt-4">
          <h3 className="mb-3 text-sm font-medium">Cola de clonaciones</h3>
          <Cola
            version={versionCola}
            puedeEscribir={puedeEscribir}
            onGuardarPlantilla={(campanaDestino, alias) =>
              setPeticionPlantilla({
                alias: alias || aliasDestino,
                campana: campanaDestino,
                nombreSugerido: sinMarcador(nombreFinal.trim()),
                nota: `guardada desde la campaña ya creada ${campanaDestino}`,
              })
            }
          />
        </div>
      </Paso>

      <SaveTemplateDialog
        key={peticionPlantilla?.campana ?? "ninguna"}
        peticion={peticionPlantilla}
        onClose={() => setPeticionPlantilla(null)}
      />
      {dialogo}
    </div>
  );
}

// ─── Piezas de presentación ──────────────────────────────────────────────────

function Paso({
  numero,
  titulo,
  opcional,
  ayuda,
  children,
}: {
  numero: number;
  titulo: string;
  opcional?: boolean;
  ayuda?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-5">
      <h2 className="flex items-center gap-2 text-base font-medium">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
          {numero}
        </span>
        {titulo}
        {opcional && (
          <span className="text-xs font-normal text-muted-foreground">opcional</span>
        )}
      </h2>
      {ayuda && <p className="mt-1.5 text-sm text-muted-foreground">{ayuda}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Campo({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  );
}
