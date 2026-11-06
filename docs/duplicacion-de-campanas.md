# Duplicación de campañas

Describo cómo se duplica una campaña de Meta: desde la petición HTTP hasta las llamadas a la Graph API (`v21.0`), cómo se reparte el trabajo y qué devuelve Meta en cada paso.

Archivos que intervienen:

| Archivo | Papel |
| --- | --- |
| `apps/web/src/app/api/meta/duplicate/campaign/route.ts` | Recibe la petición, valida y encola un trabajo por copia |
| `apps/web/src/lib/copy-name.ts` | Genera el nombre de cada copia |
| `apps/web/worker/index.ts` | Toma los trabajos de la cola, controla concurrencia, cuota y reanudación |
| `apps/web/src/lib/meta-api.ts` | `duplicateCampaign` y las funciones que hablan con Meta |
| `apps/web/src/lib/meta-errors.ts` | `MetaApiError`: errores de Meta con mensaje claro y detalle técnico |

---

## 1. Petición

`POST /api/meta/duplicate/campaign`

```json
{
  "accountId": "1234567890",
  "bmId": "cmabc123",
  "status": "ACTIVE",
  "count": 10,
  "startAt": 1,
  "items": [
    { "campaignId": "120210000000000001", "name": "Campaña Verano {numero}" }
  ]
}
```

- `items` admite varias campañas. El formato antiguo (`campaignId` + `name` sueltos) se convierte en un único elemento de `items`.
- `count` es el número de copias por campaña (1 a 50). `startAt` es el número de la primera copia.
- El total de trabajos es `items.length × count` y no puede pasar de 100 por petición.
- `status` es el estado final que tendrá la campaña copiada. La copia siempre se crea en pausa y se activa al final si se pidió `ACTIVE`.

El nombre de cada copia sale de `renderCopyName(plantilla, startAt + i)`, que sustituye `{numero}` por el número de la copia. Con `startAt: 1` y `count: 3`, la plantilla `Campaña Verano {numero}` produce `Campaña Verano 1`, `Campaña Verano 2` y `Campaña Verano 3`.

Respuesta:

```json
{
  "jobIds": ["cm1...", "cm2...", "cm3..."],
  "queued": 10,
  "batchId": "7f3c2b1e-6a52-4a39-9d0c-0d1f6a1e4c11"
}
```

## 2. Tanda y trabajos

Una petición es una tanda (`batchId`). Cada copia es un trabajo independiente: una fila `MetaJob` en la base de datos (`type: DUPLICATE_CAMPAIGN`, `status: pending`) y un job en la cola BullMQ `duplications` con `attempts: 1`. Si una copia falla, las demás siguen.

Datos que lleva cada trabajo:

```json
{
  "jobId": "cm1...",
  "campaignId": "120210000000000001",
  "accountId": "1234567890",
  "name": "Campaña Verano 1",
  "baseName": "Campaña Verano",
  "status": "ACTIVE",
  "bmId": "cmabc123",
  "operationId": "op_1",
  "batchId": "7f3c2b1e-6a52-4a39-9d0c-0d1f6a1e4c11",
  "seq": 1,
  "total": 10
}
```

Antes de encolar, la ruta borra de Redis la lectura guardada de cada campaña origen (`meta:dup-source:<campaignId>`). Así, la primera copia de la tanda que se ejecute lee la configuración actual de Meta y las demás reutilizan esa lectura (ver sección 5).

## 3. Worker

El worker de `duplications` ejecuta hasta 5 trabajos a la vez (`WORKER_CONCURRENCY`), con un máximo de 2 por cuenta publicitaria (`PER_ACCOUNT_MAX`). Al tomar un trabajo:

1. Si el trabajo ya no existe en la base de datos o está `cancelled`, se descarta.
2. Si la cuenta está en enfriamiento (`meta:cooldown:acct:<cuenta>` en Redis), el trabajo se reprograma con `moveToDelayed` para después del enfriamiento, y queda `pending` con `output.waiting = { reason, until }`.
3. Si la cuenta ya tiene 2 trabajos en curso, se reprograma 15 segundos más tarde (más `seq × 200 ms` para escalonar). No espera dentro del worker.
4. Si hay cupo, pasa a `processing` y ejecuta `duplicateCampaign`.

Un trabajo cancelado se detecta entre fases con `checkCancelled`, que lee el estado de la fila.

## 4. Fases de `duplicateCampaign`

### Fase 1: crear la copia (en pausa)

```
POST https://graph.facebook.com/v21.0/{campaignId}/copies
Content-Type: application/x-www-form-urlencoded

access_token=...&name=Campa%C3%B1a+Verano+1&status_option=PAUSED
```

