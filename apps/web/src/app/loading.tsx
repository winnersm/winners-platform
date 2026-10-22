export default function Loading() {
  return (
    <main className="min-h-screen bg-background p-5" aria-busy="true" aria-label="Cargando Winners Platform">
      <div className="mx-auto w-full max-w-7xl space-y-5">
        <div className="h-12 animate-pulse rounded-lg bg-muted" />
        <div className="space-y-2">
          <div className="h-7 w-48 animate-pulse rounded bg-muted" />
          <div className="h-4 w-64 animate-pulse rounded bg-muted" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl border bg-muted/60" />
          ))}
        </div>
        <div className="space-y-2 rounded-lg border p-4">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-muted/60" />
          ))}
        </div>
      </div>
    </main>
  );
}
