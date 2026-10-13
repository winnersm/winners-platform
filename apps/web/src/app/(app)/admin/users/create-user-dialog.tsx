"use client";

import { useActionState, useEffect, useState } from "react";
import { toast } from "sonner";
import { UserPlus } from "lucide-react";
import { ROLES, ROLE_LABEL } from "@winners/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createUser, type ActionResult } from "./actions";

/** Contraseña temporal legible. La persona la cambia en su primer acceso. */
function suggestPassword() {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function CreateUserDialog() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    createUser,
    null,
  );

  useEffect(() => {
    if (open && !password) setPassword(suggestPassword());
  }, [open, password]);

  useEffect(() => {
    if (!state) return;
    if (state.ok) {
      toast.success(state.message);
      setOpen(false);
      setPassword("");
    } else {
      toast.error(state.error);
    }
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <UserPlus className="mr-1.5 h-4 w-4" />
            Nuevo usuario
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nuevo usuario</DialogTitle>
          <DialogDescription>
            Se crea sin acceso a ningún módulo. Los permisos se asignan después, desde
            la fila del usuario.
          </DialogDescription>
        </DialogHeader>

        <form action={action} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">Nombre</Label>
            <Input id="name" name="name" required placeholder="Samuel" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email">Correo</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              placeholder="samuel@winnersmastermind.com"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="role">Rol</Label>
            <select
              id="role"
              name="role"
              defaultValue="OPERATOR"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              {ROLES.filter((r) => r !== "SERVICE").map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Contraseña temporal</Label>
            <div className="flex gap-2">
              <Input
                id="password"
                name="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="font-mono text-xs"
                required
              />
              <Button type="button" variant="outline" onClick={() => setPassword(suggestPassword())}>
                Otra
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Cópiala y pásasela por un canal seguro. Tendrá que cambiarla al entrar.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creando…" : "Crear usuario"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
