import { redirect } from "next/navigation";
import { prisma } from "@winners/db";
import { requireUser } from "@/lib/guards";
import { PageHeader } from "@/components/page-header";
import { CreateSecretDialog } from "./create-secret-dialog";
import { SecretsClient } from "./secrets-client";

export const dynamic = "force-dynamic";

export default async function SecretsPage() {
  // Solo OWNER: el modelo de roles reserva los secretos al dueño (ADMIN no los toca).
  const actor = await requireUser();
  if (actor.role !== "OWNER") redirect("/403");

  const secrets = await prisma.secret.findMany({
    orderBy: [{ section: "asc" }, { key: "asc" }],
  });

  return (
    <div>
      <PageHeader
        title="Secretos"
        description="Bóveda cifrada (AES-256-GCM). Los valores nunca se muestran salvo que los reveles de forma explícita y auditada."
        actions={<CreateSecretDialog />}
      />

      <SecretsClient
        secrets={secrets.map((s) => ({
          id: s.id,
          key: s.key,
          label: s.label,
          section: s.section,
          hint: s.hint,
          updatedAt: s.updatedAt.toISOString(),
        }))}
      />
    </div>
  );
}
