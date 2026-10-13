"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { resetPassword } from "./actions";

/** Contraseña legible pero no adivinable. La persona la cambia al entrar. */
function sugerir() {
  const alfabeto = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  return "Winners." + Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join("");
}

/**
 * Sustituye al prompt() del navegador, que además de feo no permitía ver la
 * contraseña generada ni copiarla antes de aceptar.
 */
export function ResetPasswordDialog({
  user,
  onClose,
}: {
  user: { id: string; email: string; name: string | null } | null;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (user) setPassword(sugerir());
  }, [user]);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(password);
      toast.success("Contraseña copiada");
    } catch {
      toast.error("No se pudo copiar");
    }
  }

  function guardar() {
    startTransition(async () => {
      const res = await resetPassword(user!.id, password);
      if (res.ok) {
        toast.success(res.message);
        onClose();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={user !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restablecer contraseña</DialogTitle>
          <DialogDescription>
            {user?.name ?? user?.email}. Cópiala y pásasela por un canal seguro:
            no se podrá volver a ver. Tendrá que cambiarla al entrar.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="pw">Nueva contraseña</Label>
          <div className="flex gap-2">
            <Input
              id="pw"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="font-mono text-xs"
              autoComplete="off"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => setPassword(sugerir())} title="Generar otra">
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={copiar} title="Copiar">
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
          {password.length < 10 && (
            <p className="text-xs text-destructive">Mínimo 10 caracteres</p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={guardar} disabled={pending || password.length < 10}>
            {pending ? "Guardando…" : "Restablecer"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
