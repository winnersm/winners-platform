import { notesBus, notesContext } from "@/lib/account-notes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Canal en vivo (SSE) con los cambios de notas de la operación activa.
export async function GET(req: Request) {
  const ctx = await notesContext();
  if (!ctx.ok) return ctx.res;

  const bus = notesBus();
  const evt = `op:${ctx.operationId}`;
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(chunk)); } catch { cleanup(); }
      };
      const onMessage = (msg: string) => send(`data: ${msg}\n\n`);
      // Comentario cada 25 s: mantiene viva la conexión a través de Traefik.
      const ping = setInterval(() => send(": ping\n\n"), 25_000);
      bus.on(evt, onMessage);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        bus.off(evt, onMessage);
        try { controller.close(); } catch {}
      };
      req.signal.addEventListener("abort", () => cleanup());
      send("retry: 5000\n: conectado\n\n");
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
