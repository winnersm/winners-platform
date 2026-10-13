import { requireScope } from "@/lib/guards";
import { PageHeader } from "@/components/page-header";
import { HistorialView } from "./view";

export const dynamic = "force-dynamic";

export default async function HistorialPage() {
  await requireScope("CLONER", "historial");

  return (
    <div>
      <PageHeader
        title="Historial de copias"
        description="Qué se copió, a dónde, cuándo y con qué incidencias."
      />
      <HistorialView />
    </div>
  );
}
