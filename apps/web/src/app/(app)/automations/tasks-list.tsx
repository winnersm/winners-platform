"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Play, Clock, CheckCircle2, XCircle, FlaskConical, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/use-confirm";
import {
  setTaskEnabled,
  setTaskSchedule,
  setTaskScope,
  setTaskDryRun,
  runTaskNow,
  type ActionResult,
} from "./actions";

interface Account {
  id: string;
  name: string;
  status: string | null;
}

interface Task {
  name: string;
  displayName: string;
  description: string | null;
  cron: string;
  enabled: boolean;
  dryRun: boolean;
  scopeMode: string;
  scopeAccounts: string[];
  pending: boolean;
  lastRun: { at: string; success: boolean | null; error: string | null } | null;
}

/** Traduce un cron a algo legible. Nadie debería tener que descifrar "1,31 7-19 * * *". */
function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour] = parts;

  if (min.startsWith("*/")) return `cada ${min.slice(2)} minutos`;
  if (hour === "*") return `al minuto ${min} de cada hora`;
  if (hour.includes("-")) {
    const [from, to] = hour.split("-");
    return `minutos ${min}, de ${from}:00 a ${to}:59`;
  }
  if (/^\d+$/.test(hour)) return `todos los días a las ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  return cron;
}

export function TasksList({
  tasks,
  accounts,
  canEdit,
  masterOn,
}: {
  tasks: Task[];
  accounts: Account[];
  canEdit: boolean;
  masterOn: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<string | null>(null);
  const { confirmar, dialogo } = useConfirm();

  function run(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <div className="space-y-3">
      {!masterOn && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          Todas las automatizaciones están detenidas por el interruptor general. La
          configuración de cada tarea se conserva, pero ninguna se ejecuta.
        </div>
      )}

      {tasks.map((t) => (
        <div key={t.name} className="rounded-lg border bg-card">
          <div className="flex items-start justify-between gap-4 p-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{t.displayName}</h3>
                {!t.enabled && <Badge variant="secondary" className="text-xs">Desactivada</Badge>}
                {t.dryRun && (
                  <Badge variant="outline" className="text-xs">
                    <FlaskConical className="mr-1 h-3 w-3" />
                    modo prueba
                  </Badge>
                )}
                {t.pending && <Badge className="text-xs">ejecución encolada</Badge>}
              </div>

              {t.description && (
                <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {describeCron(t.cron)}
                </span>

                <span>
                  {t.scopeMode === "ALL"
                    ? "todas las cuentas"
                    : t.scopeMode === "INCLUDE"
                      ? `solo ${t.scopeAccounts.length} cuenta(s)`
                      : `todas menos ${t.scopeAccounts.length}`}
                </span>

                {t.lastRun && (
                  <span className="flex items-center gap-1">
                    {t.lastRun.success ? (
                      <CheckCircle2 className="h-3 w-3 text-green-600" />
                    ) : (
                      <XCircle className="h-3 w-3 text-destructive" />
                    )}
                    {new Date(t.lastRun.at).toLocaleString("es-CO", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </span>
                )}
              </div>

              {t.lastRun && !t.lastRun.success && t.lastRun.error && (
                <p className="mt-1.5 truncate text-xs text-destructive" title={t.lastRun.error}>
                  {t.lastRun.error}
                </p>
              )}
            </div>

            {canEdit && (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending || t.pending}
                  title="Ejecutar ahora"
                  onClick={() => run(() => runTaskNow(t.name))}
                >
                  <Play className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setOpen(open === t.name ? null : t.name)}
                >
                  <Settings2 className="mr-1 h-3.5 w-3.5" />
                  {open === t.name ? "Cerrar" : "Ajustes"}
                </Button>
                <Button
                  size="sm"
                  variant={t.enabled ? "outline" : "default"}
                  disabled={pending}
                  onClick={async () => {
                    if (
                      t.enabled &&
                      !(await confirmar({
                        title: `¿Desactivar «${t.displayName}»?`,
                        description: "Dejará de ejecutarse hasta que la vuelvas a activar.",
                        detail: describeCron(t.cron),
                        confirmLabel: "Desactivar",
                        destructive: true,
                      }))
                    ) {
                      return;
                    }
                    run(() => setTaskEnabled(t.name, !t.enabled));
                  }}
                >
                  {t.enabled ? "Desactivar" : "Activar"}
                </Button>
              </div>
            )}
          </div>

          {open === t.name && canEdit && (
            <TaskSettings task={t} accounts={accounts} pending={pending} run={run} />
          )}
        </div>
      ))}
      {dialogo}
    </div>
  );
}

function TaskSettings({
  task,
  accounts,
  pending,
  run,
}: {
  task: Task;
  accounts: Account[];
  pending: boolean;
  run: (fn: () => Promise<ActionResult>) => void;
}) {
  const [cron, setCron] = useState(task.cron);
  const [mode, setMode] = useState(task.scopeMode);
  const [selected, setSelected] = useState<string[]>(task.scopeAccounts);
  const [filter, setFilter] = useState("");

  const visible = accounts.filter(
    (a) =>
      !filter.trim() ||
      a.name.toLowerCase().includes(filter.toLowerCase()) ||
      a.id.includes(filter),
  );

  return (
    <div className="grid gap-6 border-t bg-muted/30 p-4 md:grid-cols-2">
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-xs font-medium">Horario</p>
          <div className="flex gap-2">
            <Input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className="font-mono text-xs"
              placeholder="0 8 * * *"
            />
            <Button
              size="sm"
              disabled={pending || cron === task.cron}
              onClick={() => run(() => setTaskSchedule(task.name, cron))}
            >
              Guardar
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {describeCron(cron)} · hora de Colombia
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Formato: minuto hora día mes día-semana
          </p>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-medium">Modo prueba</p>
          <Button
            size="sm"
            variant={task.dryRun ? "default" : "outline"}
            disabled={pending}
            onClick={() => run(() => setTaskDryRun(task.name, !task.dryRun))}
          >
            <FlaskConical className="mr-1.5 h-3.5 w-3.5" />
            {task.dryRun ? "Desactivar modo prueba" : "Activar modo prueba"}
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            Con el modo prueba, la tarea informa de lo que haría sin llegar a
            pausar ni borrar nada. Útil antes de cambiar el alcance.
          </p>
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium">Sobre qué cuentas actúa</p>

        <div className="mb-2 flex gap-1.5">
          {(["ALL", "INCLUDE", "EXCLUDE"] as const).map((m) => (
            <Button
              key={m}
              size="sm"
              variant={mode === m ? "default" : "outline"}
              disabled={pending}
              onClick={() => setMode(m)}
            >
              {m === "ALL" ? "Todas" : m === "INCLUDE" ? "Solo estas" : "Todas menos"}
            </Button>
          ))}
        </div>

        {mode !== "ALL" && (
          <>
            <Input
              placeholder="Buscar cuenta…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="mb-2 text-xs"
            />
            <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border bg-card p-2">
              {visible.length === 0 && (
                <p className="py-2 text-center text-xs text-muted-foreground">
                  {accounts.length === 0
                    ? "Aún no hay cuentas registradas. Aparecerán tras la primera revisión de saldo."
                    : "Ninguna coincide"}
                </p>
              )}
              {visible.map((a) => (
                <label key={a.id} className="flex items-center gap-2 py-0.5 text-xs">
                  <input
                    type="checkbox"
                    className="rounded border"
                    checked={selected.includes(a.id)}
                    onChange={(e) =>
                      setSelected((prev) =>
                        e.target.checked ? [...prev, a.id] : prev.filter((x) => x !== a.id),
                      )
                    }
                  />
                  <span className="truncate">{a.name}</span>
                  {a.status && a.status !== "ACTIVE" && (
                    <Badge variant="secondary" className="ml-auto text-xs">
                      {a.status}
                    </Badge>
                  )}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {selected.length} seleccionada(s) de {accounts.length}
            </p>
          </>
        )}

        <Button
          size="sm"
          className="mt-2"
          disabled={
            pending ||
            (mode === task.scopeMode &&
              JSON.stringify([...selected].sort()) === JSON.stringify([...task.scopeAccounts].sort()))
          }
          onClick={() => run(() => setTaskScope(task.name, mode, selected))}
        >
          Guardar alcance
        </Button>
      </div>
    </div>
  );
}
