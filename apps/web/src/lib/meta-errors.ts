// Catálogo de errores de Meta. Sin dependencias de servidor: lo usan la API, el
// worker y la interfaz. Cada error tiene dos caras:
//  - usuario: qué pasó, por qué y qué hacer, en lenguaje claro;
//  - desarrollador: el error crudo (code, subcode, fbtrace_id, endpoint…) para
//    poder buscarlo en Meta o en los logs.

export type MetaErrorKind =
  | "rate_limit_account" // cuota de la cuenta publicitaria (17, 80000-80014, 613)
  | "rate_limit_app"     // cuota de la app (4)
  | "rate_limit_page"    // cuota de la página (32)
  | "token"              // token caducado o inválido (190, 102, 463, 467)
  | "permission"         // sin permiso sobre la cuenta/página/objeto (10, 200-299, 294, 278)
  | "not_found"          // el objeto no existe o no es visible (100/33, 803)
  | "invalid_param"      // parámetro inválido (100 genérico)
  | "temporary"          // fallo transitorio de Meta (1, 2, is_transient, 5xx)
  | "asset_pending"      // el creative/imagen aún se está procesando (100/1487833)
  | "policy"             // bloqueo por políticas (368)
  | "page_permission"    // el BM no puede anunciar con esa página (1885499)
  | "network"            // no se pudo hablar con Meta
  | "config"             // falta configuración propia (BM sin token, etc.)
  | "unknown";

/** Lo que conocemos del error tal como lo devolvió Meta, más el contexto de la llamada. */
export interface MetaErrorDetail {
  code?: number;
  subcode?: number;
  type?: string;
  message?: string;
  userTitle?: string;
  userMsg?: string;
  fbtraceId?: string;
  isTransient?: boolean;
  httpStatus?: number;
  /** Endpoint sin token, p.ej. "POST act_123/adsets". */
  endpoint?: string;
  attempts?: number;
  /** Segundos que Meta pide esperar (estimated_time_to_regain_access). */
  retryAfterSec?: number;
  at?: string;
}

export interface ExplainedError {
  kind: MetaErrorKind;
  /** Titular corto para el usuario. */
  title: string;
  /** Qué pasó y por qué, en lenguaje claro. */
  message: string;
  /** Qué puede hacer el usuario. */
  action: string;
  /** ¿Tiene sentido reintentar más tarde sin cambiar nada? */
  retryable: boolean;
}

