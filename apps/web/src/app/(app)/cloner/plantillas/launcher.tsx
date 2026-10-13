"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { X, Play, FlaskConical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/use-confirm";
import {
  alElegir, get, post, sinMarcador,
  type CuentaMeta, type Opcion, type PlantillaDetalle, type TokenInfo,
} from "../api";
import {
  LanguageEditor, ESTADO_VACIO, edicionesParaEnviar, resumenEditor,
  type EstadoEditor,
} from "../language-editor";
import { JobConsole } from "../job-console";
import { SaveTemplateDialog, type PeticionPlantilla } from "../save-template-dialog";

const MANTENER = "__mantener__";

/**
 * Lanzar una plantilla en una cuenta.
 *
 * Página, píxel e Instagram no se congelan en la plantilla: se eligen aquí,
 * entre los que esa cuenta alcanza de verdad. Y los vídeos tampoco viajan —un
 * `video_id` pertenece a la cuenta donde se subió—, así que el editor por
 * idioma permite subir el archivo, que es la única vía que funciona siempre.
 */
export function TemplateLauncher({
  plantillaId,
  onCerrar,
  onGuardada,
}: {
  plantillaId: string;
  onCerrar: () => void;
  onGuardada?: () => void;
}) {
  const [detalle, setDetalle] = useState<PlantillaDetalle | null>(null);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [alias, setAlias] = useState("");
  const [cuentas, setCuentas] = useState<CuentaMeta[]>([]);
  const [cuenta, setCuenta] = useState("");
  const [paginas, setPaginas] = useState<Opcion[]>([]);
  const [pixeles, setPixeles] = useState<Opcion[]>([]);
  const [instagram, setInstagram] = useState<Opcion[]>([]);
  const [pagina, setPagina] = useState("");
  const [pixel, setPixel] = useState("");
  const [ig, setIg] = useState("");
  const [avisoPagina, setAvisoPagina] = useState("");
  const [copias, setCopias] = useState("1");
  const [nombre, setNombre] = useState("");
  const [editor, setEditor] = useState<EstadoEditor>(ESTADO_VACIO);
  const [trabajo, setTrabajo] = useState<string | null>(null);
  const [lanzando, setLanzando] = useState(false);
  const [peticionPlantilla, setPeticionPlantilla] = useState<PeticionPlantilla | null>(null);

  const { confirmar, dialogo } = useConfirm();

  // Cada elección invalida la siguiente: otro token deja sin sentido la cuenta,
  // y otra cuenta, su página y su píxel. Se limpia en el manejador para que el
  // reencadenado ocurra en el mismo gesto y no en un render posterior.

  function elegirToken(nuevo: string) {
    setAlias(nuevo);
    elegirCuenta("", nuevo);
    if (!nuevo) return;
    get<{ cuentas: CuentaMeta[] }>("cuentas", { alias: nuevo })
      .then(({ cuentas: lista }) => setCuentas(lista.filter((c) => c.activa)))
      .catch((e) => toast.error(e.message));
  }

  function elegirCuenta(nueva: string, conAlias = alias) {
    setCuenta(nueva);
    setPaginas([]);
    setPixeles([]);
    elegirPagina("", conAlias);
    if (!nueva) return;
    Promise.all([
      get<{ paginas: Opcion[] }>("paginas", { alias: conAlias, cuenta: nueva }),
      get<{ pixeles: Opcion[] }>("pixeles", { alias: conAlias, cuenta: nueva }),
    ])
      .then(([p, px]) => {
        setPaginas(p.paginas);
        setPixeles(px.pixeles);
      })
      .catch((e) => toast.error(e.message));
  }

  // La cuenta de Instagram depende de la página: la de la plantilla no vale con
  // otra página, y Meta rechaza el anuncio si no coinciden.
  function elegirPagina(nueva: string, conAlias = alias) {
    setPagina(nueva);
    setIg("");
    setInstagram([]);
    setAvisoPagina("");
    if (!nueva) {
      setPixel("");
      return;
    }
    get<{ cuentas: Opcion[] }>("instagram", { alias: conAlias, pagina: nueva })
      .then(({ cuentas: lista }) => {
        setInstagram(lista);
        setAvisoPagina(
          lista.length
            ? `Cambias de página: se usará una cuenta de Instagram de esa página (${lista.length} disponible/s), no la de la plantilla.`
            : "Cambias de página y no tiene ninguna cuenta de Instagram vinculada. Meta usará la cuenta respaldada por la página, que se crea sola.",
        );
      })
      .catch((e) => {
        setInstagram([]);
        setAvisoPagina(`No se pudieron listar las cuentas de Instagram: ${e.message}`);
      });
  }

  useEffect(() => {
    Promise.all([
      get<PlantillaDetalle>("plantilla", { id: plantillaId }),
      get<{ tokens: TokenInfo[] }>("tokens"),
    ])
      .then(([d, { tokens: lista }]) => {
        setDetalle(d);
        const validos = lista.filter((t) => t.valido);
        setTokens(validos);
        if (validos.length) elegirToken(validos[0].alias);
      })
      .catch((e) => toast.error(e.message));
    // Solo al abrir esta plantilla.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plantillaId]);

  const alTerminar = useCallback(() => setLanzando(false), []);

  async function lanzar(dryRun: boolean) {
    if (!cuenta) {
      toast.error("Elige la cuenta de destino");
      return;
    }
    if (!detalle) return;

    const n = resumenEditor(editor);
    const totales = detalle.huecos.length;

    if (!dryRun && n.videos < totales) {
      const ok = await confirmar({
        title: `¿Lanzar con ${totales - n.videos} vídeo(s) sin sustituir?`,
        description:
          `${totales - n.videos} de ${totales} vídeo(s) siguen siendo los de la plantilla. ` +
          "Un video_id pertenece a la cuenta donde se subió: si esta cuenta no lo tiene, " +
          "esos anuncios fallarán y quedarán en incidencias.",
        confirmLabel: "Lanzar igualmente",
      });
      if (!ok) return;
    }

    setLanzando(true);
    setTrabajo(null);
    try {
      const { trabajo: id } = await post<{ trabajo: string }>("clonar", {
        alias_origen: alias,
        plantilla: detalle.plantilla.id,
        destinos: [
          {
            cuenta,
            alias,
            page_id: pagina,
            page_nombre: pagina ? (paginas.find((p) => p.id === pagina)?.nombre ?? "") : "",
            pixel_id: pixel,
            instagram_id: ig,
          },
        ],
        copias: Number(copias || 1),
        nombre_campana: nombre.trim(),
        ediciones: edicionesParaEnviar(editor),
        videos: editor.videos,
        dry_run: dryRun,
      });
      setTrabajo(id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo lanzar");
      setLanzando(false);
    }
  }

  if (!detalle) {
    return (
      <div className="rounded-lg border bg-card p-5 text-sm text-muted-foreground">
        Cargando la plantilla…
      </div>
    );
  }

  const p = detalle.plantilla;

  return (
    <div className="space-y-5 rounded-lg border-2 border-primary/30 bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-medium">Lanzar «{p.nombre}»</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="truncate">{p.campana}</span>
            <Badge variant="secondary">{p.objetivo}</Badge>
            <span>
              {p.adsets} adset(s) · {detalle.ads.length} anuncio(s) ·{" "}
              {detalle.huecos.length} vídeo(s) sustituibles
            </span>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onCerrar} title="Cerrar">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="min-w-0 space-y-1.5">
          <Label>Token</Label>
          <Select value={alias} onValueChange={alElegir(elegirToken)}>
            <SelectTrigger className="w-full">
              <SelectValue>{alias || "—"}</SelectValue>
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
          <Label>Cuenta de destino</Label>
          <Select value={cuenta} onValueChange={alElegir((v) => elegirCuenta(v))}>
            <SelectTrigger className="w-full">
              <SelectValue>
                {cuentas.find((c) => c.id === cuenta)?.nombre ?? "— elige cuenta —"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {cuentas.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.nombre} — {c.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-28 space-y-1.5">
          <Label htmlFor="copias">Copias del adset</Label>
          <Input
            id="copias"
            type="number"
            min={1}
            max={50}
            value={copias}
            onChange={(e) => setCopias(e.target.value)}
          />
        </div>

        <div className="min-w-0 space-y-1.5">
          <Label>Página</Label>
          <Select
            value={pagina || MANTENER}
            onValueChange={alElegir((v) => elegirPagina(v === MANTENER ? "" : v))}
          >
            <SelectTrigger className="w-full" disabled={!cuenta}>
              <SelectValue>
                {pagina
                  ? (paginas.find((x) => x.id === pagina)?.nombre ?? pagina)
                  : "mantener la de la plantilla"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={MANTENER}>mantener la de la plantilla</SelectItem>
              {paginas.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.nombre || x.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-0 space-y-1.5">
          <Label>Píxel</Label>
          <Select
            value={pixel || MANTENER}
            onValueChange={alElegir((v) => setPixel(v === MANTENER ? "" : v))}
          >
            <SelectTrigger className="w-full" disabled={!cuenta}>
              <SelectValue>
                {pixel
                  ? (pixeles.find((x) => x.id === pixel)?.nombre ?? pixel)
                  : "mantener el de la plantilla"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={MANTENER}>mantener el de la plantilla</SelectItem>
              {pixeles.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.nombre || x.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="min-w-0 space-y-1.5">
          <Label>Instagram</Label>
          <Select value={ig || MANTENER} onValueChange={alElegir((v) => setIg(v === MANTENER ? "" : v))}>
            <SelectTrigger className="w-full" disabled={!pagina}>
              <SelectValue>
                {ig
                  ? (instagram.find((x) => x.id === ig)?.nombre ?? ig)
                  : "automático según la página"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={MANTENER}>automático (la que respalda a la página)</SelectItem>
              {instagram.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.nombre} — {x.tipo}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {avisoPagina && <p className="text-xs text-muted-foreground">{avisoPagina}</p>}

      <div>
        <h3 className="mb-2 text-sm font-medium">Contenido por idioma</h3>
        <p className="mb-3 text-sm text-muted-foreground">
          Los vídeos se suben a la cuenta de destino elegida arriba, así que selecciónala
          antes.
        </p>
        <LanguageEditor
          ads={detalle.ads}
          estado={editor}
          onChange={setEditor}
          aliasMiniatura={alias}
          destino={{ alias, cuentas: cuenta ? [cuenta] : [] }}
          textoVacio="Esta plantilla no lleva contenido por idioma; se lanzará tal cual."
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="nombre-lanz">Nombre de la campaña</Label>
        <Input
          id="nombre-lanz"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
          placeholder="vacío = el nombre de la plantilla"
          className="font-mono text-sm"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={lanzando || !cuenta} onClick={() => lanzar(true)}>
          <FlaskConical className="mr-1.5 h-4 w-4" />
          Simular
        </Button>
        <Button disabled={lanzando || !cuenta} onClick={() => lanzar(false)}>
          <Play className="mr-1.5 h-4 w-4" />
          Lanzar en PAUSED
        </Button>
      </div>

      <JobConsole
        key={trabajo ?? "sin-trabajo"}
        trabajoId={trabajo}
        onTerminar={alTerminar}
        onGuardarPlantilla={(campanaDestino, aliasDestino) =>
          setPeticionPlantilla({
            alias: aliasDestino || alias,
            campana: campanaDestino,
            nombreSugerido: sinMarcador(nombre.trim()) || `${p.nombre} (lanzada)`,
            nota: `guardada desde la campaña ya creada ${campanaDestino}`,
          })
        }
      />

      <SaveTemplateDialog
        key={peticionPlantilla?.campana ?? "ninguna"}
        peticion={peticionPlantilla}
        onClose={() => setPeticionPlantilla(null)}
        onGuardada={onGuardada}
      />
      {dialogo}
    </div>
  );
}
