"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  CheckCircle2, XCircle, HelpCircle, Eye, EyeOff, ExternalLink,
  Plus, Pencil, Copy, Trash2, Play,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  setLinkEnabled, deleteLink, duplicateLink, requestCheck, setCheckInterval, type ActionResult,
} from "./actions";
import { LinkDialog, type LinkFormData } from "./link-dialog";
import { useConfirm } from "@/components/use-confirm";

interface LinkRow {
  id: string;
  name: string;
  url: string;
  expectedUrl: string | null;
  expectedText: string | null;
  expectRedirect: boolean;
  maxResponseMs: number;
  enabled: boolean;
  status: string;
  lastCheckAt: string | null;
  consecutiveFails: number;
  uptime: number | null;
}

interface Incident {
  id: string;
  linkName: string;
  openedAt: string;
  closedAt: string | null;
  reason: string | null;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "OK") return <CheckCircle2 className="h-4 w-4 text-green-600" />;
  if (status === "FAIL") return <XCircle className="h-4 w-4 text-destructive" />;
  return <HelpCircle className="h-4 w-4 text-muted-foreground" />;
}

function duracion(desde: string, hasta: string | null): string {
  const ms = (hasta ? new Date(hasta).getTime() : Date.now()) - new Date(desde).getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} días`;
}

export function MonitorList({
  links,
  incidents,
  canEdit,
  intervaloMin,
}: {
  links: LinkRow[];
  incidents: Incident[];
  canEdit: boolean;
  intervaloMin: number;
}) {
  const [pending, startTransition] = useTransition();
  const [verRetirados, setVerRetirados] = useState(false);
  const [editando, setEditando] = useState<LinkFormData | null>(null);
  const [creando, setCreando] = useState(false);
  const [intervalo, setIntervalo] = useState(String(intervaloMin));
  const { confirmar, dialogo } = useConfirm();

  const vigilados = links.filter((l) => l.enabled);
  const retirados = links.filter((l) => !l.enabled);
  const visibles = verRetirados ? links : vigilados;

  function run(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-6">
      {canEdit && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Comprobar cada
            <Input
              type="number"
              min={5}
              max={1440}
              value={intervalo}
              onChange={(e) => setIntervalo(e.target.value)}
              className="w-20 text-sm"
            />
            minutos
            {Number(intervalo) !== intervaloMin && (
              <Button
                size="sm"
                disabled={pending}
                onClick={() => run(() => setCheckInterval(Number(intervalo)))}
              >
                Guardar
              </Button>
            )}
          </label>

          <Button size="sm" onClick={() => setCreando(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Vigilar un link
          </Button>
        </div>
      )}

      <div className="space-y-2">
        {visibles.map((l) => (
          <div
            key={l.id}
            className={`rounded-lg border bg-card p-4 ${l.enabled ? "" : "opacity-60"}`}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <StatusIcon status={l.status} />
                  <h3 className="truncate text-sm font-medium">{l.name}</h3>
                  {!l.enabled && (
                    <Badge variant="secondary" className="text-xs">
                      sin vigilar
                    </Badge>
                  )}
                  {l.consecutiveFails > 0 && (
                    <Badge variant="destructive" className="text-xs">
                      {l.consecutiveFails} fallos seguidos
                    </Badge>
                  )}
                </div>

                <a
                  href={l.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                >
                  {l.url}
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>

                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {l.uptime !== null && (
                    <span className={l.uptime < 99 ? "text-amber-700" : undefined}>
                      {l.uptime.toFixed(1)}% en 30 días
                    </span>
                  )}
                  {l.lastCheckAt && (
                    <span>
                      última revisión:{" "}
                      {new Date(l.lastCheckAt).toLocaleString("es-CO", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </span>
                  )}
                  {l.expectedText && (
                    <span className="truncate" title={l.expectedText}>
                      busca: “{l.expectedText}”
                    </span>
                  )}
                </div>
              </div>

              {canEdit && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending || !l.enabled}
                    title={l.enabled ? "Comprobar ahora" : "Actívalo para poder comprobarlo"}
                    onClick={() => run(() => requestCheck(l.id))}
                  >
                    <Play className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    title="Editar"
                    onClick={() =>
                      setEditando({
                        id: l.id,
                        name: l.name,
                        url: l.url,
                        expectedUrl: l.expectedUrl,
                        expectedText: l.expectedText,
                        expectRedirect: l.expectRedirect,
                        maxResponseMs: l.maxResponseMs,
                      })
                    }
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    title="Duplicar"
                    onClick={() => run(() => duplicateLink(l.id))}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    title={l.enabled ? "Dejar de vigilar (conserva el histórico)" : "Volver a vigilar"}
                    onClick={() => run(() => setLinkEnabled(l.id, !l.enabled))}
                  >
                    {l.enabled ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    title="Eliminar"
                    onClick={async () => {
                      if (
                        await confirmar({
                          title: `¿Eliminar «${l.name}»?`,
                          description:
                            "Se borra también su histórico de incidencias. Si solo quieres dejar de vigilarlo, usa el botón del ojo: eso conserva la historia.",
                          detail: l.url,
                          confirmLabel: "Eliminar",
                          destructive: true,
                        })
                      ) {
                        run(() => deleteLink(l.id));
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))}

        {retirados.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setVerRetirados((v) => !v)}>
            {verRetirados
              ? "Ocultar los que no se vigilan"
              : `Ver ${retirados.length} link(s) que ya no se vigilan`}
          </Button>
        )}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium">Historial de incidencias</h2>
        <div className="rounded-lg border bg-card divide-y">
          {incidents.length === 0 && (
            <p className="p-4 text-center text-sm text-muted-foreground">
              Sin incidencias registradas
            </p>
          )}
          {incidents.map((i) => (
            <div key={i.id} className="flex items-start justify-between gap-4 p-3">
              <div className="min-w-0">
                <p className="text-sm">{i.linkName}</p>
                {i.reason && (
                  <p className="truncate text-xs text-muted-foreground" title={i.reason}>
                    {i.reason}
                  </p>
                )}
              </div>
              <div className="shrink-0 text-right text-xs text-muted-foreground">
                <p>
                  {new Date(i.openedAt).toLocaleDateString("es-CO", {
                    day: "2-digit",
                    month: "short",
                  })}
                </p>
                <p>
                  {i.closedAt ? (
                    <>caído {duracion(i.openedAt, i.closedAt)}</>
                  ) : (
                    <span className="text-destructive">
                      caído desde hace {duracion(i.openedAt, null)}
                    </span>
                  )}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <LinkDialog
        link={editando}
        open={editando !== null || creando}
        onClose={() => {
          setEditando(null);
          setCreando(false);
        }}
      />
      {dialogo}
    </div>
  );
}