Respuesta de Meta:

```json
{
  "copied_campaign_id": "120210000000000099"
}
```

El id se guarda en `MetaJob.output.newCampaignId` como punto de control (`onCheckpoint`). Si el trabajo se interrumpe después de este punto, la reanudación continúa sobre esa campaña sin crear otra.

### Fase 2: leer la configuración de los ad sets originales

Primero se listan los ad sets de la campaña origen:

```
GET /{campaignId}/adsets?fields=id&limit=200
```

```json
{
  "data": [
    { "id": "120210000000000011" },
    { "id": "120210000000000012" }
  ],
  "paging": { "cursors": { "before": "QVFI...", "after": "QVFI..." } }
}
```

Después se lee la configuración completa de cada uno con la Batch API (hasta 50 sub-peticiones por llamada HTTP):

```
POST https://graph.facebook.com/v21.0/
access_token=...&batch=[
  {"method":"GET","relative_url":"120210000000000011?fields=name,status,daily_budget,lifetime_budget,bid_amount,bid_strategy,bid_constraints,billing_event,optimization_goal,targeting,promoted_object,pacing_type,destination_type,attribution_spec,start_time,end_time,ads.limit(100){name,status,creative{id}}"},
  {"method":"GET","relative_url":"120210000000000012?fields=..."}
]
```

La respuesta es un arreglo con un elemento por sub-petición. El `body` de cada uno llega como texto JSON y se parsea:

```json
[
  {
    "code": 200,
    "headers": [{ "name": "Content-Type", "value": "application/json; charset=UTF-8" }],
    "body": "{\"name\":\"Conjunto A\",\"status\":\"ACTIVE\",\"daily_budget\":\"2000\",\"bid_strategy\":\"LOWEST_COST_WITHOUT_CAP\",\"billing_event\":\"IMPRESSIONS\",\"optimization_goal\":\"OFFSITE_CONVERSIONS\",\"destination_type\":\"WEBSITE\",\"pacing_type\":[\"standard\"],\"targeting\":{\"age_min\":25,\"age_max\":55,\"geo_locations\":{\"countries\":[\"CO\"],\"location_types\":[\"home\",\"recent\"]},\"publisher_platforms\":[\"facebook\",\"instagram\"],\"instagram_positions\":[\"stream\",\"explore_home\"]},\"promoted_object\":{\"pixel_id\":\"9876543210\",\"custom_event_type\":\"PURCHASE\",\"smart_pse_enabled\":false},\"start_time\":\"2026-11-01T00:00:00-0500\",\"ads\":{\"data\":[{\"name\":\"Anuncio 1\",\"status\":\"ACTIVE\",\"creative\":{\"id\":\"120210000000000501\"},\"id\":\"120210000000000401\"}],\"paging\":{\"cursors\":{\"before\":\"MAZDZD\",\"after\":\"MAZDZD\"}}},\"id\":\"120210000000000011\"}"
  }
]
```

Con cada respuesta se arma una especificación (`AdsetSpec`):

- Se conservan solo los anuncios con estado `ACTIVE` o `PAUSED` y con `creative.id`. Los archivados y borrados se omiten.
- Un ad set sin ningún anuncio con creativo se omite y se registra como incidencia.
- Si `ads.paging.next` existe, hay más de 100 anuncios: se copian los primeros 100 y se registra una incidencia.
- La configuración pasa por `buildAdsetPayload`, que:
  - elimina `id`, `account_id`, `created_time`, `updated_time`, `campaign_id`, `name`, `effective_status` y `ads`;
  - quita `destination_type` si vale `UNDEFINED`;
  - quita `daily_budget` y `lifetime_budget` si valen `0` (el presupuesto está en la campaña);
  - quita `targeting.age_range` y `promoted_object.smart_pse_enabled`;
  - agrega `explore` a `targeting.instagram_positions` cuando solo está `explore_home`;
  - serializa a texto JSON los valores que son objetos y descarta los `null`.

Resultado de la lectura (forma que se guarda en Redis):

```json
{
  "adsetCount": 2,
  "specs": [
    {
      "origId": "120210000000000011",
      "adsetName": "Conjunto A",
      "payload": {
        "status": "ACTIVE",
        "daily_budget": "2000",
        "bid_strategy": "LOWEST_COST_WITHOUT_CAP",
        "billing_event": "IMPRESSIONS",
        "optimization_goal": "OFFSITE_CONVERSIONS",
        "pacing_type": "[\"standard\"]",
        "targeting": "{\"age_min\":25,\"age_max\":55,\"geo_locations\":{\"countries\":[\"CO\"]}}",
        "promoted_object": "{\"pixel_id\":\"9876543210\",\"custom_event_type\":\"PURCHASE\"}",
        "start_time": "2026-11-01T00:00:00-0500"
      },
      "ads": [
        { "name": "Anuncio 1", "creativeId": "120210000000000501", "status": "ACTIVE" }
      ]
    }
  ],
  "issues": []
}
```

