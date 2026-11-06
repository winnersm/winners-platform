// Traduce cada llamada a Meta a lenguaje claro para «Llamadas a Meta». Sin dependencias
// de servidor: lo usan tanto la API como la vista. Las llamadas de los servicios Python
// llegan con el mismo formato, así que solo hace falta explicarlas aquí.

/** Duración y tope del detalle llamada a llamada (también en los meta_calls.py de los servicios). */
export const META_CALL_LOG_DAYS = 7;
export const META_CALL_LOG_MAX_PER_HOUR = 20_000;

export const SOURCE_LABELS: Record<string, string> = {
  panel: "Panel (uso de las personas)",
  sincronizar: "Botón «Sincronizar con Meta»",
  SYNC_LISTINGS: "Sincronización de listados",
  SYNC_LISTINGS_ACCOUNT: "Sincronización tras el botón",
  SYNC_DASHBOARD: "Sincronización de Rendimiento",
  SYNC_FANPAGES: "Sincronización de fanpages",
  SYNC_SPEND_DAILY: "Gasto diario",
  SYNC_ACCOUNTS: "Sincronización de cuentas",
  SYNC_ACTIVE_ADS: "Sincronización de anuncios activos",
  CREATE_PBIA_BULK: "Creación de PBIA",
  DUPLICATE_CAMPAIGN: "Duplicar campañas",
  DUPLICATE_ADSET: "Duplicar ad sets",
  DUPLICATE_AD: "Duplicar anuncios",
  DEEP_COPY: "Copia profunda",
  CLONER: "Clonador",
  BILLING_CHECK: "Automatización: estado de pagos",
  META_AUTOPAUSE: "Automatización: autopausa",
  META_CLEANUP: "Automatización: limpieza de anuncios",
  UPDATE_SHEET: "Automatización: Google Sheet y Live Tracker",
};
export const sourceLabel = (s: string) => SOURCE_LABELS[s] ?? s;

const READS: Record<string, string> = {
  campaigns: "Leer las campañas",
  adsets: "Leer los ad sets",
  ads: "Leer los anuncios",
  adcreatives: "Leer los creativos",
  adimages: "Leer las imágenes",
  advideos: "Leer los vídeos",
  adspixels: "Leer los píxeles",
  me: "Comprobar el token: a quién pertenece",
  "me/adaccounts": "Listar las cuentas publicitarias del token",
  "me/accounts": "Listar las fanpages del token",
  "me/permissions": "Comprobar los permisos del token",
  page_backed_instagram_accounts: "Leer el Instagram ligado a la fanpage (PBIA)",
  search: "Buscar en el catálogo de Meta",
  cuenta: "Consultar datos de la cuenta",
  objeto: "Consultar un objeto de Meta",
};

const WRITES: Record<string, string> = {
  campaigns: "Crear una campaña",
  adsets: "Crear un ad set",
  ads: "Crear un anuncio",
  adcreatives: "Crear un creativo",
  adimages: "Subir una imagen",
  advideos: "Subir un vídeo",
  copies: "Duplicar con la copia de Meta",
  page_backed_instagram_accounts: "Crear el Instagram ligado a la fanpage (PBIA)",
  objeto: "Actualizar un objeto de Meta",
};

const LEVELS: Record<string, string> = { account: "cuenta", campaign: "campaña", adset: "ad set", ad: "anuncio" };

const PERIODS: Record<string, string> = {
  today: "hoy", yesterday: "ayer", last_3d: "últimos 3 días", last_7d: "últimos 7 días",
  last_14d: "últimos 14 días", last_30d: "últimos 30 días", this_month: "este mes",
  last_month: "mes pasado", maximum: "todo el historial", rango: "rango de fechas",
};

/** «GET insights ad today» → «Leer métricas por anuncio (hoy)». */
export function explainEndpoint(endpoint: string): string {
  const [method, ...rest] = endpoint.split(" ");
  const name = rest.join(" ");
  if (rest[0] === "insights") {
    const params = rest.slice(1);
    const level = params.find((p) => LEVELS[p]);
    const period = params.find((p) => PERIODS[p]);
    return `Leer métricas${level ? ` por ${LEVELS[level]}` : ""}${period ? ` (${PERIODS[period]})` : ""}`;
  }
  if (name === "batch") return "Lote de llamadas agrupadas";
  if (method === "DELETE") return name === "objeto" ? "Borrar un objeto de Meta" : `Borrar en ${name}`;
  if (method === "GET") return READS[name] ?? `Consultar ${name}`;
  return WRITES[name] ?? `Enviar datos a ${name}`;
}

export interface MetaCallFacts {
  /** Tipo de llamada, p. ej. «GET insights ad today». */
  ep: string;
  /** Parámetros inocuos de la consulta: campos pedidos, nivel, periodo… */
  q?: Record<string, string>;
  /** Nombres de los campos enviados (nunca sus valores). */
  body?: string[];
  /** Estado enviado, si la llamada lo cambia. */
  status?: string;
  /** Continúa un listado: es la página siguiente. */
  paged?: boolean;
  batch?: { n: number; items: string[]; fields?: string };
}

/** Un objeto no dice su tipo en la URL, pero lo que se le pide delata para qué es. */
function objectRead(fields: string): string | null {
  const f = fields.split(",").map((x) => x.trim());
  if (f.length === 1 && f[0] === "id") return "Comprobar la cuota de la cuenta (llamada liviana)";
  if (f.length === 1 && f[0] === "access_token") return "Pedir el token de la fanpage";
  if (f.includes("source")) return "Consultar un vídeo";
  return null;
}

/** Una frase que dice qué hace esta llamada concreta. */
export function explainCall(c: MetaCallFacts): string {
  if (c.batch) {
    const [method, path = ""] = (c.batch.items[0] ?? "GET").split(" ");
    const parts = path.split("/").filter((p) => p && !/^\d+$/.test(p) && !p.startsWith("act_"));
    const inner = c.batch.fields ? objectRead(c.batch.fields) : null;
    return `Lote de ${c.batch.n}: ${inner ?? explainEndpoint(`${method} ${parts.join("/") || "objeto"}`)}`;
  }
  const [method, name] = c.ep.split(" ");
  let text = explainEndpoint(c.ep);
  if (method === "GET" && (name === "objeto" || name === "cuenta") && c.q?.fields) {
    text = objectRead(c.q.fields) ?? text;
  } else if (method === "POST" && name === "objeto" && c.status) {
    text = c.status === "PAUSED" ? "Pausar un objeto de Meta" : c.status === "ACTIVE" ? "Activar un objeto de Meta" : `Cambiar el estado a ${c.status}`;
  } else if (method === "POST" && name === "objeto" && c.body?.length === 1 && c.body[0] === "name") {
    text = "Renombrar un objeto de Meta";
  } else if (method === "POST" && name === "objeto" && c.body?.length) {
    text = `${text}: ${c.body.join(", ")}`;
  }
  return c.paged ? `${text} · página siguiente` : text;
}
