"use client";

/**
 * Cliente del clonador y los tipos que viajan entre la app y el motor.
 *
 * Los nombres de los campos están en español porque son los que devuelve el
 * motor Python tal cual. Traducirlos aquí solo añadiría una capa de mapeo que
 * hay que mantener sincronizada a mano cada vez que se toque el motor.
 */

// ─── Tipos ───────────────────────────────────────────────────────────────────

export interface TokenInfo {
  alias: string;
  token_pista: string;
  usuario: string;
  usuario_id: string;
  valido: boolean;
  error: string;
  verificado: string | null;
  creado: string | null;
}

export interface CuentaMeta {
  id: string;
  nombre: string;
  activa: boolean;
  moneda: string;
  business: string;
}

export interface CampanaResumen {
  id: string;
  nombre: string;
  estado: string;
  objetivo: string;
  presupuesto: string | number;
}

export interface VideoAdset {
  id: string;
  etiquetas: string[];
  miniatura: string;
  anuncio: string;
}

export interface AdsetDetalle {
  id: string;
  nombre: string;
  estado: string;
  presupuesto: string | number;
  diario: boolean;
  ads: number;
  videos: VideoAdset[];
}

export interface CampoIdioma {
  label: string | null;
  valor: string;
  compartido_con: number;
  miniatura?: string;
}

export interface BloqueIdioma {
  indice: number;
  locales: number[];
  idioma: string;
  is_default: boolean;
  campos: Record<string, CampoIdioma>;
}

export interface AdDetalle {
  id: string;
  nombre: string;
  estado?: string;
  adset_id?: string;
  url_tags: string;
  dinamico: boolean;
  bloques: BloqueIdioma[];
  assets: Record<string, number>;
}

export interface CampanaDetalle {
  campana: {
    id: string;
    nombre: string;
    objetivo: string;
    estado: string;
    cuenta: string;
    presupuesto: string | number;
    cbo: boolean;
  };
  adsets: AdsetDetalle[];
  ads: AdDetalle[];
}

export interface Opcion {
  id: string;
  nombre: string;
  tipo?: string;
}

export interface HuecoVideo {
  video_id_original: string;
  etiquetas: string[];
  anuncios: string[];
}

export interface PlantillaResumen {
  id: string;
  nombre: string;
  nota: string;
  creada: string;
  origen_campana: string;
  origen_cuenta: string;
  adsets: number;
  ads: number;
  huecos: HuecoVideo[];
  objetivo: string;
}

export interface PlantillaDetalle {
  plantilla: {
    id: string;
    nombre: string;
    nota: string;
    campana: string;
    objetivo: string;
    adsets: number;
  };
  ads: AdDetalle[];
  huecos: HuecoVideo[];
}

export interface ResultadoDestino {
  cuenta: string;
  alias?: string;
  error?: string;
  campana_destino?: string | null;
  creados?: { adsets: number; ads: number };
  fallos?: string[];
}

/** Una clonación en la cola, tal como la lista la pantalla. */
export interface TrabajoEnCola {
  id: string;
  estado: string;
  error: string;
  /** Se ha pedido pararlo y está terminando la cuenta en curso. */
  parando: boolean;
  creado: string;
  terminado: string | null;
  autor: string;
  lineas: number;
  resultados: number;
  campana: string;
  nombre_campana: string;
  plantilla: string;
  cuentas: string[];
  dry_run: boolean;
}

export interface EstadoTrabajo {
  estado: string;
  lineas: string[];
  resultados: ResultadoDestino[];
  /** Por qué terminó mal, si terminó mal. No es un fallo de la petición. */
  fallo?: string;
}

export interface CopiaHistorial {
  id: string;
  fecha: string;
  campana_origen: string;
  nombre_origen: string;
  cuenta_origen: string;
  cuenta_destino: string;
  nombre_destino: string;
  campana_destino: string;
  adsets: number;
  ads: number;
  copias_pedidas: number;
  dry_run: boolean;
  incidencias: string[];
  detalle: { avisos?: string[] };
}

/** Una edición del contenido de un idioma, tal como la espera el motor. */
export interface Edicion {
  indice?: number;
  tipo: string;
  valor: string;
}

// ─── Llamadas ────────────────────────────────────────────────────────────────

const BASE = "/api/cloner";

/**
 * Las respuestas de error llegan con HTTP 200 y `error` dentro (Cloudflare
 * sustituye los 5xx por su propia página), así que se mira el cuerpo, no el
 * código.
 */
async function leer<T>(res: Response): Promise<T> {
  // La sesión dura 8 h y una configuración de clonado se prepara despacio: si
  // caduca por el camino, el fetch acaba en el login y recibe HTML. Decirlo
  // claro evita que parezca un fallo del clonador.
  if (res.redirected && new URL(res.url).pathname.startsWith("/login")) {
    throw new Error("Tu sesión ha caducado. Vuelve a entrar y repite la acción.");
  }

  // 524 y 504 los pone Cloudflare cuando el servidor tarda más de 100 segundos.
  // Su página de error no dice nada, y "respuesta ilegible" tampoco ayudaba.
  if (res.status === 524 || res.status === 504) {
    throw new Error(
      "La operación tardó más de lo que aguanta la conexión (100 s). Suele ser " +
        "que Meta está limitando las peticiones: espera un minuto y repite.",
    );
  }
  if (res.status === 413) {
    throw new Error(`El archivo es demasiado grande: el máximo son ${MAX_VIDEO_MB} MB.`);
  }

  let datos: unknown;
  try {
    datos = await res.json();
  } catch {
    throw new Error(`Respuesta ilegible del servidor (HTTP ${res.status})`);
  }
  const error = (datos as { error?: string })?.error;
  if (error) throw new Error(error);
  if (!res.ok) throw new Error(`Error del servidor (HTTP ${res.status})`);
  return datos as T;
}

