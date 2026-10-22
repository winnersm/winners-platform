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
  type LucideIcon,
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

const GROUP_ACCENT: Record<string, { text: string; activeBg: string; glow: string; gradient: string }> = {
  META: { text: "text-blue-500 dark:text-blue-400", activeBg: "bg-blue-500/15 dark:bg-blue-400/15", glow: "0 0 12px rgba(59,130,246,0.4)", gradient: "from-blue-500 to-blue-400" },
  AUTOMATIONS: { text: "text-amber-500 dark:text-amber-400", activeBg: "bg-amber-500/15 dark:bg-amber-400/15", glow: "0 0 12px rgba(245,158,11,0.4)", gradient: "from-amber-500 to-amber-400" },
  LINKS: { text: "text-emerald-500 dark:text-emerald-400", activeBg: "bg-emerald-500/15 dark:bg-emerald-400/15", glow: "0 0 12px rgba(16,185,129,0.4)", gradient: "from-emerald-500 to-emerald-400" },
  MONITOR: { text: "text-violet-500 dark:text-violet-400", activeBg: "bg-violet-500/15 dark:bg-violet-400/15", glow: "0 0 12px rgba(139,92,246,0.4)", gradient: "from-violet-500 to-violet-400" },
  CLONER: { text: "text-pink-500 dark:text-pink-400", activeBg: "bg-pink-500/15 dark:bg-pink-400/15", glow: "0 0 12px rgba(236,72,153,0.4)", gradient: "from-pink-500 to-pink-400" },
  ADMIN: { text: "text-slate-500 dark:text-slate-400", activeBg: "bg-slate-500/15 dark:bg-slate-400/15", glow: "0 0 12px rgba(100,116,139,0.35)", gradient: "from-slate-500 to-slate-400" },
};

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
      <SidebarHeader className="border-b border-sidebar-border px-4 py-4">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 flex items-center justify-center shadow-sm">
            <Zap className="h-4 w-4 text-white" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight">Winners</span>
            <span className="block text-[10px] text-muted-foreground leading-none mt-0.5">Platform</span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => {
          const accentObj = GROUP_ACCENT[group.module] ?? { text: "text-muted-foreground", activeBg: "bg-muted/60" };
          const accent = accentObj.text;
          return (
            <SidebarGroup key={group.module}>
              <SidebarGroupLabel className="text-[10px] uppercase tracking-widest font-semibold opacity-60">
                {group.label}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => {
                    const active =
                      pathname === item.href ||
                      (item.href !== "/automations" &&
                        item.href !== "/links" &&
                        item.href !== "/cloner" &&
                        pathname.startsWith(`${item.href}/`));
                    return (
                      <SidebarMenuItem key={item.href} className="relative">
                        {active && (
                          <div className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-full bg-gradient-to-b ${accentObj.gradient}`} />
                        )}
                        <SidebarMenuButton
                          render={<Link href={item.href} />}
                          isActive={active}
                          className="flex items-center gap-2.5 transition-all duration-150"
                        >
                          <div
                            className={`h-6 w-6 rounded-md flex items-center justify-center transition-all ${active ? accentObj.activeBg : "bg-muted/60 dark:bg-white/[0.06]"}`}
                            style={active ? { boxShadow: accentObj.glow } : undefined}
                          >
                            <item.icon className={`h-3.5 w-3.5 ${accent}`} />
                          </div>
                          <span className={active ? "font-medium" : ""}>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}

        <SidebarGroup>
          <SidebarGroupLabel className="text-[10px] uppercase tracking-widest font-semibold opacity-60">
            Otras apps
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {APPS_EXTERNAS.map((app) => (
                <SidebarMenuItem key={app.href}>
                  <SidebarMenuButton
                    render={<a href={app.href} target="_blank" rel="noreferrer noopener" />}
                    className="flex items-center gap-2.5"
                  >
                    <div className="h-6 w-6 rounded-md bg-muted/60 dark:bg-white/[0.06] flex items-center justify-center">
                      <app.icon className="h-3.5 w-3.5 text-pink-500 dark:text-pink-400" />
                    </div>
                    <span>{app.label}</span>
                    <ExternalLink className="ml-auto h-3 w-3 text-muted-foreground/50" />
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-8 w-8 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 dark:from-primary/30 dark:to-primary/10 flex items-center justify-center shrink-0">
              <span className="text-xs font-bold text-primary">{(userName ?? userEmail ?? "U")[0].toUpperCase()}</span>
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{userName ?? userEmail}</p>
              <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                {role === "OWNER" && <ShieldCheck className="h-2.5 w-2.5" />}
                {ROLE_LABEL[role]}
              </p>
            </div>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground transition-colors hover:text-foreground hover:bg-muted/80"
            title="Cerrar sesión"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
