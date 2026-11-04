import { redis } from "@/lib/redis";

// Tasas de cambio contra USD, solo para ORDENAR y SUMAR cuentas de monedas
// distintas en pantalla: nunca se guardan ni alteran los datos de Meta.
const FX_URL = "https://open.er-api.com/v6/latest/USD";
const FRESH_KEY = "fx:usd";
const BACKUP_KEY = "fx:usd:backup";
const FRESH_TTL = 12 * 3600;    // la fuente se actualiza una vez al día
const BACKUP_TTL = 30 * 86400;  // si la fuente cae, mejor una tasa de días atrás que ninguna

export interface FxRates {
  /** Unidades de cada moneda por 1 USD. */
  rates: Record<string, number>;
  updatedAt: string | null;
  /** true si la fuente falló y se sirve la última copia guardada. */
  stale?: boolean;
}

export async function getFxRates(): Promise<FxRates> {
  const cached = await redis.get(FRESH_KEY).catch(() => null);
  if (cached) return JSON.parse(cached) as FxRates;

  try {
    const res = await fetch(FX_URL, { signal: AbortSignal.timeout(8000) });
    const json = (await res.json()) as { result?: string; rates?: Record<string, number>; time_last_update_utc?: string };
    if (json.result !== "success" || !json.rates) throw new Error(`Respuesta inesperada de la fuente de tasas (HTTP ${res.status})`);
    const out: FxRates = {
      rates: json.rates,
      updatedAt: json.time_last_update_utc ? new Date(json.time_last_update_utc).toISOString() : null,
    };
    await redis.setex(FRESH_KEY, FRESH_TTL, JSON.stringify(out));
    await redis.setex(BACKUP_KEY, BACKUP_TTL, JSON.stringify(out));
    return out;
  } catch (e) {
    console.error("[fx] no se pudieron obtener las tasas:", e instanceof Error ? e.message : e);
    const backup = await redis.get(BACKUP_KEY).catch(() => null);
    if (backup) return { ...(JSON.parse(backup) as FxRates), stale: true };
    return { rates: {}, updatedAt: null, stale: true };
  }
}
