import { requireScope } from "@/lib/guards";
import AdsetsView from "./view";

export default async function Page() {
  await requireScope("META", "campaigns");
  return <AdsetsView />;
}
