import { canScope } from "@winners/auth";
import { requireScope } from "@/lib/guards";
import { PageHeader } from "@/components/page-header";
import { ClonerView } from "./view";

export const dynamic = "force-dynamic";

export default async function ClonerPage() {
  const user = await requireScope("CLONER", "clonar");
  const puedeEscribir = canScope(user, "CLONER", "clonar", "WRITE");

  // Lo que haya en marcha lo enseña la propia cola, dentro del paso 6: ahí se
  // ve de todo el mundo, con su progreso y la opción de pararlo.
  return (
    <div>
      <PageHeader
        title="Clonar una campaña"
        description="Copia una campaña completa a otra cuenta, incluso de otro Business Manager. Cada cuenta recibe su propia copia de los vídeos e imágenes, y todo se crea en PAUSED."
      />
      <ClonerView puedeEscribir={puedeEscribir} />
    </div>
  );
}