### Fase 3: crear los ad sets en la copia

Los ad sets se crean desde cero con `POST act_{cuenta}/adsets`, no con `/copies`. Van en batches de 2 sub-peticiones. Cada una lleva el `payload` de la especificación más `campaign_id` (la campaña nueva), `name` (el del original) y `status=ACTIVE`:

```
POST https://graph.facebook.com/v21.0/
access_token=...&batch=[
  {"method":"POST","relative_url":"act_1234567890/adsets","body":"status=ACTIVE&daily_budget=2000&...&campaign_id=120210000000000099&name=Conjunto+A"},
  {"method":"POST","relative_url":"act_1234567890/adsets","body":"..."}
]
```

```json
[
  { "code": 200, "body": "{\"id\":\"120210000000000111\"}" },
  { "code": 200, "body": "{\"id\":\"120210000000000112\"}" }
]
```

Reintentos de esta fase:

- Hasta 6 rondas. Entre rondas hay una pausa de 5 segundos.
- Se reintentan los errores transitorios y el código `960` (Meta aborta el batch por culpa de otro sub-request).
- Los errores no reintentables se registran como incidencia con el nombre del ad set y su id de origen.
- Un error de permisos o token detiene la fase.
- Al pasar las 6 rondas, lo que sigue sin crearse se registra como incidencia con su último error.

### Fase 4: crear los anuncios

Cada anuncio nuevo reutiliza el `creative_id` del original, por lo que conserva la publicación y la prueba social. Se crean en batches de 2:

```
POST https://graph.facebook.com/v21.0/
access_token=...&batch=[
  {"method":"POST","relative_url":"act_1234567890/ads","body":"name=Anuncio+1&adset_id=120210000000000111&creative%5Bcreative_id%5D=120210000000000501&status=ACTIVE"},
  {"method":"POST","relative_url":"act_1234567890/ads","body":"..."}
]
```

```json
[
  { "code": 200, "body": "{\"id\":\"120210000000000601\"}" },
  { "code": 200, "body": "{\"id\":\"120210000000000602\"}" }
]
```

Tras copiar una campaña, el creativo puede tardar unos minutos en estar disponible en el CDN de Meta. Durante ese tiempo la creación falla con errores transitorios:

```json
{
  "error": {
    "message": "Image Wasn't Downloaded",
    "type": "OAuthException",
    "code": 100,
    "error_subcode": 1487833,
    "fbtrace_id": "A1b2C3d4E5f"
  }
}
```

Se consideran transitorios: HTTP 5xx o sub-request sin respuesta, `code 1`, `code 2`, `code 17` y `code 100` con subcódigo `1487833`. Los anuncios que fallan así pasan a la ronda siguiente, hasta 20 rondas. La espera entre rondas es adaptativa: 25 s si la ronda creó anuncios y hasta 75 s si salió vacía.

Antes de reintentar, un batch GET consulta qué anuncios existen ya en cada ad set (`GET {adsetId}/ads?fields=name&limit=200`). Los que ya existen se cuentan como creados y no se vuelven a crear, de modo que un falso fallo no produce anuncios duplicados.

Un error fatal detiene el trabajo de inmediato con un mensaje explicado (`FatalAdError`):

- `code 190`: token inválido o caducado.
- `code 10` o `200`: sin permiso de escritura.
- `error_subcode 1885499`: sin permiso de anunciante en la página.

### Fase 5: activar

Si `status` era `ACTIVE`, se activa la campaña copiada:

```
POST /{newCampaignId}
access_token=...&status=ACTIVE
```

```json
{ "success": true }
```

Si esta llamada falla, la copia queda creada y pausada, y se agrega una incidencia con `step: "status"`.

### Resultado

El trabajo termina en `completed` y `MetaJob.output` guarda:

```json
{
  "newCampaignId": "120210000000000099",
  "adsetsCount": 2,
  "adsCount": 5,
  "adsetsExpected": 2,
  "adsExpected": 5,
  "resumed": false
}
```

Cuando algo no salió, se agrega `issues`:

