import { requireScope } from "@/lib/guards";
import AccountsView from "./view";

export default async function Page() {
  await requireScope("META", "accounts");
  return <AccountsView />;
}
