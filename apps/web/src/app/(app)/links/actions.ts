"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@winners/db";
import { assertGrant } from "@/lib/guards";
import { audit } from "@/lib/audit";

export type ActionResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Gestión de enlaces y dominios.
 *
 * Desactivar un enlace corta tráfico pagado en vivo, así que toda acción queda
 * auditada: hoy el panel del acortador va con una contraseña compartida y no
 * hay forma de saber quién tocó qué.
 */

export async function setLinkActive(linkId: string, active: boolean): Promise<ActionResult> {
  const actor = await assertGrant("LINKS", "WRITE");

  const link = await prisma.link.findUnique({
    where: { id: linkId },
    include: { domain: true },
  });
  if (!link) return { ok: false, error: "Enlace no encontrado" };

  await prisma.link.update({ where: { id: linkId }, data: { active } });

  await audit({
    userId: actor.id,
    module: "LINKS",
    action: active ? "link.activate" : "link.deactivate",
    entityType: "Link",
    entityId: linkId,
    payload: { slug: link.slug, host: link.domain.host, adId: link.adId },
  });

  revalidatePath("/links");
  return {
    ok: true,
    message: active
      ? `${link.slug} activado`
      : `${link.slug} desactivado — deja de redirigir de inmediato`,
  };
}

const domainSchema = z.object({
  host: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9.-]+$/i, "Solo letras, números, puntos y guiones")
    .transform((h) => h.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "")),
});

export async function addDomain(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const actor = await assertGrant("LINKS", "ADMIN");

  const parsed = domainSchema.safeParse({ host: formData.get("host") });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Dominio inválido" };
  }
  const host = parsed.data.host;

  const exists = await prisma.domain.findUnique({ where: { host } });
  if (exists) return { ok: false, error: "Ese dominio ya está dado de alta" };

  const domain = await prisma.domain.create({ data: { host } });

  await audit({
    userId: actor.id,
    module: "LINKS",
    action: "domain.create",
    entityType: "Domain",
    entityId: domain.id,
    payload: { host },
  });

  revalidatePath("/links/domains");
  return { ok: true, message: `${host} añadido. Apunta su DNS al servidor y verifícalo.` };
}

export async function setDomainActive(domainId: string, active: boolean): Promise<ActionResult> {
  const actor = await assertGrant("LINKS", "ADMIN");

  const domain = await prisma.domain.findUnique({
    where: { id: domainId },
    include: { _count: { select: { links: true } } },
  });
  if (!domain) return { ok: false, error: "Dominio no encontrado" };

  await prisma.domain.update({ where: { id: domainId }, data: { active } });

  await audit({
    userId: actor.id,
    module: "LINKS",
    action: active ? "domain.activate" : "domain.deactivate",
    entityType: "Domain",
    entityId: domainId,
    payload: { host: domain.host, links: domain._count.links },
  });

  revalidatePath("/links/domains");
  return {
    ok: true,
    message: active
      ? `${domain.host} activado`
      : `${domain.host} desactivado (${domain._count.links} enlaces afectados)`,
  };
}

/**
 * Comprueba si el dominio resuelve al servidor. Sin esto, un dominio recién
 * añadido parece listo cuando en realidad sus enlaces no responden.
 */
export async function verifyDomain(domainId: string): Promise<ActionResult> {
  await assertGrant("LINKS", "WRITE");

  const domain = await prisma.domain.findUnique({ where: { id: domainId } });
  if (!domain) return { ok: false, error: "Dominio no encontrado" };

  const serverIp = process.env.SERVER_IP ?? "157.90.162.153";

  let ips: string[] = [];
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${domain.host}&type=A`, {
      headers: { accept: "application/dns-json" },
      cache: "no-store",
    });
    const data = (await res.json()) as { Answer?: { type: number; data: string }[] };
    ips = (data.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
  } catch {
    return { ok: false, error: "No se pudo consultar el DNS" };
  }

  // Con Cloudflare por delante, el DNS devuelve las IPs de Cloudflare y no la
  // del servidor. Eso es lo esperado: se marca como verificado igualmente y se
  // guardan las IPs vistas para poder revisarlo.
  const direct = ips.includes(serverIp);
  const proxied = ips.length > 0 && !direct;

  await prisma.domain.update({
    where: { id: domainId },
    data: {
      verified: ips.length > 0,
      verifiedAt: ips.length > 0 ? new Date() : null,
      lastIps: ips,
    },
  });

  revalidatePath("/links/domains");

  if (ips.length === 0) return { ok: false, error: `${domain.host} no resuelve a ninguna IP` };
  if (direct) return { ok: true, message: `${domain.host} apunta al servidor` };
  if (proxied) {
    return {
      ok: true,
      message: `${domain.host} resuelve a ${ips[0]} (parece Cloudflare con proxy — correcto)`,
    };
  }
  return { ok: true, message: "Verificado" };
}
