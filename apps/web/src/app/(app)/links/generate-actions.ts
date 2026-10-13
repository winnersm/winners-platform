"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@winners/db";
import { buildSlug } from "@/lib/slugs";
import { resolveMacros } from "@/lib/macros";
import { assertGrant } from "@/lib/guards";
import { audit } from "@/lib/audit";

/**
 * Generación de enlaces cortos.
 *
 * Por cada anuncio se sustituyen las {{macros}} de la URL de FunnelFlux por
 * los IDs reales, y se guarda el destino ya resuelto. Así el redirector no
 * tiene que resolver nada en tiempo de clic: solo lee y redirige.
 */

const adSchema = z.object({
  adId: z.string().min(1),
  adsetId: z.string().min(1),
  campaignId: z.string().min(1),
  assetId: z.string().optional().nullable(),
  adName: z.string().optional().nullable(),
  adsetName: z.string().optional().nullable(),
  campaignName: z.string().optional().nullable(),
});

const generarSchema = z.object({
  domainId: z.string().min(1, "Elige un dominio"),
  url: z
    .string()
    .min(8)
    .refine((u) => /^https?:\/\//i.test(u.trim()), "Pega una URL http(s) de FunnelFlux"),
  ads: z.array(adSchema).min(1, "Selecciona al menos un anuncio"),
  /// Prefijo del slug (article, report, video…) para que el enlace parezca
  /// contenido y no un acortador.
  slugPrefix: z.string().max(24).optional().nullable(),
  funnelUrlId: z.string().optional().nullable(),
});

export type GeneratedLink = {
  slug: string;
  url: string;
  target: string;
  adName: string | null;
};

export type GenerateResult =
  | { ok: true; created: GeneratedLink[] }
  | { ok: false; error: string };

async function uniqueSlug(prefix?: string): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const slug = buildSlug(prefix);
    const existe = await prisma.link.findUnique({ where: { slug }, select: { id: true } });
    if (!existe) return slug;
  }
  throw new Error("No se pudo generar un slug único");
}

export async function generateLinks(input: unknown): Promise<GenerateResult> {
  const actor = await assertGrant("LINKS", "WRITE");

  const parsed = generarSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }
  const { domainId, url, ads, slugPrefix, funnelUrlId } = parsed.data;

  const domain = await prisma.domain.findUnique({ where: { id: domainId } });
  if (!domain) return { ok: false, error: "Dominio no encontrado" };
  if (!domain.active) {
    return { ok: false, error: `${domain.host} está desactivado: sus enlaces no redirigirían` };
  }

  const created: GeneratedLink[] = [];

  for (const ad of ads) {
    const targetUrl = resolveMacros(url.trim(), ad);
    const slug = await uniqueSlug(slugPrefix || undefined);
    const link = await prisma.link.create({
      data: {
        slug,
        domainId,
        funnelUrlId: funnelUrlId || null,
        targetUrl,
        adId: ad.adId,
        adsetId: ad.adsetId,
        campaignId: ad.campaignId,
        assetId: ad.assetId || null,
        adName: ad.adName || null,
        campaignName: ad.campaignName || null,
        createdBy: actor.id,
      },
    });
    created.push({
      slug: link.slug,
      url: `https://${domain.host}/${link.slug}`,
      target: link.targetUrl,
      adName: link.adName,
    });
  }

  await audit({
    userId: actor.id,
    module: "LINKS",
    action: "link.generate",
    entityType: "Link",
    payload: { host: domain.host, cantidad: created.length, slugPrefix },
  });

  revalidatePath("/links");
  return { ok: true, created };
}

// ─── URLs de FunnelFlux guardadas ────────────────────────────────────────────
// Evitan tener que ir a buscar la URL con macros cada vez que se generan
// enlaces para el mismo funnel.

const funnelSchema = z.object({
  name: z.string().min(1).max(120),
  urlTemplate: z
    .string()
    .min(8)
    .refine((u) => /^https?:\/\//i.test(u.trim()), "Debe ser una URL http(s)"),
});

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

export async function saveFunnelUrl(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const actor = await assertGrant("LINKS", "WRITE");

  const parsed = funnelSchema.safeParse({
    name: formData.get("name"),
    urlTemplate: formData.get("urlTemplate"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Datos inválidos" };
  }

  const id = formData.get("id")?.toString();
  const data = { name: parsed.data.name.trim(), urlTemplate: parsed.data.urlTemplate.trim() };

  const funnel = id
    ? await prisma.funnelUrl.update({ where: { id }, data })
    : await prisma.funnelUrl.create({ data });

  await audit({
    userId: actor.id,
    module: "LINKS",
    action: id ? "funnel_url.update" : "funnel_url.create",
    entityType: "FunnelUrl",
    entityId: funnel.id,
    payload: { name: data.name },
  });

  revalidatePath("/links");
  return { ok: true, message: id ? "URL actualizada" : `"${data.name}" guardada` };
}

export async function deleteFunnelUrl(id: string): Promise<ActionResult> {
  const actor = await assertGrant("LINKS", "WRITE");

  const funnel = await prisma.funnelUrl.findUnique({
    where: { id },
    include: { _count: { select: { links: true } } },
  });
  if (!funnel) return { ok: false, error: "No encontrada" };

  // Los enlaces ya generados no se tocan: su destino está resuelto y guardado,
  // así que siguen funcionando aunque desaparezca la plantilla.
  await prisma.funnelUrl.delete({ where: { id } });

  await audit({
    userId: actor.id,
    module: "LINKS",
    action: "funnel_url.delete",
    entityType: "FunnelUrl",
    entityId: id,
    payload: { name: funnel.name },
  });

  revalidatePath("/links");
  return {
    ok: true,
    message: `"${funnel.name}" eliminada. Los ${funnel._count.links} enlaces que la usaron siguen funcionando.`,
  };
}