export async function get<T>(ruta: string, params?: Record<string, string>): Promise<T> {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  return leer<T>(await fetch(`${BASE}/${ruta}${qs}`, { cache: "no-store" }));
}

export async function post<T>(
  ruta: string,
  cuerpo: unknown,
  params?: Record<string, string>,
): Promise<T> {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  return leer<T>(
    await fetch(`${BASE}/${ruta}${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo ?? {}),
    }),
  );
}

/**
 * Tope de subida. No es nuestro: Cloudflare rechaza con un 413 propio todo lo
 * que pase de 100 MB, y su página de error no dice qué ha pasado. Se comprueba
 * aquí para poder explicarlo antes de que el usuario espere una subida larga
 * para nada.
 */
export const MAX_VIDEO_MB = 95;

export async function subirVideo(
  alias: string,
  cuenta: string,
  archivo: File,
): Promise<{ video_id: string; nombre: string; limpiado: boolean; estado: string }> {
  const mb = archivo.size / 1048576;
  if (mb > MAX_VIDEO_MB) {
    throw new Error(
      `«${archivo.name}» pesa ${mb.toFixed(0)} MB y el máximo por subida son ` +
        `${MAX_VIDEO_MB} MB. Comprime el vídeo o súbelo desde el Ads Manager y ` +
        `usa su vídeo en el anuncio.`,
    );
  }
  const qs = new URLSearchParams({ alias, cuenta, nombre: archivo.name });
  return leer(
    await fetch(`${BASE}/video?${qs}`, { method: "POST", body: archivo }),
  );
}

/**
 * Lee una campaña entera esperando lo que haga falta.
 *
 * No es una petición larga sino un trabajo que se sondea: una campaña de cien
 * anuncios son varias páginas del Graph API con todo el creativo dentro, y Meta
 * mete esperas de 30 y 60 segundos cuando recibe muchas seguidas. Eso pasa de
 * los 100 segundos que aguanta Cloudflare, que cortaba con un 524 sin explicar
 * nada.
 */
export async function cargarCampana(
  alias: string,
  id: string,
  alAvanzar?: (linea: string) => void,
): Promise<CampanaDetalle> {
  const { trabajo } = await post<{ trabajo: string }>("campana/cargar", { alias, id });

  let ultima = "";
  // Techo de seguridad: diez minutos. Si Meta no ha respondido para entonces,
  // algo va mal y es mejor decirlo que seguir girando.
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const t = await get<EstadoTrabajo>("trabajo", { id: trabajo });

    const linea = t.lineas[t.lineas.length - 1];
    if (linea && linea !== ultima) {
      ultima = linea;
      alAvanzar?.(linea);
    }

    if (t.estado === "terminado") {
      const datos = t.resultados[0] as unknown as CampanaDetalle | undefined;
      if (!datos) throw new Error("La campaña se leyó pero llegó vacía.");
      return datos;
    }
    if (t.estado === "error") {
      throw new Error(t.fallo || "No se pudo leer la campaña.");
    }
  }
  throw new Error(
    "La campaña lleva más de diez minutos cargando. Suele ser que Meta está " +
      "limitando las peticiones: espera un poco y vuelve a intentarlo.",
  );
}

export async function listarTrabajos(): Promise<TrabajoEnCola[]> {
  const { trabajos } = await get<{ trabajos: TrabajoEnCola[] }>("trabajos");
  return trabajos;
}

export async function cancelarTrabajo(id: string): Promise<string> {
  const { resultado } = await post<{ resultado: string }>("trabajos/cancelar", { id });
  return resultado;
}

export function urlMiniatura(alias: string, videoId: string): string {
  if (!alias || !videoId) return "";
  return `${BASE}/miniatura?${new URLSearchParams({ alias, video: videoId })}`;
}

// ─── Utilidades de formato ───────────────────────────────────────────────────

/** Meta trabaja en centavos; las pantallas, en la moneda de la cuenta. */
export function aMoneda(centavos: string | number | null | undefined): string {
  const n = Number(centavos ?? 0);
  return (n / 100).toFixed(2);
}

export function aCentavos(valor: string | number): string {
  return String(Math.round(Number(valor) * 100));
}

export function fechaHoy(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * Hueco que el servidor sustituye por el nombre de la página de cada cuenta
 * destino. No se puede resolver en el navegador: hay una página por destino y
 * un solo campo de nombre.
 */
export const MARCADOR_PAGINA = "{PAGINA}";

export function sinMarcador(nombre: string): string {
  return (nombre || "")
    .replace(`_${MARCADOR_PAGINA}`, "")
    .replace(`${MARCADOR_PAGINA}_`, "")
    .replace(MARCADOR_PAGINA, "");
}

/** Límite de gasto diario por encima del cual conviene avisar. */
export const LIMITE_DIARIO = 200;

/**
 * Adaptador para los selectores: Base UI entrega `null` cuando se deselecciona,
 * y aquí «nada elegido» siempre se representa con la cadena vacía.
 */
export function alElegir(fn: (valor: string) => void) {
  return (valor: string | null) => fn(valor ?? "");
}
