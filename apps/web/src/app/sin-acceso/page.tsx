import { signOut } from "@/lib/auth";
import { Inbox } from "lucide-react";

export default function NoAccessPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md text-center">
        <Inbox className="mx-auto h-10 w-10 text-muted-foreground" />
        <h1 className="mt-4 text-xl font-semibold">Tu cuenta aún no tiene módulos asignados</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Entraste correctamente, pero todavía nadie te ha dado acceso a ninguna sección.
          Avisa a un administrador para que te asigne permisos.
        </p>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button className="mt-6 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted">
            Cerrar sesión
          </button>
        </form>
      </div>
    </div>
  );
}
