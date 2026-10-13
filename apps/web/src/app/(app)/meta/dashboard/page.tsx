import { requireScope } from "@/lib/guards";
import DashboardView from "./view";

export default async function Page() {
  await requireScope("META", "dashboard");
  return <DashboardView />;
}
