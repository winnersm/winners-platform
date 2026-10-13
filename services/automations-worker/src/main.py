"""
Worker de tareas automáticas.

Cambio de fondo respecto a la versión anterior: el horario, el on/off de cada
tarea, el alcance de cuentas y el modo prueba se leen de la base. Antes los
cron estaban escritos aquí y el `enabled` por tarea no se consultaba, así que
el panel enseñaba unos valores y el worker hacía otra cosa.

La configuración se relee cada minuto: un cambio hecho en la pantalla surte
efecto sin reiniciar nada.
"""

import logging
import signal
import sys
import threading
import time
from datetime import datetime, timezone

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from . import billing_check
from . import update_sheet
from . import meta_autopause
from . import meta_cleanup
from . import tasks as task_store

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("/app/logs/automations.log"),
    ],
)
log = logging.getLogger(__name__)

# Cada runner recibe su Task: de ahí saca el alcance de cuentas y si va en modo
# prueba. Ninguno decide por su cuenta sobre qué cuentas actúa.
RUNNERS = {
    "billing_check": lambda t: billing_check.run(task=t),
    "live_tracker": lambda t: update_sheet.run_intraday(task=t),
    "update_sheet_daily": lambda t: update_sheet.run_daily(task=t),
    "meta_autopause": lambda t: meta_autopause.run(task=t, execute=not t.dry_run),
    "meta_disapproved_cleanup": lambda t: meta_cleanup.run(task=t, dry_run=t.dry_run),
}

# Último valor leído con éxito del interruptor general. Si la base no responde
# se reutiliza: apagado sigue apagado aunque falle la lectura.
_last_known_master = True


def _master_on() -> bool:
    global _last_known_master
    try:
        _last_known_master = task_store.automations_enabled()
    except Exception as e:
        log.error(
            "No se pudo leer el interruptor general (%s) — se mantiene el último estado: %s",
            e, "ON" if _last_known_master else "OFF",
        )
    return _last_known_master


def execute(name: str, triggered_by: str = "scheduler") -> None:
    """Ejecuta una tarea, comprobando antes que deba ejecutarse."""
    started = datetime.now(timezone.utc)

    try:
        task = task_store.load_task(name)
    except Exception as e:
        log.exception("%s: no se pudo leer su configuración: %s", name, e)
        return

    if task is None:
        log.error("%s: no existe en la base", name)
        return

    # El disparo manual desde el panel se ejecuta aunque la tarea esté
    # desactivada: si alguien pulsa el botón, la quiere ahora.
    if triggered_by == "scheduler":
        if not _master_on():
            log.info("%s omitida — interruptor general apagado", name)
            return
        if not task.enabled:
            log.info("%s omitida — desactivada", name)
            return

    runner = RUNNERS.get(name)
    if runner is None:
        log.error("%s: sin runner asociado", name)
        return

    modo = " [MODO PRUEBA]" if task.dry_run else ""
    log.info("%s: empieza (%s)%s", name, triggered_by, modo)

    try:
        result = runner(task)
        task_store.save_run(
            name, started, datetime.now(timezone.utc), True,
            result=result if isinstance(result, dict) else None,
            triggered_by=triggered_by, dry_run=task.dry_run,
        )
        task_store.mark_last_run(name)
        log.info("%s: terminada%s", name, modo)
    except Exception as e:
        log.exception("%s ERROR: %s", name, e)
        try:
            task_store.save_run(
                name, started, datetime.now(timezone.utc), False,
                error_msg=str(e), triggered_by=triggered_by, dry_run=task.dry_run,
            )
        except Exception:
            log.exception("%s: además falló al registrar el error", name)


def sync_schedule(scheduler: BackgroundScheduler) -> None:
    """
    Alinea el planificador con lo que dice la base.

    Se llama cada minuto: cambiar un horario en el panel se aplica solo, sin
    reiniciar el worker.
    """
    try:
        tasks = task_store.load_tasks()
    except Exception as e:
        log.error("No se pudo leer la configuración de tareas: %s", e)
        return

    for name, task in tasks.items():
        if name not in RUNNERS:
            log.warning("%s está en la base pero no tiene runner — se ignora", name)
            continue

        existing = scheduler.get_job(name)

        if not task.enabled:
            if existing:
                scheduler.remove_job(name)
                log.info("%s: retirada del planificador (desactivada)", name)
            continue

        try:
            trigger = CronTrigger.from_crontab(task.cron, timezone=task.timezone)
        except Exception as e:
            log.error("%s: horario inválido (%r): %s", name, task.cron, e)
            continue

        # APScheduler no compara triggers entre sí, así que se compara su texto.
        if existing and str(existing.trigger) == str(trigger):
            continue

        scheduler.add_job(
            execute, trigger, args=[name], id=name,
            max_instances=1, coalesce=True, replace_existing=True,
        )
        log.info("%s: programada (%s, %s)", name, task.cron, task.timezone)

    # Tareas que ya no existen en la base
    for job in scheduler.get_jobs():
        if job.id.startswith("__"):
            continue
        if job.id not in tasks:
            scheduler.remove_job(job.id)
            log.info("%s: retirada (ya no está en la base)", job.id)


def poll_triggers() -> None:
    """Recoge las ejecuciones manuales pedidas desde el panel."""
    try:
        names = task_store.take_pending_triggers()
    except Exception as e:
        log.error("No se pudieron leer las ejecuciones pendientes: %s", e)
        return

    for name in names:
        log.info("%s: ejecución manual pedida desde el panel", name)
        threading.Thread(
            target=execute, args=(name, "manual"), daemon=True, name=f"manual-{name}"
        ).start()


def main() -> None:
    log.info("Arrancando el worker de automatizaciones")

    scheduler = BackgroundScheduler()
    scheduler.start()

    # Releer configuración y recoger disparos manuales, cada minuto.
    scheduler.add_job(
        sync_schedule, CronTrigger.from_crontab("* * * * *"),
        args=[scheduler], id="__sync__", max_instances=1, coalesce=True,
    )
    scheduler.add_job(
        poll_triggers, CronTrigger.from_crontab("* * * * *"),
        id="__triggers__", max_instances=1, coalesce=True,
    )

    sync_schedule(scheduler)

    programadas = [j.id for j in scheduler.get_jobs() if not j.id.startswith("__")]
    log.info("Tareas programadas: %s", ", ".join(programadas) or "ninguna")

    def _shutdown(sig, frame):
        log.info("Señal recibida — apagando")
        scheduler.shutdown(wait=False)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
