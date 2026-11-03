// Límites de duplicación por petición. Sin dependencias: los usan la API y los
// modales del navegador (importar la cola aquí metería bullmq en el cliente).
export const DUPLICATE_LIMITS = {
  /** Copias por campaña. */
  copiesPerCampaign: 50,
  /** Total de trabajos que puede crear una sola petición (campañas × copias). */
  jobsPerRequest: 100,
};
