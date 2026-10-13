"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Trash2, CheckCircle2, XCircle, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useConfirm } from "@/components/use-confirm";
import { get, post, type TokenInfo } from "../api";
import { useDatos } from "../use-datos";

/**
 * Tokens de usuario de Meta, con alias.
 *
 * Son tokens de usuario, no de system user: el clonador necesita llegar a
 * `me/accounts` y a las páginas para poder resolver los vídeos crossposteados,
 * y un token de system user no las ve. Por eso viven aquí y no en los Business
 * Managers del módulo Meta.
 */
export function TokensView({ puedeEscribir }: { puedeEscribir: boolean }) {
  const [alias, setAlias] = useState("");
  const [token, setToken] = useState("");
  const [guardando, setGuardando] = useState(false);
  const { confirmar, dialogo } = useConfirm();

  const { datos, cargando, recargar } = useDatos(
    () => get<{ tokens: TokenInfo[] }>("tokens"),
    { tokens: [] as TokenInfo[] },
  );
  const tokens = datos.tokens;

  async function guardar() {
    if (!alias.trim() || !token.trim()) {
      toast.error("Hacen falta el alias y el token");
      return;
    }
    setGuardando(true);
    try {
      const r = await post<{ valido: boolean; usuario?: string; error?: string }>("tokens", {
        alias: alias.trim(),
        token: token.trim(),
      });
      setAlias("");
      setToken("");
      if (r.valido) toast.success(`Guardado y validado como ${r.usuario}`);
      else toast.error(`Guardado, pero Meta lo rechaza: ${r.error}`);
      recargar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setGuardando(false);
    }
  }

  async function borrar(t: TokenInfo) {
    const ok = await confirmar({
      title: `¿Borrar el token «${t.alias}»?`,
      description:
        "Las plantillas y el historial se conservan, pero dejarás de poder clonar con este token hasta que lo vuelvas a añadir.",
      detail: t.usuario ? `Pertenece a ${t.usuario}` : undefined,
      confirmLabel: "Borrar",
      destructive: true,
    });
    if (!ok) return;
    try {
      await post("tokens/borrar", {}, { alias: t.alias });
      toast.success("Token borrado");
      recargar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo borrar");
    }
  }

  return (
    <div className="space-y-6">
      {puedeEscribir && (
        <section className="rounded-lg border bg-card p-5">
          <h2 className="text-base font-medium">Añadir un token</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Necesita permiso <code>ads_management</code> sobre las cuentas que vayas a
            usar. Al guardarlo se valida contra Meta al momento.
          </p>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <div className="w-56 space-y-1.5">
              <Label htmlFor="alias">Alias</Label>
              <Input
                id="alias"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder="BM Operaciones"
              />
            </div>
            <div className="min-w-64 flex-1 space-y-1.5">
              <Label htmlFor="token">Token</Label>
              <Input
                id="token"
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="EAA…"
                className="font-mono text-xs"
                autoComplete="off"
              />
            </div>
            <Button onClick={guardar} disabled={guardando}>
              {guardando ? "Validando…" : "Guardar y validar"}
            </Button>
          </div>
        </section>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-medium">Tokens guardados</h2>
          <Button size="sm" variant="ghost" onClick={recargar} disabled={cargando}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Actualizar
          </Button>
        </div>

        {cargando && !tokens.length ? (
          <p className="text-sm text-muted-foreground">Cargando…</p>
        ) : tokens.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            Todavía no hay tokens guardados.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Alias</TableHead>
                  <TableHead>Usuario</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>Estado</TableHead>
                  {puedeEscribir && <TableHead className="w-12" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((t) => (
                  <TableRow key={t.alias}>
                    <TableCell className="font-medium">{t.alias}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {t.usuario || "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {t.token_pista}
                    </TableCell>
                    <TableCell>
                      {t.valido ? (
                        <Badge variant="secondary" className="gap-1">
                          <CheckCircle2 className="h-3 w-3 text-green-600" />
                          válido
                        </Badge>
                      ) : (
                        <div className="space-y-1">
                          <Badge variant="destructive" className="gap-1">
                            <XCircle className="h-3 w-3" />
                            no válido
                          </Badge>
                          {t.error && (
                            <p
                              className="max-w-72 truncate text-xs text-muted-foreground"
                              title={t.error}
                            >
                              {t.error}
                            </p>
                          )}
                        </div>
                      )}
                    </TableCell>
                    {puedeEscribir && (
                      <TableCell>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Borrar"
                          onClick={() => borrar(t)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {dialogo}
    </div>
  );
}
