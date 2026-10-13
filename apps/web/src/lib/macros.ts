// Motor de reemplazo de macros. Tomas una URL de FunnelFlux con sus {{macros}}, y las
// sustituimos por los valores REALES del anuncio (traídos de Meta) + valores fijos para
// las macros que en comentarios no tienen valor. Réplica de la lógica del PHP original.

export interface AdMacroValues {
  adId: string;
  adsetId: string;
  campaignId: string;
  assetId?: string | null;
  adName?: string | null;
  adsetName?: string | null;
  campaignName?: string | null;
}

// Valores fijos para macros que NO vienen de Meta (tráfico de comentarios).
export const FIXED_MACROS: Record<string, string> = {
  placement: "comment",
  site_source_name: "fb",
  platform: "facebook",
  position: "feed",
};

/** Construye el mapa macro→valor para un anuncio dado. Claves SIN las llaves {{ }}. */
function macroMap(ad: AdMacroValues): Record<string, string> {
  const meta: Record<string, string> = {
    "ad.id": ad.adId,
    "adset.id": ad.adsetId,
    "campaign.id": ad.campaignId,
    "ad.name": ad.adName ?? "",
    "adset.name": ad.adsetName ?? "",
    "campaign.name": ad.campaignName ?? "",
    "asset.id": ad.assetId ?? "",
    "post.id": ad.assetId ?? "",
  };
  return { ...FIXED_MACROS, ...meta };
}

/**
 * Reemplaza todas las {{macros}} de la URL:
 *  - conocidas (Meta + fijas) → su valor (URL-encoded)
 *  - desconocidas sobrantes → vacío (como el preg_replace final del PHP)
 * El fbclid NO se toca aquí: llega dinámico en el redirect.
 */
export function resolveMacros(rawUrl: string, ad: AdMacroValues): string {
  const map = macroMap(ad);
  return rawUrl.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_full, name: string) => {
    const key = name.trim();
    const value = map[key];
    if (value === undefined) return ""; // macro desconocida → vacío
    return encodeURIComponent(value);
  });
}

/** Lista las macros presentes en una URL (para previsualizar en la UI). */
export function extractMacros(rawUrl: string): string[] {
  const out = new Set<string>();
  for (const m of rawUrl.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) out.add(m[1].trim());
  return [...out];
}
