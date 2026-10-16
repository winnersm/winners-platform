"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  Building2,
  Megaphone,
  ClockIcon,
  Settings,
  LogOut,
  Zap,
  Briefcase,
  Contact,
  Rocket,
  LayoutDashboard,
  CalendarDays,
  Timer,
  Link2,
  Activity,
  ShieldCheck,
  Users,
  KeyRound,
  ExternalLink,
  History,
  ScrollText,
  CopyPlus,
  LayoutTemplate,
  Palette,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { can, canScope, ROLE_LABEL, type Grant, type Module, type Role } from "@winners/auth";

/**
 * Menú lateral. Cada entrada declara a qué módulo pertenece; se dibujan solo
 * las de módulos que la persona puede ver.
 *
 * Esconder una entrada NO es seguridad — es claridad. Quien escriba la URL a
 * mano se topa con el middleware y con requireGrant.
 */

interface NavItem {
  href: string;
  label: string;
  icon: typeof Zap;
  module: Module;
  /** Sección dentro del módulo, para el permiso fino. */
  scope?: string;
}

const NAV_GROUPS: { label: string; module: Module; items: NavItem[] }[] = [
  {
    label: "Meta Ads",
    module: "META",
    items: [
      { scope: "dashboard", href: "/meta/dashboard", label: "Rendimiento", icon: LayoutDashboard, module: "META" },
      { scope: "dashboard", href: "/meta/spend", label: "Gasto histórico", icon: CalendarDays, module: "META" },
      { scope: "accounts", href: "/meta/accounts", label: "Cuentas", icon: Building2, module: "META" },
      { scope: "campaigns", href: "/meta/campaigns", label: "Campañas", icon: Megaphone, module: "META" },
      { scope: "fanpages", href: "/meta/fanpages", label: "Fanpages", icon: Contact, module: "META" },
      { scope: "launches", href: "/meta/launches", label: "Lanzamientos", icon: Rocket, module: "META" },
      { scope: "jobs", href: "/meta/jobs", label: "Trabajos", icon: Briefcase, module: "META" },
    ],
  },
  {
    label: "Automations",
    module: "AUTOMATIONS",
    items: [
      { href: "/automations", label: "Tareas", icon: Timer, module: "AUTOMATIONS" },
      { href: "/automations/actividad", label: "Actividad", icon: History, module: "AUTOMATIONS" },
      { href: "/automations/billing", label: "Billing", icon: Activity, module: "AUTOMATIONS" },
      { href: "/automations/logs", label: "Registro", icon: ScrollText, module: "AUTOMATIONS" },
    ],
  },
  {
    label: "Links",
    module: "LINKS",
    items: [
      { href: "/links", label: "Enlaces", icon: Link2, module: "LINKS" },
      { href: "/links/domains", label: "Dominios", icon: ExternalLink, module: "LINKS" },
    ],
  },
  {
    label: "Monitor",
    module: "MONITOR",
    items: [{ href: "/monitor", label: "Tracking links", icon: Activity, module: "MONITOR" }],
  },
  {
    label: "Clonador",
    module: "CLONER",
    items: [
      { scope: "clonar", href: "/cloner", label: "Clonar", icon: CopyPlus, module: "CLONER" },
      { scope: "plantillas", href: "/cloner/plantillas", label: "Plantillas", icon: LayoutTemplate, module: "CLONER" },
      { scope: "tokens", href: "/cloner/tokens", label: "Tokens", icon: KeyRound, module: "CLONER" },
      { scope: "historial", href: "/cloner/historial", label: "Historial", icon: History, module: "CLONER" },
    ],
  },
  {
    label: "Administración",
    module: "ADMIN",
    items: [
      { href: "/admin/users", label: "Usuarios", icon: Users, module: "ADMIN" },
      { href: "/admin/secrets", label: "Secretos", icon: KeyRound, module: "ADMIN" },
      { href: "/admin/audit", label: "Historial", icon: ClockIcon, module: "ADMIN" },
      { href: "/admin/settings", label: "Ajustes", icon: Settings, module: "ADMIN" },
    ],
  },
];

/**
 * Aplicaciones que todavía viven fuera de la plataforma.
 *
 * Son enlaces y nada más: no comparten sesión ni datos, y cada una pide su
 * propio acceso. Están aquí para que haya un solo sitio desde el que llegar a
 * todo mientras se van consolidando; añadir otra es una línea más.
 */
const APPS_EXTERNAS: { href: string; label: string; icon: typeof Zap }[] = [
  { href: "https://creative.mastermindwinners.com/", label: "Creative", icon: Palette },
];

interface AppSidebarProps {
  role: Role;
  grants: Grant[];
  operations: string[];
  userName: string | null | undefined;
  userEmail: string | null | undefined;
}

export function AppSidebar({ role, grants, operations, userName, userEmail }: AppSidebarProps) {
  const pathname = usePathname();
  const principal = { id: "", email: userEmail ?? "", role, grants, operations };

  const groups = NAV_GROUPS.filter((g) => can(principal, g.module, "READ"))
    .map((g) => ({
      ...g,
      // Dentro de un módulo permitido, se ocultan las secciones no concedidas.
      items: g.items.filter((i) => !i.scope || canScope(principal, i.module, i.scope)),
    }))
    .filter((g) => g.items.length > 0);

  return (
    <Sidebar>
      <SidebarHeader className="border-b border-sidebar-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm">Winners</span>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.module}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      render={<Link href={item.href} />}
                      isActive={
                        pathname === item.href ||
                        // Las entradas que además son prefijo de otras marcarían
                        // "activo" estando en una hija: /cloner con /cloner/tokens.
                        (item.href !== "/automations" &&
                          item.href !== "/links" &&
                          item.href !== "/cloner" &&
                          pathname.startsWith(`${item.href}/`))
                      }
                      className="flex items-center gap-2"
                    >
                      <item.icon className="h-4 w-4" />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}

        <SidebarGroup>
          <SidebarGroupLabel>Otras apps</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {APPS_EXTERNAS.map((app) => (
                <SidebarMenuItem key={app.href}>
                  <SidebarMenuButton
                    render={
                      // En una pestaña nueva: si estás a media configuración de
                      // una clonación, salir de la página la perdería.
                      <a href={app.href} target="_blank" rel="noreferrer noopener" />
                    }
                    className="flex items-center gap-2"
                  >
                    <app.icon className="h-4 w-4" />
                    <span>{app.label}</span>
                    <ExternalLink className="ml-auto h-3 w-3 text-muted-foreground" />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{userName ?? userEmail}</p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              {role === "OWNER" && <ShieldCheck className="h-3 w-3" />}
              {ROLE_LABEL[role]}
            </p>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="text-muted-foreground transition-colors hover:text-foreground"
            title="Cerrar sesión"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
