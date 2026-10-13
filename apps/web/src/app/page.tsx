import { redirect } from "next/navigation";
import { landingPath } from "@winners/auth";
import { currentUser } from "@/lib/guards";

export default async function RootPage() {
  const user = await currentUser();
  // Sin sesión lo resuelve proxy.ts; aquí solo se decide a dónde va quien sí la tiene.
  redirect(user ? landingPath(user) : "/login");
}
