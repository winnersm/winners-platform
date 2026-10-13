import { AppSidebar } from "@/components/app-sidebar";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "@/components/theme-toggle";
import { OperationSwitcher } from "@/components/operation-switcher";
import { requireUser } from "@/lib/guards";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  return (
    <SidebarProvider>
      <AppSidebar
        role={user.role}
        grants={user.grants}
        operations={user.operations}
        userName={user.name}
        userEmail={user.email}
      />
      {/*
        min-w-0 es lo que impide que una tabla ancha empuje la página entera y
        obligue a hacer scroll horizontal. Sin él, este panel no puede
        encogerse por debajo del ancho de su contenido (comportamiento por
        defecto de flex), así que el `overflow-x-auto` que ya traen las tablas
        nunca llega a activarse.
      */}
      <SidebarInset className="min-w-0">
        <header className="flex h-12 items-center gap-2 border-b bg-card px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-4" />
          <OperationSwitcher />
          <ThemeToggle />
        </header>
        <main className="min-w-0 flex-1 p-5">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
