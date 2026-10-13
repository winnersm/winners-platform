import { requireGrant } from "@/lib/guards";
import { PageHeader } from "@/components/page-header";
import { LogViewer } from "./log-viewer";

export const dynamic = "force-dynamic";

export default async function LogsPage() {
  await requireGrant("AUTOMATIONS");
  return (
    <div>
      <PageHeader
        title="Registro del worker"
        description="Lo que va escribiendo el proceso que ejecuta las tareas"
      />
      <LogViewer />
    </div>
  );
}
