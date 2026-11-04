// Comunicación con el panel flotante de Trabajos desde cualquier pantalla.
const OPEN = "jobs-dock:open";
const CHANGED = "jobs-dock:changed";

/** Abre el panel sin salir de la pantalla actual. */
export function openJobsDock() {
  window.dispatchEvent(new Event(OPEN));
}

/** Avisa de que se encoló algo: el panel se actualiza sin esperar a su próxima consulta. */
export function notifyJobsChanged() {
  window.dispatchEvent(new Event(CHANGED));
}

export const JOBS_DOCK_EVENTS = { OPEN, CHANGED };
