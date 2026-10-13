"use client";

import { useEffect, useState } from "react";
import { Building } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

interface Op { id: string; name: string; slug: string }

export function OperationSwitcher() {
  const [ops, setOps] = useState<Op[]>([]);
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    fetch("/api/operations")
      .then((r) => (r.ok ? r.json() : { operations: [] }))
      .then((j) => { setOps(j.operations ?? []); setActive(j.active ?? ""); })
      .catch(() => {});
  }, []);

  if (ops.length === 0) return null;

  // Con una sola operación: mostrar el nombre como etiqueta (sin selector).
  if (ops.length === 1) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium">
        <Building className="h-4 w-4 text-muted-foreground" />
        {ops[0].name}
      </span>
    );
  }

  async function change(id: string) {
    if (!id || id === active) return;
    await fetch("/api/operations/active", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId: id }),
    }).catch(() => {});
    // Recargar para traer los datos de la nueva operación en toda la app.
    window.location.reload();
  }

  return (
    <Select value={active} onValueChange={(v) => v && change(v)}>
      <SelectTrigger className="h-8 text-xs w-48 gap-1">
        <Building className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <SelectValue>{ops.find((o) => o.id === active)?.name ?? "Operación"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {ops.map((o) => <SelectItem key={o.id} value={o.id} className="text-xs">{o.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
