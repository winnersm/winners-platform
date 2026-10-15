import { requireScope } from "@/lib/guards";
import SpendView from "./view";

export default async function Page() {
  // Mismo acceso que el dashboard de rendimiento (datos del mismo tipo).
  await requireScope("META", "dashboard");
  return <SpendView />;
}
