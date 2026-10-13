"use client";

import { useState } from "react";
import { Wand2, List, Bookmark } from "lucide-react";
import { cn } from "@/lib/utils";
import { Generator } from "./generator";
import { LinksTable } from "./links-table";
import { FunnelUrls } from "./funnel-urls";

interface Props {
  canEdit: boolean;
  domains: { id: string; host: string; active: boolean }[];
  funnelUrls: { id: string; name: string; urlTemplate: string }[];
  links: Parameters<typeof LinksTable>[0]["links"];
}

type Pestana = "generar" | "enlaces" | "urls";

export function LinksTabs({ canEdit, domains, funnelUrls, links }: Props) {
  // Se abre en "Generar": es a lo que se viene a esta pantalla la mayoría de
  // las veces. La lista está a un clic.
  const [tab, setTab] = useState<Pestana>(canEdit ? "generar" : "enlaces");

  const pestanas: { key: Pestana; label: string; icon: typeof Wand2; solo?: boolean }[] = [
    { key: "generar", label: "Generar", icon: Wand2, solo: true },
    { key: "enlaces", label: `Enlaces (${links.length})`, icon: List },
    { key: "urls", label: `URLs guardadas (${funnelUrls.length})`, icon: Bookmark, solo: true },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b">
        {pestanas
          .filter((p) => !p.solo || canEdit)
          .map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                tab === key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
      </div>

      {tab === "generar" && canEdit && <Generator domains={domains} funnelUrls={funnelUrls} />}
      {tab === "enlaces" && <LinksTable links={links} canEdit={canEdit} />}
      {tab === "urls" && canEdit && <FunnelUrls urls={funnelUrls} />}
    </div>
  );
}
