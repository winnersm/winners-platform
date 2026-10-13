import { requireScope } from "@/lib/guards";
import FanpagesView from "./view";

export default async function Page() {
  await requireScope("META", "fanpages");
  return <FanpagesView />;
}
