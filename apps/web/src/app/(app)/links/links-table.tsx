"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { ExternalLink, Copy, Power } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { setLinkActive, type ActionResult } from "./actions";
import { useConfirm } from "@/components/use-confirm";

interface LinkRow {
  id: string;
  slug: string;
  host: string;
  targetUrl: string;
  adName: string | null;
  campaignName: string | null;
  adId: string;
  clicks: number;
  active: boolean;
  funnelName: string | null;
  createdAt: string;
}

export function LinksTable({ links, canEdit }: { links: LinkRow[]; canEdit: boolean }) {
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [onlyActive, setOnlyActive] = useState(false);
  const { confirmar, dialogo } = useConfirm();

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return links.filter((l) => {
      if (onlyActive && !l.active) return false;
      if (!q) return true;
      return (
        l.slug.toLowerCase().includes(q) ||
        l.host.toLowerCase().includes(q) ||
        l.adId.includes(q) ||
        (l.adName ?? "").toLowerCase().includes(q) ||
        (l.campaignName ?? "").toLowerCase().includes(q)
      );
    });
  }, [links, query, onlyActive]);

  function run(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Copiado");
    } catch {
      toast.error("No se pudo copiar");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          placeholder="Buscar por slug, dominio, anuncio o ID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-sm"
        />
        <Button
          variant={onlyActive ? "default" : "outline"}
          size="sm"
          onClick={() => setOnlyActive((v) => !v)}
        >
          Solo activos
        </Button>
        <span className="text-xs text-muted-foreground">
          {filtered.length} de {links.length}
        </span>
      </div>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Enlace</TableHead>
              <TableHead>Anuncio</TableHead>
              <TableHead className="text-right">Clics</TableHead>
              <TableHead>Estado</TableHead>
              {canEdit && <TableHead className="text-right">Acciones</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={canEdit ? 5 : 4} className="py-8 text-center text-sm text-muted-foreground">
                  No hay enlaces que coincidan
                </TableCell>
              </TableRow>
            )}

            {filtered.map((l) => {
              const shortUrl = `https://${l.host}/${l.slug}`;
              return (
                <TableRow key={l.id} className={l.active ? undefined : "opacity-50"}>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <code className="text-xs">{shortUrl}</code>
                      <button
                        onClick={() => copy(shortUrl)}
                        className="text-muted-foreground hover:text-foreground"
                        title="Copiar"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                      <a
                        href={l.targetUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-muted-foreground hover:text-foreground"
                        title="Abrir el destino"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                    {l.funnelName && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{l.funnelName}</p>
                    )}
                  </TableCell>

                  <TableCell className="max-w-xs">
                    <p className="truncate text-sm">{l.adName ?? "—"}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {l.campaignName ?? l.adId}
                    </p>
                  </TableCell>

                  <TableCell className="text-right text-sm tabular-nums">{l.clicks}</TableCell>

                  <TableCell>
                    <Badge variant={l.active ? "default" : "secondary"} className="text-xs">
                      {l.active ? "Activo" : "Apagado"}
                    </Badge>
                  </TableCell>

                  {canEdit && (
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        title={l.active ? "Desactivar (deja de redirigir)" : "Activar"}
                        onClick={async () => {
                          if (
                            l.active &&
                            !(await confirmar({
                              title: `¿Desactivar ${l.slug}?`,
                              description:
                                "Deja de redirigir de inmediato. Si tiene anuncios activos, ese tráfico se pierde.",
                              detail: `https://${l.host}/${l.slug}`,
                              confirmLabel: "Desactivar",
                              destructive: true,
                            }))
                          ) {
                            return;
                          }
                          run(() => setLinkActive(l.id, !l.active));
                        }}
                      >
                        <Power className={l.active ? "h-3.5 w-3.5 text-destructive" : "h-3.5 w-3.5"} />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {dialogo}
    </div>
  );
}
