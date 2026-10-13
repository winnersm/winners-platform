# Motor de clonado

Copia una campaña completa —campaña, adsets y anuncios— de una cuenta
publicitaria a otra, incluso entre Business Managers distintos. Todo lo que crea
queda en **PAUSED**.

Viene de `opwinners`, una aplicación que vivía en el escritorio con su propio
servidor web y un SQLite al lado. Aquí queda solo el motor: la interfaz la sirve
la app única, en `/cloner`.

## Por qué sigue siendo Python

`clonado.py` son mil doscientas líneas de conocimiento de la Graph API que solo
se aprende a base de golpes: vídeos crossposteados que no exponen `source`,
cuentas de Instagram respaldadas por la página, `asset_feed_spec` con etiquetas
compartidas entre idiomas, campos que Meta devuelve pero rechaza al crear,
fechas de inicio vencidas que hacen arrancar un adset a media jornada.

Reescribirlo en TypeScript habría sido reescribir esos errores desde cero, sobre
campañas con gasto real. El motor no se ha tocado; lo que se cambió es dónde
guarda las cosas y quién le habla.

## Qué cambió respecto a opwinners

| Antes | Ahora |
|---|---|
| Escuchaba en `localhost:8760` y abría el navegador | Vive en `winners-net`, sin puerto publicado ni Traefik |
| Cualquiera en la máquina podía llamarlo | Cada petición trae `X-Engine-Token` |
| Tokens de Meta en texto plano en `datos.db` | Cifrados (AES-256-GCM) en `cloner.CloneToken` |
| Plantillas e historial en SQLite local | Postgres, schema `cloner` |
| Los trabajos vivían en un `dict` en memoria | En la base: sobreviven a un reinicio |
| Servía su propio HTML | Sin interfaz: la sirve la app |

## Estructura

```
src/
  api.py        servidor HTTP interno (era servidor.py)
  store.py      Postgres (era almacen.py + plantillas.py)
  clonado.py    el motor. Sin cambios salvo los imports
  idiomas.py    lectura y edición del contenido por idioma. Sin cambios
  campos.py     qué campos se piden y cuáles no se copian. Sin cambios
  fbapi.py      cliente del Graph API con reintentos. Sin cambios
```

## Variables

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Postgres de la plataforma |
| `ENCRYPTION_KEY` | Hex de 64 caracteres. **La misma** que usa la app: si difieren, los tokens guardados dejan de descifrarse |
| `CLONER_ENGINE_TOKEN` | Secreto compartido con la app. Sin él el motor no arranca |
| `CLONER_PORT` | 8760 por defecto |
| `GRAPH_VERSION` | `v23.0` por defecto |

## ffmpeg

Es obligatorio y va en la imagen. Cada vídeo se limpia de metadatos
(`-map_metadata -1 -c copy`, sin recodificar) antes de subirlo a la cuenta
destino: si no, el archivo llega a Meta con el software de edición, las fechas y
a veces el nombre del proyecto.

Si ffmpeg no puede con un formato concreto, el vídeo se sube igual sin limpiar y
la interfaz lo dice. Quedarse sin subir sería peor que quedarse sin quitar unos
metadatos.

## Aislamiento entre cuentas

Cada cuenta destino recibe **su propia copia** de cada vídeo e imagen. Nunca se
comparte un asset ni se reutiliza el post publicado del origen.

El motivo es práctico: mientras dos anuncios cuelgan del mismo `video_id` o del
mismo post, para Meta son el mismo objeto, y un rechazo en la primera cuenta se
propaga a las demás. Con copias independientes, cada cuenta se revisa aparte.

El precio es que se pierden los likes y comentarios acumulados. Y si el rechazo
fue por el contenido, la copia vuelve a caer por lo mismo: esto aísla el
historial del objeto, no cambia lo que Meta ve al revisar.

## Probarlo en local

```bash
docker run -d --name pg-prueba -e POSTGRES_PASSWORD=x -p 5499:5432 postgres:16-alpine
cd ../../packages/db && DATABASE_URL=postgresql://postgres:x@localhost:5499/postgres \
  npx prisma migrate deploy

cd ../../services/cloner-engine
pip install -r requirements.txt
DATABASE_URL=postgresql://postgres:x@localhost:5499/postgres \
  ENCRYPTION_KEY=$(openssl rand -hex 32) \
  CLONER_ENGINE_TOKEN=loquesea \
  python -m src.api
```

`GET /salud` responde sin token; todo lo demás lo exige.
