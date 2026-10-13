"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/use-confirm";
import { setMasterSwitch } from "./actions";

/** Botón de pánico: para todas las tareas de golpe. */
export function MasterSwitch({ on, canEdit }: { on: boolean; canEdit: boolean }) {
  const [pending, startTransition] = useTransition();
  const { confirmar, dialogo } = useConfirm();

  if (!canEdit) {
    return (
      <span className="text-xs text-muted-foreground">
        {on ? "Automatizaciones activas" : "Automatizaciones detenidas"}
      </span>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant={on ? "outline" : "default"}
        disabled={pending}
        onClick={async () => {
          if (
            on &&
            !(await confirmar({
              title: "¿Detener TODAS las automatizaciones?",
              description:
                "Ninguna se ejecutará hasta que las reanudes. La configuración de cada tarea se conserva.",
              confirmLabel: "Detener todo",
              destructive: true,
            }))
          ) {
            return;
          }
          startTransition(async () => {
            const res = await setMasterSwitch(!on);
            if (res.ok) toast.success(res.message);
            else toast.error(res.error);
          });
        }}
      >
        <Power className={on ? "mr-1.5 h-4 w-4 text-destructive" : "mr-1.5 h-4 w-4"} />
        {on ? "Detener todo" : "Reanudar todo"}
      </Button>
      {dialogo}
    </>
  );
}
