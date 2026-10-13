"use client";

import { Fragment, useState, useTransition } from "react";
import { toast } from "sonner";
import { KeyRound, Ban, RotateCcw, ShieldCheck } from "lucide-react";
import {
  MODULES,
  LEVELS,
  ROLES,
  MODULE_META,
  ROLE_LABEL,
  LEVEL_LABEL,
  type Level,
  type Module,
} from "@winners/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { setRole, setGrant, setStatus, resetPassword, setMembership, type ActionResult } from "./actions";
import { useConfirm } from "@/components/use-confirm";
import { ResetPasswordDialog } from "./reset-password-dialog";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  grants: { module: string; level: string; scopes: string[] }[];
  operations: string[];
}

export function UsersTable({
  users,
  operations,
  canEdit,
  currentUserId,
}: {
  users: UserRow[];
  operations: { id: string; name: string }[];
  canEdit: boolean;
  currentUserId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [reseteando, setReseteando] = useState<UserRow | null>(null);
  const { confirmar, dialogo } = useConfirm();

  function run(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  function levelOf(u: UserRow, m: Module): Level {
    return (u.grants.find((g) => g.module === m)?.level as Level) ?? "NONE";
  }

  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Persona</TableHead>
            <TableHead>Rol</TableHead>
            <TableHead>Módulos</TableHead>
            <TableHead>Último acceso</TableHead>
            <TableHead className="text-right">Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => {
            const suspended = u.status !== "ACTIVE";
            const isOpen = expanded === u.id;

            return (
              <Fragment key={u.id}>
                <TableRow className={suspended ? "opacity-50" : undefined}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {u.role === "OWNER" && <ShieldCheck className="h-3.5 w-3.5 text-primary" />}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{u.name ?? u.email}</p>
                        <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                      </div>
                    </div>
                  </TableCell>

                  <TableCell>
                    {canEdit && u.id !== currentUserId ? (
                      <select
                        className="rounded-md border bg-background px-2 py-1 text-xs"
                        value={u.role}
                        disabled={pending}
                        onChange={async (e) => {
                          const nuevo = e.target.value;
                          const anterior = u.role;
                          // Cambiar un rol con un solo clic es demasiado fácil de
                          // hacer sin querer, y decide lo que esa persona puede
                          // tocar. Se confirma siempre.
                          if (
                            !(await confirmar({
                              title: `¿Cambiar el rol de ${u.name ?? u.email}?`,
                              detail: `${ROLE_LABEL[anterior as keyof typeof ROLE_LABEL]} → ${ROLE_LABEL[nuevo as keyof typeof ROLE_LABEL]}`,
                              confirmLabel: "Cambiar rol",
                            }))
                          ) {
                            e.target.value = anterior; // deshacer visualmente
                            return;
                          }
                          run(() => setRole(u.id, nuevo));
                        }}
                      >
                        {ROLES.filter((r) => r !== "SERVICE").map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Badge variant="secondary">{ROLE_LABEL[u.role as keyof typeof ROLE_LABEL]}</Badge>
                    )}
                  </TableCell>

                  <TableCell>
                    {u.role === "OWNER" ? (
                      <span className="text-xs text-muted-foreground">Todos (es dueño)</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {u.grants.length === 0 && (
                          <span className="text-xs text-muted-foreground">Ninguno</span>
                        )}
                        {u.grants.map((g) => (
                          <Badge key={g.module} variant="outline" className="text-xs">
                            {MODULE_META.find((m) => m.key === g.module)?.label ?? g.module}
                            <span className="ml-1 text-muted-foreground">
                              {LEVEL_LABEL[g.level as Level]}
                            </span>
                            {/* Sin esto, un módulo restringido a unas pocas
                                secciones parece acceso completo. */}
                            {g.scopes && g.scopes.length > 0 && (
                              <span className="ml-1 text-muted-foreground">
                                · solo {g.scopes.join(", ")}
                              </span>
                            )}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>

                  <TableCell className="text-xs text-muted-foreground">
                    {u.lastLoginAt
                      ? new Date(u.lastLoginAt).toLocaleString("es-CO", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })
                      : "Nunca"}
                    {u.mustChangePassword && (
                      <Badge variant="outline" className="ml-2 text-xs">
                        cambio pendiente
                      </Badge>
                    )}
                  </TableCell>

                  <TableCell className="text-right">
                    {canEdit && (
                      <div className="flex justify-end gap-1">
                        {u.role !== "OWNER" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            onClick={() => setExpanded(isOpen ? null : u.id)}
                          >
                            {isOpen ? "Cerrar" : "Permisos"}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          title="Restablecer contraseña"
                          onClick={() => setReseteando(u)}
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                        </Button>
                        {u.id !== currentUserId && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending}
                            title={suspended ? "Reactivar" : "Suspender"}
                            onClick={async () => {
                              if (
                                !suspended &&
                                !(await confirmar({
                                  title: `¿Suspender a ${u.name ?? u.email}?`,
                                  description:
                                    "Pierde el acceso a toda la plataforma en cuanto se refresque su sesión. Su historial se conserva.",
                                  confirmLabel: "Suspender",
                                  destructive: true,
                                }))
                              ) {
                                return;
                              }
                              run(() => setStatus(u.id, suspended));
                            }}
                          >
                            {suspended ? (
                              <RotateCcw className="h-3.5 w-3.5" />
                            ) : (
                              <Ban className="h-3.5 w-3.5 text-destructive" />
                            )}
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>

                {isOpen && canEdit && (
                  <TableRow>
                    <TableCell colSpan={5} className="bg-muted/40">
                      <div className="grid gap-4 p-2 md:grid-cols-2">
                        <div>
                          <p className="mb-2 text-xs font-medium">Acceso por módulo</p>
                          <div className="space-y-1.5">
                            {MODULES.filter((m) => m !== "ADMIN").map((m) => (
                              <div key={m} className="flex items-center justify-between gap-3">
                                <span className="text-sm">
                                  {MODULE_META.find((x) => x.key === m)?.label}
                                </span>
                                <select
                                  className="rounded-md border bg-background px-2 py-1 text-xs"
                                  value={levelOf(u, m)}
                                  disabled={pending}
                                  onChange={(e) => run(() => setGrant(u.id, m, e.target.value))}
                                >
                                  {LEVELS.map((l) => (
                                    <option key={l} value={l}>
                                      {LEVEL_LABEL[l]}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ))}
                          </div>
                          <p className="mt-2 text-xs text-muted-foreground">
                            Administración solo está disponible para el rol Dueño.
                          </p>
                        </div>

                        <div>
                          <p className="mb-2 text-xs font-medium">Operaciones</p>
                          {operations.length === 0 && (
                            <p className="text-xs text-muted-foreground">
                              Todavía no hay operaciones creadas.
                            </p>
                          )}
                          <div className="space-y-1.5">
                            {operations.map((op) => (
                              <label key={op.id} className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  className="rounded border"
                                  checked={u.operations.includes(op.id)}
                                  disabled={pending}
                                  onChange={(e) =>
                                    run(() => setMembership(u.id, op.id, e.target.checked))
                                  }
                                />
                                {op.name}
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      <ResetPasswordDialog user={reseteando} onClose={() => setReseteando(null)} />
      {dialogo}
    </div>
  );
}
