"use client";

import { useCallback, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";

interface Peticion {
  title: ReactNode;
  description?: ReactNode;
  detail?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
}

/**
 * Confirmación con el diseño de la aplicación, en lugar del window.confirm
 * del navegador.
 *
 * Más allá de la estética: el nativo bloquea toda la pestaña, no admite
 * formato ni detalle, y en algunos navegadores puede desactivarse por
 * completo — con lo que la acción se ejecutaría sin preguntar.
 *
 *   const { confirmar, dialogo } = useConfirm();
 *   ...
 *   if (await confirmar({ title: "¿Borrar?", destructive: true })) hazlo();
 *   ...
 *   return <>{contenido}{dialogo}</>;
 */
export function useConfirm() {
  const [peticion, setPeticion] = useState<Peticion | null>(null);
  const [resolver, setResolver] = useState<((v: boolean) => void) | null>(null);

  const confirmar = useCallback((p: Peticion): Promise<boolean> => {
    setPeticion(p);
    return new Promise<boolean>((resolve) => {
      // Se guarda dentro de una función para que React no la trate como
      // actualización perezosa e invoque la promesa al momento.
      setResolver(() => resolve);
    });
  }, []);

  const cerrar = useCallback(
    (valor: boolean) => {
      resolver?.(valor);
      setResolver(null);
      setPeticion(null);
    },
    [resolver],
  );

  const dialogo = (
    <ConfirmDialog
      open={peticion !== null}
      onOpenChange={(abierto) => {
        if (!abierto) cerrar(false);
      }}
      title={peticion?.title ?? ""}
      description={peticion?.description}
      detail={peticion?.detail}
      confirmLabel={peticion?.confirmLabel}
      destructive={peticion?.destructive}
      onConfirm={() => cerrar(true)}
    />
  );

  return { confirmar, dialogo };
}
