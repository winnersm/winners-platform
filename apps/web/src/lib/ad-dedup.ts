// Compara los anuncios pendientes de UN ad set con los que ya existen en Meta.
// Los nombres pueden repetirse dentro del ad set, así que se cuenta por nombre:
// cada anuncio existente cubre a un solo pendiente, y los que ya se contaron
// como creados en esta ejecución no cubren a nadie más.
export function splitExistingAds<T extends { name: string }>(
  pending: T[],
  existingNames: string[],
  alreadyCounted: (name: string) => number,
): { found: T[]; missing: T[] } {
  const available = new Map<string, number>();
  for (const name of existingNames) available.set(name, (available.get(name) ?? 0) + 1);
  for (const name of new Set(existingNames)) {
    available.set(name, Math.max(0, (available.get(name) ?? 0) - alreadyCounted(name)));
  }

  const found: T[] = [];
  const missing: T[] = [];
  for (const item of pending) {
    const left = available.get(item.name) ?? 0;
    if (left > 0) {
      available.set(item.name, left - 1);
      found.push(item);
    } else {
      missing.push(item);
    }
  }
  return { found, missing };
}
