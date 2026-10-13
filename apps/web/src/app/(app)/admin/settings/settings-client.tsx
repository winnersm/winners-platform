"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Plus, Trash2, CheckCircle, XCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

interface BM {
  id: string;
  name: string;
  bmIdMeta: string;
  systemUserId: string;
  status: string;
  updatedAt: Date;
}

const schema = z.object({
  name: z.string().min(1, "Nombre requerido"),
  bmIdMeta: z.string().min(1, "BM ID requerido"),
  token: z.string().min(10, "Token requerido"),
});
type FormData = z.infer<typeof schema>;

export function SettingsClient({ initialBMs }: { initialBMs: BM[] }) {
  const [bms, setBms] = useState(initialBMs);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const { register, handleSubmit, reset, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  async function onSubmit(data: FormData) {
    setSaving(true);
    const res = await fetch("/api/settings/business-manager", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) {
      toast.error(json.error ?? "Error al guardar");
      return;
    }
    toast.success(`Business Manager "${json.name}" configurado`);
    reset();
    setOpen(false);
    const updated = await fetch("/api/settings/business-manager").then((r) => r.json());
    setBms(updated);
  }

  async function deactivate(id: string) {
    const res = await fetch(`/api/settings/business-manager?id=${id}`, { method: "DELETE" });
    if (res.ok) {
      setBms((prev) => prev.map((b) => b.id === id ? { ...b, status: "inactive" } : b));
      toast.success("Business Manager desactivado");
    } else {
      toast.error("Error al desactivar");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Business Managers</h2>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger
            render={
              <button className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90 transition-colors">
                <Plus className="h-4 w-4" />
                Añadir BM
              </button>
            }
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Configurar Business Manager</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 mt-2">
              <div className="space-y-1.5">
                <Label>Nombre</Label>
                <Input placeholder="BM Principal" {...register("name")} />
                {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>BM ID de Meta</Label>
                <Input placeholder="123456789012345" {...register("bmIdMeta")} />
                {errors.bmIdMeta && <p className="text-xs text-destructive">{errors.bmIdMeta.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Token de System User</Label>
                <Input type="text" autoComplete="off" placeholder="EAA..." {...register("token")} />
                {errors.token && <p className="text-xs text-destructive">{errors.token.message}</p>}
                <p className="text-xs text-muted-foreground">
                  Se verificará contra Meta API antes de guardar. Se almacena cifrado (AES-256-GCM).
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="outline" type="button" onClick={() => setOpen(false)}>
                  Cancelar
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? <RefreshCw className="h-4 w-4 mr-1 animate-spin" /> : null}
                  {saving ? "Verificando..." : "Guardar"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {bms.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground text-sm">
            No hay Business Managers configurados. Añade uno para empezar.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {bms.map((bm) => (
            <Card key={bm.id}>
              <CardHeader className="pb-2 pt-4 px-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {bm.status === "active" ? (
                      <CheckCircle className="h-4 w-4 text-green-500" />
                    ) : (
                      <XCircle className="h-4 w-4 text-muted-foreground" />
                    )}
                    <CardTitle className="text-base">{bm.name}</CardTitle>
                    <Badge variant={bm.status === "active" ? "default" : "secondary"}>
                      {bm.status === "active" ? "Activo" : "Inactivo"}
                    </Badge>
                  </div>
                  {bm.status === "active" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deactivate(bm.id)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <CardDescription className="text-xs">
                  BM ID: {bm.bmIdMeta} · System User: {bm.systemUserId} · Actualizado: {new Date(bm.updatedAt).toLocaleDateString("es-ES")}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