const RATE_LIMIT_ACCOUNT = new Set([17, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
// Subcódigos de "demasiadas llamadas" que Meta manda con códigos genéricos.
const RATE_LIMIT_SUBCODES = new Set([2446079, 1504022, 1504039]);
const TOKEN_CODES = new Set([102, 190, 463, 467]);

export function classifyMetaError(d: MetaErrorDetail): MetaErrorKind {
  const { code, subcode } = d;
  if (code == null && d.httpStatus === 0) return "network";
  if (code === 4) return "rate_limit_app";
  if (code === 32) return "rate_limit_page";
  if ((code != null && RATE_LIMIT_ACCOUNT.has(code)) || (subcode != null && RATE_LIMIT_SUBCODES.has(subcode))) {
    return "rate_limit_account";
  }
  if (code != null && TOKEN_CODES.has(code)) return "token";
  if (subcode === 1885499) return "page_permission";
  if (code === 100 && subcode === 1487833) return "asset_pending";
  if (code === 368) return "policy";
  if (code === 10 || code === 294 || code === 278 || (code != null && code >= 200 && code <= 299)) return "permission";
  if ((code === 100 && subcode === 33) || code === 803) return "not_found";
  if (code === 1 || code === 2 || d.isTransient || (d.httpStatus != null && d.httpStatus >= 500)) return "temporary";
  if (code === 100) return "invalid_param";
  return "unknown";
}

function waitText(sec?: number): string {
  if (!sec || sec <= 0) return "unos minutos";
  if (sec < 90) return `${Math.ceil(sec)} segundos`;
  return `${Math.ceil(sec / 60)} minutos`;
}

/** Texto de Meta pensado para personas (error_user_title/msg), si lo mandó. */
function metaUserText(d: MetaErrorDetail): string | null {
  const t = d.userTitle?.trim();
  const m = d.userMsg?.trim();
  if (t && m) return `${t}: ${m}`;
  return t || m || null;
}

export function explainMetaError(d: MetaErrorDetail, kind: MetaErrorKind = classifyMetaError(d)): ExplainedError {
  const metaText = metaUserText(d);
  switch (kind) {
    case "rate_limit_account":
      return {
        kind, retryable: true,
        title: "Meta está limitando esta cuenta publicitaria",
        message: `La cuenta hizo demasiadas solicitudes en poco tiempo y Meta la frenó temporalmente (código ${d.code ?? "?"}). No es un fallo de la campaña.`,
        action: `Se reanuda solo en ${waitText(d.retryAfterSec)}. Evita lanzar más duplicaciones en esta cuenta mientras tanto.`,
      };
    case "rate_limit_app":
      return {
        kind, retryable: true,
        title: "Meta está limitando la aplicación",
        message: "La plataforma hizo demasiadas solicitudes en total (código 4). Afecta a todas las cuentas a la vez.",
        action: `Espera ${waitText(d.retryAfterSec)}; los trabajos en cola se reanudan solos.`,
      };
    case "rate_limit_page":
      return {
        kind, retryable: true,
        title: "Meta está limitando la página",
        message: "La página de Facebook recibió demasiadas solicitudes (código 32).",
        action: `Espera ${waitText(d.retryAfterSec)} e inténtalo de nuevo.`,
      };
    case "token":
      return {
        kind, retryable: false,
        title: "El token del Business Manager no es válido",
        message: `Meta rechazó el token (código ${d.code}): caducó, se revocó o se cambió la contraseña del usuario del sistema.`,
        action: "Actualiza el token en Ajustes → Business Managers (botón Editar) y vuelve a lanzar el trabajo.",
      };
    case "permission":
      return {
        kind, retryable: false,
        title: "Sin permiso en Meta",
        message: metaText ?? `El usuario del sistema no tiene permiso para esta acción sobre la cuenta u objeto (código ${d.code}).`,
        action: "En el Business Manager, asigna la cuenta publicitaria al usuario del sistema con permiso de administrar campañas.",
      };
    case "page_permission":
      return {
        kind, retryable: false,
        title: "No se puede anunciar con esa página",
        message: metaText ?? "El Business Manager no tiene permiso de anunciante sobre la página que usa el anuncio.",
        action: "Comparte la página con el Business Manager (rol de anunciante) o cambia la página del creativo.",
      };
    case "not_found":
      return {
        kind, retryable: false,
        title: "El objeto ya no existe en Meta",
        message: metaText ?? "La campaña, ad set o anuncio no existe o el token ya no puede verlo (pudo borrarse o moverse).",
        action: "Refresca la lista con «Traer de Meta» y vuelve a elegir el elemento.",
      };
    case "invalid_param":
      return {
        kind, retryable: false,
        title: "Meta rechazó la configuración",
        message: metaText ?? d.message ?? "Uno de los parámetros enviados no es válido para Meta.",
        action: "Revisa la configuración del elemento original en Ads Manager. Si se repite, pasa el detalle técnico al equipo.",
      };
    case "temporary":
      return {
        kind, retryable: true,
        title: "Fallo temporal de Meta",
        message: "Meta respondió con un error interno pasajero. No es un problema de la configuración.",
        action: "Se reintenta automáticamente. Si persiste, vuelve a lanzar el trabajo en unos minutos.",
      };
    case "asset_pending":
      return {
        kind, retryable: true,
        title: "El creativo aún se está procesando",
        message: "Meta todavía no terminó de procesar la imagen o el vídeo del anuncio.",
        action: "Se reintenta solo; suele resolverse en 5–10 minutos.",
      };
    case "policy":
      return {
        kind, retryable: false,
        title: "Bloqueado por políticas de Meta",
        message: metaText ?? "Meta bloqueó la acción por sus políticas de publicidad o por actividad sospechosa.",
        action: "Revisa el estado de la cuenta en Calidad de la cuenta (Meta Business Suite).",
      };
    case "network":
      return {
        kind, retryable: true,
        title: "No se pudo conectar con Meta",
        message: "La solicitud a Meta no obtuvo respuesta (red o tiempo de espera).",
        action: "Se reintenta automáticamente. Si persiste, revisa el estado de Meta.",
      };
    case "config":
      return {
        kind, retryable: false,
        title: "Falta configuración",
        message: d.message ?? "No hay un Business Manager con token activo para esta cuenta.",
        action: "Configura o restaura el Business Manager en Ajustes.",
      };
    default:
      return {
        kind, retryable: false,
        title: "Error de Meta",
        message: metaText ?? d.message ?? "Meta devolvió un error no reconocido.",
        action: "Si se repite, pasa el detalle técnico (código y fbtrace_id) al equipo.",
      };
  }
}

export function isRateLimitKind(k: MetaErrorKind): boolean {
  return k === "rate_limit_account" || k === "rate_limit_app" || k === "rate_limit_page";
}

/** Forma serializable que se guarda en los jobs y se devuelve por la API. */
export interface SerializedError extends ExplainedError {
  detail: MetaErrorDetail;
}

/** Convierte cualquier error en {mensaje de usuario + detalle técnico}. */
export function serializeError(e: unknown): SerializedError {
  if (e instanceof MetaApiError) return e.toJSON();
  const message = e instanceof Error ? e.message : String(e);
  // Errores antiguos en texto: "Meta API error 17: …"
  const m = /Meta (?:API|batch) error (\d+): ([\s\S]*)$/.exec(message);
  if (m) {
    const detail: MetaErrorDetail = { code: Number(m[1]), message: m[2], at: new Date().toISOString() };
    return { ...explainMetaError(detail), detail };
  }
  const isNet = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(message);
  const isConfig = /Business Manager/i.test(message);
  const detail: MetaErrorDetail = { message, at: new Date().toISOString() };
  const kind: MetaErrorKind = isNet ? "network" : isConfig ? "config" : "unknown";
  const base = explainMetaError(detail, kind);
  return { ...base, ...(kind === "unknown" ? { title: "Error inesperado", message } : {}), detail };
}

/** Línea única para el campo `error` de un job / toast: título + qué hacer. */
export function userLine(s: Pick<ExplainedError, "title" | "action">): string {
  return `${s.title}. ${s.action}`;
}

export class MetaApiError extends Error {
  readonly detail: MetaErrorDetail;
  readonly kind: MetaErrorKind;
  readonly explained: ExplainedError;

  constructor(detail: MetaErrorDetail) {
    const d = { at: new Date().toISOString(), ...detail };
    // El texto conserva el formato antiguo ("Meta API error N: …") para que los
    // detectores existentes por regex sigan funcionando.
    super(`Meta API error ${d.code ?? "?"}: ${d.message ?? "sin mensaje"}`);
    this.name = "MetaApiError";
    this.detail = d;
    this.kind = classifyMetaError(d);
    this.explained = explainMetaError(d, this.kind);
  }

  get retryable() { return this.explained.retryable; }

  toJSON(): SerializedError {
    return { ...this.explained, detail: this.detail };
  }
}
