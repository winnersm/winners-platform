import type { ReactNode } from "react";

/**
 * Cabecera única para todas las páginas. Existe para que no aparezcan cinco
 * formas distintas de titular una pantalla según quién la escribió.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Marcador para módulos cuya migración aún no ha llegado. Dice la verdad sobre
 * dónde está hoy la funcionalidad, en vez de mostrar una pantalla vacía que
 * parece rota.
 */
export function ModulePlaceholder({
  title,
  description,
  currentUrl,
  step,
}: {
  title: string;
  description: string;
  currentUrl?: string;
  step: string;
}) {
  return (
    <div>
      <PageHeader title={title} description={description} />
      <div className="rounded-lg border border-dashed bg-card p-8 text-center">
        <p className="text-sm font-medium">Este módulo se migra en el {step}</p>
        {currentUrl && (
          <p className="mt-2 text-sm text-muted-foreground">
            Mientras tanto sigue funcionando en{" "}
            <a
              href={`https://${currentUrl}`}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-4"
            >
              {currentUrl}
            </a>
          </p>
        )}
      </div>
    </div>
  );
}
