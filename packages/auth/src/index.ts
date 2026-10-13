// ─────────────────────────────────────────────────────────────────────────────
// Control de acceso — lógica pura, sin dependencias de Next ni de la base.
//
// Dos ejes que se combinan:
//   1. Rol global    — qué tipo de persona es (OWNER, ADMIN, OPERATOR…)
//   2. Concesión     — qué puede hacer en cada módulo (none/read/write/admin)
//
// Y un tercero que filtra datos, no permisos:
//   3. Operación     — a qué tenant pertenece lo que ve (JV Liminal, Winners…)
//
// Al estar aquí y no dentro de la app, se puede probar sin levantar Next.
// ─────────────────────────────────────────────────────────────────────────────

export const MODULES = ["META", "AUTOMATIONS", "LINKS", "MONITOR", "CLONER", "ADMIN"] as const;
export type Module = (typeof MODULES)[number];

export const ROLES = ["OWNER", "ADMIN", "OPERATOR", "VIEWER", "SERVICE"] as const;
export type Role = (typeof ROLES)[number];

export const LEVELS = ["NONE", "READ", "WRITE", "ADMIN"] as const;
export type Level = (typeof LEVELS)[number];

/** Orden de los niveles: ADMIN implica WRITE, que implica READ. */
const LEVEL_RANK: Record<Level, number> = {
  NONE: 0,
  READ: 1,
  WRITE: 2,
  ADMIN: 3,
};

export interface Grant {
  module: Module;
  level: Level;
  /** Secciones concretas dentro del módulo. Vacío = todas. */
  scopes?: string[];
}

export interface Principal {
  id: string;
  email: string;
  name?: string | null;
  role: Role;
  grants: Grant[];
  /** Ids de Operation a las que pertenece. Vacío = ninguna. */
  operations: string[];
}

// ─── Reglas de rol ───────────────────────────────────────────────────────────

/**
 * OWNER lo puede todo, siempre. Es el único atajo que existe: sin él, un error
 * al asignar concesiones podría dejar el sistema sin nadie capaz de arreglarlo.
 */
function isOwner(p: Principal): boolean {
  return p.role === "OWNER";
}

/** VIEWER nunca escribe, da igual lo que digan sus concesiones. */
function isReadOnlyRole(p: Principal): boolean {
  return p.role === "VIEWER";
}

/** Solo OWNER entra a ADMIN. Gestionar usuarios y secretos no se delega. */
function moduleRequiresOwner(module: Module): boolean {
  return module === "ADMIN";
}

// ─── Comprobación principal ──────────────────────────────────────────────────

/**
 * ¿Puede esta persona hacer algo de nivel `required` en `module`?
 *
 * Se usa en tres capas y las tres son obligatorias: middleware (para no
 * renderizar), server action (antes de tocar nada) y API. Comprobarlo solo en
 * el menú esconde el botón pero no cierra la puerta.
 */
export function can(p: Principal, module: Module, required: Level = "READ"): boolean {
  if (p.role === "SERVICE") return false; // los workers no navegan
  if (isOwner(p)) return true;
  if (moduleRequiresOwner(module)) return false;
  if (isReadOnlyRole(p) && LEVEL_RANK[required] > LEVEL_RANK.READ) return false;

  const grant = p.grants.find((g) => g.module === module);
  if (!grant) return false;

  return LEVEL_RANK[grant.level] >= LEVEL_RANK[required];
}

/** Módulos que esta persona puede ver. Es lo que dibuja el menú lateral. */
export function visibleModules(p: Principal): Module[] {
  return MODULES.filter((m) => can(p, m, "READ"));
}

/**
 * ¿Puede acceder a una sección concreta dentro de un módulo?
 *
 * Una concesión sin `scopes` da acceso a todo el módulo. Con `scopes`, solo a
 * las secciones listadas — así se conserva el permiso fino que ya existía en
 * newappmeta (p. ej. un dev externo que solo debe ver Fanpages).
 */
export function canScope(
  p: Principal,
  module: Module,
  scope: string,
  required: Level = "READ",
): boolean {
  if (!can(p, module, required)) return false;
  if (isOwner(p)) return true;

  const grant = p.grants.find((g) => g.module === module);
  if (!grant?.scopes?.length) return true; // sin restricción de sección
  return grant.scopes.includes(scope);
}

/** ¿Puede ver datos de esta operación? */
export function canAccessOperation(p: Principal, operationId: string): boolean {
  if (isOwner(p)) return true;
  return p.operations.includes(operationId);
}

// ─── Rutas ───────────────────────────────────────────────────────────────────

const ROUTE_PREFIX: Record<string, Module> = {
  "/meta": "META",
  "/automations": "AUTOMATIONS",
  "/links": "LINKS",
  "/monitor": "MONITOR",
  "/cloner": "CLONER",
  "/admin": "ADMIN",
};

/** A qué módulo pertenece una ruta. `null` = ruta libre (login, raíz, etc.). */
export function moduleForPath(pathname: string): Module | null {
  for (const [prefix, module] of Object.entries(ROUTE_PREFIX)) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return module;
  }
  return null;
}

/**
 * Secciones navegables, en el orden en que aparecen en el menú.
 *
 * Esta tabla es la que convierte una URL en un permiso concreto. Sin ella, el
 * control por módulo dejaría entrar a `/meta/accounts` a quien solo tiene
 * concedido `fanpages`.
 */
