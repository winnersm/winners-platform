import Link from "next/link";
import { ShieldX } from "lucide-react";

export default function ForbiddenPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md text-center">
        <ShieldX className="mx-auto h-10 w-10 text-muted-foreground" />
        <h1 className="mt-4 text-xl font-semibold">No tienes acceso a esta sección</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Tu cuenta no tiene permiso sobre este módulo. Si crees que deberías tenerlo,
          pídeselo a un administrador.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Volver
        </Link>
      </div>
    </div>
  );
}
