import { canScope } from "@winners/auth";
import { requireScope } from "@/lib/guards";
import { PageHeader } from "@/components/page-header";
import { TokensView } from "./view";

export const dynamic = "force-dynamic";

export default async function TokensPage() {
  const user = await requireScope("CLONER", "tokens");
  const puedeEscribir = canScope(user, "CLONER", "tokens", "WRITE");

  return (
    <div>
      <PageHeader
        title="Tokens de Meta"
        description="Credenciales con las que el clonador lee y escribe en las cuentas. Se guardan cifradas y nunca vuelven a salir del servidor."
      />
      <TokensView puedeEscribir={puedeEscribir} />
    </div>
  );
}
