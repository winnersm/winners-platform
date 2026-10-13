import { requireScope } from "@/lib/guards";
import LaunchesView from "./view";

export default async function Page() {
  await requireScope("META", "launches");
  return <LaunchesView />;
}
