"use client";

import Link from "next/link";
import { KeyRound, Users, ArrowRight } from "lucide-react";
import { SettingsClient } from "./settings-client";

interface BM {
  id: string;
  name: string;
  bmIdMeta: string;
  systemUserId: string;
  status: string;
  updatedAt: Date;
}

/**
 * La gestión de usuarios ya no vive aquí: ahora es transversal a toda la
 * plataforma y está en /admin/users. Dejar dos sitios donde dar de alta a
 * alguien es justo el problema que esta consolidación viene a resolver.
 */
export function SettingsTabs({ initialBMs }: { initialBMs: BM[] }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 border-b pb-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Business Managers</h2>
      </div>

      <SettingsClient initialBMs={initialBMs} />

      <Link
        href="/admin/users"
        className="flex items-center justify-between rounded-lg border bg-card p-4 transition-colors hover:bg-muted/50"
      >
        <div className="flex items-center gap-3">
          <Users className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Usuarios y permisos</p>
            <p className="text-xs text-muted-foreground">
              Se gestionan para toda la plataforma, no solo para Meta Ads
            </p>
          </div>
        </div>
        <ArrowRight className="h-4 w-4 text-muted-foreground" />
      </Link>
    </div>
  );
}
