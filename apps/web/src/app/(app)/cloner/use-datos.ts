"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * Carga una lista del servidor al abrir la pantalla, con su botón de recargar.
 *
 * Lo usan las tres pantallas de listado (tokens, plantillas, historial), que
 * hacían exactamente lo mismo. Además evita el problema clásico de este patrón:
 * si la pantalla se cierra mientras la petición está en vuelo, la respuesta
 * llega a un componente que ya no existe.
 */
export function useDatos<T>(
  cargar: () => Promise<T>,
  inicial: T,
): { datos: T; cargando: boolean; recargar: () => void } {
  const [datos, setDatos] = useState<T>(inicial);
  const [cargando, setCargando] = useState(true);
  // Cambiar este número vuelve a disparar el efecto.
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let vivo = true;
    cargar()
      .then((d) => vivo && setDatos(d))
      .catch((e) => {
        if (vivo) toast.error(e instanceof Error ? e.message : "No se pudo cargar");
      })
      .finally(() => vivo && setCargando(false));
    return () => {
      vivo = false;
    };
    // `cargar` se redefine en cada render del componente que lo usa; seguirlo
    // dispararía una petición por render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intento]);

  const recargar = useCallback(() => {
    // Sin esto, pulsar "Actualizar" no daba ninguna señal de que estuviera
    // pasando algo hasta que llegaban los datos.
    setCargando(true);
    setIntento((n) => n + 1);
  }, []);

  return { datos, cargando, recargar };
}
