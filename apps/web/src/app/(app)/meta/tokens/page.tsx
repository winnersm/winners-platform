import { can } from "@winners/auth";
import { requireScope } from "@/lib/guards";
import TokenValidatorView from "./view";

export default async function Page() {
  const user = await requireScope("META", "tokens");
  // Validar los tokens guardados en Ajustes es cosa de quien administra Meta.
  return <TokenValidatorView canUseSavedBms={can(user, "META", "ADMIN")} />;
}
