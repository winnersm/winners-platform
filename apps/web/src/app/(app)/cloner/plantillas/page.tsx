import { canScope } from "@winners/auth";
import { requireScope } from "@/lib/guards";
import { PageHeader } from "@/components/page-header";
import { PlantillasView } from "./view";

export const dynamic = "force-dynamic";

export default async function PlantillasPage() {
  const user = await requireScope("CLONER", "plantillas");
  const puedeEscribir = canScope(user, "CLONER", "plantillas", "WRITE");
  // Lanzar una plantilla crea campañas reales: es permiso de clonado, no de
  // plantillas. Alguien puede administrar plantillas sin poder lanzarlas.
  const puedeLanzar = canScope(user, "CLONER", "clonar", "WRITE");

  return (
    <div>
      <PageHeader
        title="Plantillas"
        description="Una plantilla congela la estructura completa de una campaña —adsets, anuncios y el contenido de todos los idiomas— para lanzarla en cualquier cuenta sin depender de la original."
      />
      <PlantillasView puedeEscribir={puedeEscribir} puedeLanzar={puedeLanzar} />
    </div>
  );
}
