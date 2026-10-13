import { requireScope } from "@/lib/guards";
import JobsView from "./view";

export default async function Page() {
  await requireScope("META", "jobs");
  return <JobsView />;
}