export const ROUTE_SCOPES: { path: string; module: Module; scope?: string }[] = [
  { path: "/meta/dashboard", module: "META", scope: "dashboard" },
  { path: "/meta/accounts", module: "META", scope: "accounts" },
  { path: "/meta/campaigns", module: "META", scope: "campaigns" },
  { path: "/meta/adsets", module: "META", scope: "campaigns" },
  { path: "/meta/ads", module: "META", scope: "campaigns" },
  { path: "/meta/fanpages", module: "META", scope: "fanpages" },
  { path: "/meta/launches", module: "META", scope: "launches" },
  { path: "/meta/jobs", module: "META", scope: "jobs" },
  { path: "/automations", module: "AUTOMATIONS" },
  { path: "/links", module: "LINKS" },
  { path: "/monitor", module: "MONITOR" },
  { path: "/cloner", module: "CLONER", scope: "clonar" },
  { path: "/cloner/plantillas", module: "CLONER", scope: "plantillas" },
  { path: "/cloner/historial", module: "CLONER", scope: "historial" },
  // Los tokens son credenciales de Meta: sección propia para poder dar el
  // clonador a alguien sin darle acceso a los tokens con los que se clona.
  { path: "/cloner/tokens", module: "CLONER", scope: "tokens" },
  { path: "/admin", module: "ADMIN" },
];

/** Qué sección exige una ruta. `undefined` = el módulo entero basta. */
export function scopeForPath(pathname: string): string | undefined {
  const entry = ROUTE_SCOPES.filter(
    (r) => pathname === r.path || pathname.startsWith(`${r.path}/`),
  )
    // La coincidencia más larga gana: /meta/adsets antes que /meta
    .sort((a, b) => b.path.length - a.path.length)[0];
  return entry?.scope;
}

/**
 * A dónde mandar a alguien que acaba de entrar: la primera pantalla que
 * realmente puede abrir. Considera la sección, no solo el módulo — si no,
 * un usuario limitado a Fanpages aterrizaba en Cuentas y veía lo que no debe.
 */
export function landingPath(p: Principal): string {
  for (const route of ROUTE_SCOPES) {
    if (route.module === "ADMIN" && p.role !== "OWNER") continue;
    if (!can(p, route.module, "READ")) continue;
    if (route.scope && !canScope(p, route.module, route.scope)) continue;
    return route.path;
  }
  return "/sin-acceso";
}

/**
 * Qué exige cada ruta de la API del clonador.
 *
 * Vive aquí y no junto a la ruta por un motivo concreto: es la única defensa de
 * esos endpoints —el motor al que llaman no sabe quién es quién— y así se puede
 * probar sin levantar Next. Lo que no esté en la tabla, no existe.
 */
export interface ApiPermiso {
  scope: string;
  level: Level;
}

export const CLONER_API_GET: Record<string, ApiPermiso> = {
  // Los alias de token hacen falta para poder elegir uno al clonar; el secreto
  // nunca sale del motor, así que verlos no es ver las credenciales.
  tokens: { scope: "clonar", level: "READ" },
  cuentas: { scope: "clonar", level: "READ" },
  campanas: { scope: "clonar", level: "READ" },
  campana: { scope: "clonar", level: "READ" },
  pixeles: { scope: "clonar", level: "READ" },
  paginas: { scope: "clonar", level: "READ" },
  instagram: { scope: "clonar", level: "READ" },
  trabajo: { scope: "clonar", level: "READ" },
  trabajos: { scope: "clonar", level: "READ" },
  miniatura: { scope: "clonar", level: "READ" },
  historial: { scope: "historial", level: "READ" },
  plantillas: { scope: "plantillas", level: "READ" },
  plantilla: { scope: "plantillas", level: "READ" },
};

export const CLONER_API_POST: Record<string, ApiPermiso> = {
  clonar: { scope: "clonar", level: "WRITE" },
  // Leer una campaña grande tarda más de lo que aguanta Cloudflare, así que se
  // hace en segundo plano. Es una lectura: basta con READ.
  "campana/cargar": { scope: "clonar", level: "READ" },
  // Cancelar no crea nada en Meta, pero sí decide qué deja de crearse.
  "trabajos/cancelar": { scope: "clonar", level: "WRITE" },
  video: { scope: "clonar", level: "WRITE" },
  tokens: { scope: "tokens", level: "WRITE" },
  "tokens/borrar": { scope: "tokens", level: "WRITE" },
  plantillas: { scope: "plantillas", level: "WRITE" },
  "plantillas/borrar": { scope: "plantillas", level: "WRITE" },
};

// ─── Metadatos para la interfaz ──────────────────────────────────────────────

export interface ModuleMeta {
  key: Module;
  label: string;
  href: string;
  description: string;
}

export const MODULE_META: ModuleMeta[] = [
  { key: "META", label: "Meta Ads", href: "/meta", description: "Campañas, cuentas, lanzamientos y fanpages" },
  { key: "AUTOMATIONS", label: "Automations", href: "/automations", description: "Tareas programadas, billing y alertas" },
  { key: "LINKS", label: "Links", href: "/links", description: "Enlaces cortos y dominios de tracking" },
  { key: "MONITOR", label: "Monitor", href: "/monitor", description: "Salud de los tracking links" },
  { key: "CLONER", label: "Clonador", href: "/cloner", description: "Clonar campañas entre cuentas y BMs, con plantillas" },
  { key: "ADMIN", label: "Administración", href: "/admin", description: "Usuarios, permisos, secretos e historial" },
];

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Dueño",
  ADMIN: "Administrador",
  OPERATOR: "Operador",
  VIEWER: "Solo lectura",
  SERVICE: "Servicio",
};

export const LEVEL_LABEL: Record<Level, string> = {
  NONE: "Sin acceso",
  READ: "Ver",
  WRITE: "Editar",
  ADMIN: "Administrar",
};
