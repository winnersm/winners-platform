import { requireScope } from "@/lib/guards";
import CampaignsView from "./view";

export default async function Page() {
  await requireScope("META", "campaigns");
  return <CampaignsView />;
}
