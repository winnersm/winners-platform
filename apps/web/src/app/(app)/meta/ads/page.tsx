import { requireScope } from "@/lib/guards";
import AdsView from "./view";

export default async function Page() {
  await requireScope("META", "campaigns");
  return <AdsView />;
}
