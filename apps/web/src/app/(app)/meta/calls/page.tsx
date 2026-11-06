import { requireScope } from "@/lib/guards";
import CallsView from "./view";

export default async function Page() {
  await requireScope("META", "dashboard");
  return <CallsView />;
}
