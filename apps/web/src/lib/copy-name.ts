// Nombres de las copias. Sin dependencias: lo usan el modal (vista previa) y la
// API (nombre real), para que lo que se ve sea exactamente lo que se crea.
const NUMBER_TOKEN = /\{n[uú]mero\}/gi;
const NAME_TOKEN = /\{nombre\}/gi;

const tidy = (s: string) => s.replace(/\s{2,}/g, " ").trim();

export const hasNumberToken = (template: string) => /\{n[uú]mero\}/i.test(template);

/**
 * Plantilla de una campaña: sustituye {nombre}. Si se numera y la plantilla no
 * dice dónde, el número va al final; si no se numera, se quita {numero}.
 */
export function buildCopyTemplate(template: string, campaignName: string, numbered: boolean): string {
  const named = template.replace(NAME_TOKEN, () => campaignName);
  if (!numbered) return tidy(named.replace(NUMBER_TOKEN, ""));
  return tidy(hasNumberToken(named) ? named : `${named} {numero}`);
}

/** Nombre final de una copia. */
export function renderCopyName(template: string, n: number): string {
  return tidy(template.replace(NUMBER_TOKEN, String(n)));
}

/** Nombre común de la tanda, sin número (para agrupar en Trabajos). */
export function copyBaseName(template: string): string {
  return tidy(template.replace(NUMBER_TOKEN, ""));
}