```json
{
  "issues": [
    {
      "step": "ad",
      "name": "Anuncio 3",
      "sourceId": "120210000000000011",
      "error": {
        "kind": "validation",
        "title": "Meta rechazó el anuncio",
        "message": "...",
        "action": "...",
        "detail": {
          "code": 100,
          "subcode": 1487833,
          "fbtraceId": "A1b2C3d4E5f",
          "endpoint": "POST act_1234567890/ads",
          "httpStatus": 400,
          "attempts": 1
        }
      }
    }
  ]
}
```

## 5. Lectura guardada de la campaña origen

La configuración de la campaña origen (resultado de la fase 2) se guarda en Redis en `meta:dup-source:<campaignId>` con una caducidad de 1800 segundos (30 minutos). `readCampaignSource` hace:

1. Busca la clave. Si existe, la devuelve sin llamar a Meta.
2. Si no existe, hace el `GET {campaignId}/adsets` y los batch GET de los ad sets, y guarda el resultado con `SETEX` (30 minutos).

Redis elimina la clave solo al cumplirse la caducidad; no hay ninguna lectura programada que la refresque.

La ruta de duplicación borra la clave de cada campaña origen al crear la tanda. Por eso:

- La primera copia de una tanda que llega a la fase 2 lee de Meta y guarda la lectura.
- Las demás copias de esa tanda, que corren hasta 5 a la vez, encuentran la clave y la reutilizan.
- Una tanda nueva vuelve a empezar leyendo de Meta, aunque la anterior haya sido hace pocos minutos.
- Los reintentos y reanudaciones de un trabajo de la tanda usan la lectura guardada mientras no hayan pasado los 30 minutos.

Si varias copias llegan a la fase 2 a la vez antes de que la primera guarde la lectura, cada una puede leer de Meta por su cuenta. No hay candado.

## 6. Cuota y enfriamiento por cuenta

Cada respuesta de Meta pasa por `captureUsage`, que lee el encabezado `x-business-use-case-usage`:

```json
{
  "1234567890": [
    {
      "type": "ads_management",
      "call_count": 42,
      "total_cputime": 18,
      "total_time": 25,
      "estimated_time_to_regain_access": 0
    }
  ]
}
```

- Si `estimated_time_to_regain_access` es mayor que 0, la cuenta entra en enfriamiento por ese tiempo.
- Si el mayor de `call_count`, `total_cputime` y `total_time` llega a 85 %, la cuenta entra en enfriamiento de 60 segundos.
- El enfriamiento se guarda en `meta:cooldown:acct:<cuenta>` con caducidad. Un enfriamiento más corto nunca reemplaza a uno más largo que ya esté activo.
- Un error de cuota de Meta (por ejemplo `code 17`) también inicia un enfriamiento, con el `retryAfterSec` que informe Meta o 60 segundos por defecto.

## 7. Pausa y reanudación ante un límite de Meta

Si `duplicateCampaign` falla por cuota y ya existe `newCampaignId`, el worker no marca el trabajo como fallido:

1. Calcula la espera según el número de pausas previas: 60, 120, 300, 600 y 900 segundos (la última se repite), o el `retryAfterSec` de Meta si es mayor.
2. Marca la cuenta en enfriamiento por esa espera.
3. Guarda `output.pauses` y `output.waiting`, deja el trabajo `pending` y lo reprograma.
4. Tras 12 pausas (unas 2 h 20 min) el trabajo falla con la indicación de lanzar la copia de nuevo más tarde.

Al reanudar, `duplicateCampaign` recibe `resumeCampaignId`:

- Comprueba que la campaña copiada existe con `GET /{newCampaignId}?fields=id`. Si Meta responde que no existe, crea una nueva.
- Lista los ad sets que ya hay en la copia (`GET /{newCampaignId}/adsets?fields=id,name&limit=200`) y solo crea los que faltan, emparejando por nombre.
- En la fase de anuncios empieza con la comprobación de los que ya existen (`dedupFirst`), de modo que no se repite lo creado.

## 8. Errores

Las llamadas a Meta lanzan `MetaApiError`, que tiene dos partes:

- Una explicación para el usuario: título, mensaje y qué hacer.
- El detalle técnico: `code`, `subcode`, `fbtrace_id`, `endpoint`, `httpStatus` e intentos.

Un error de Meta tiene esta forma:

```json
{
  "error": {
    "message": "(#17) User request limit reached",
    "type": "OAuthException",
    "code": 17,
    "error_subcode": 2446079,
    "is_transient": true,
    "fbtrace_id": "A1b2C3d4E5f"
  }
}
```

Cuando el trabajo falla, la fila queda con `status: failed`, `error` con una línea y `output.error` con el error completo. En una tanda, cada trabajo conserva su propio estado, y los que terminaron con incidencias parciales guardan `output.issues`.
