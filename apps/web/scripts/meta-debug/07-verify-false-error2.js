#!/usr/bin/env node
// Verificar hipótesis: ¿Error 2 de POST /ads es falso y el ad SÍ se crea?

const TOKEN = "EAAS6BUWUpDIBRxHXt0rWgH4qUxUR8kOel9m39ZBjXfC2ZCahGWAPPrwl67kmNHCVI7glANeGbbJmHOZBXZAIJilQ1kqBUS9XifPnLCRc2EhSGvragis6Sd4nXqZBUFTYDumyC754LqvS0TN05AEculNqTy8Y12iaZCDOx82WcSunXLAIiUjwuTbaKkaPkAPAZDZD";
const ACCOUNT_ID = "1290585793259065";
const BASE = "https://graph.facebook.com/v21.0";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params = {}) {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const json = await res.json();
  if (json.error) throw new Error(`API Error ${json.error.code}: ${json.error.message}`);
  return json;
}

async function postJSON(path, body) {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json(); // NO lanzar error — guardar respuesta cruda
}

async function deleteEntity(id) {
  const url = new URL(`${BASE}/${id}`);
  url.searchParams.set("access_token", TOKEN);
  const res = await fetch(url.toString(), { method: "DELETE" });
  return res.json();
}

async function listAdsInAdset(adsetId) {
  const json = await get(`${adsetId}/ads`, {
    fields: "id,name,status,created_time",
    limit: "20",
  });
  return json.data ?? [];
}

async function main() {
  console.log("=== VERIFICACIÓN: ¿Error 2 es falso en POST /ads? ===\n");

  // 1. Obtener campaña, adset y creative
  const campaigns = await get(`act_${ACCOUNT_ID}/campaigns`, {
    fields: "id,name",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "1",
  });
  const campaign = campaigns.data[0];

  const adsets = await get(`${campaign.id}/adsets`, { fields: "id,name", limit: "1" });
  const origAdset = adsets.data[0];

  const adsResp = await get(`${origAdset.id}/ads`, {
    fields: "id,name,creative{id}",
    limit: "1",
  });
  const origAd = adsResp.data[0];
  const creativeId = origAd.creative.id;

  // 2. Crear adset de prueba
  console.log("Creando adset de prueba...");
  const url = new URL(`${BASE}/${origAdset.id}/copies`);
  url.searchParams.set("access_token", TOKEN);
  const copyRes = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ campaign_id: campaign.id, status_option: "PAUSED" }),
  });
  const copyJson = await copyRes.json();
  if (copyJson.error) throw new Error("No se pudo crear adset de prueba: " + JSON.stringify(copyJson.error));
  const testAdsetId = copyJson.copied_adset_id ?? copyJson.id;
  console.log(`Adset de prueba: ${testAdsetId}\n`);

  await delay(6000); // propagación

  // 3. Ver ads actuales en el adset de prueba (debe estar vacío)
  const adsBefore = await listAdsInAdset(testAdsetId);
  console.log(`Ads en adset ANTES de la llamada: ${adsBefore.length}`);
  if (adsBefore.length > 0) {
    for (const a of adsBefore) console.log(`  - ${a.id}: ${a.name}`);
  }

  // 4. Hacer la llamada que "devuelve error 2"
  console.log("\nLlamando POST /ads (esperamos error 2 pero puede crear el ad)...");
  const rawResponse = await postJSON(`act_${ACCOUNT_ID}/ads`, {
    name: `[VERIFY-TEST] ad`,
    adset_id: testAdsetId,
    creative: { creative_id: creativeId },
    status: "PAUSED",
  });
  console.log(`Respuesta cruda: ${JSON.stringify(rawResponse)}`);

  await delay(5000); // esperar por si el ad se creó en segundo plano

  // 5. Ver ads en el adset DESPUÉS de la llamada
  const adsAfter = await listAdsInAdset(testAdsetId);
  console.log(`\nAds en adset DESPUÉS de la llamada: ${adsAfter.length}`);
  if (adsAfter.length > 0) {
    for (const a of adsAfter) console.log(`  - ${a.id}: ${a.name} (${a.status}) creado: ${a.created_time}`);
  }

  const adCreated = adsAfter.length > adsBefore.length;
  console.log(`\n========== CONCLUSIÓN ==========`);
  if (adCreated) {
    const newAds = adsAfter.filter(a => !adsBefore.find(b => b.id === a.id));
    console.log(`✅ HIPÓTESIS CONFIRMADA: Error 2 ES un falso error`);
    console.log(`   El ad SÍ se creó: ${newAds.map(a => a.id).join(", ")}`);
    console.log(`\n→ SOLUCIÓN: Ignorar error 2 en POST /ads y verificar si el ad fue creado`);
  } else {
    console.log(`❌ HIPÓTESIS INCORRECTA: El ad NO se creó a pesar del error 2`);
    console.log(`   Seguir investigando.`);
  }
  console.log("================================\n");

  // 6. Limpiar
  console.log("Limpiando...");
  await delay(2000);
  for (const a of adsAfter) {
    const r = await deleteEntity(a.id);
    console.log(`  Ad ${a.id}: ${JSON.stringify(r)}`);
  }
  await delay(1000);
  const delAdset = await deleteEntity(testAdsetId);
  console.log(`  Adset ${testAdsetId}: ${JSON.stringify(delAdset)}`);

  // Limpiar ads de prueba previos que quedaron en el adset original
  console.log("\n=== LIMPIANDO ads de prueba previos en adset original ===");
  const origAdsNow = await listAdsInAdset(origAdset.id);
  console.log(`Ads en adset original ${origAdset.id}: ${origAdsNow.length}`);
  for (const a of origAdsNow) {
    if (a.name.includes("[MIN-TEST") || a.name.includes("[VERIFY")) {
      console.log(`  Eliminando ad de prueba: ${a.id} - ${a.name}`);
      await deleteEntity(a.id);
      await delay(500);
    } else {
      console.log(`  Conservando: ${a.id} - ${a.name}`);
    }
  }
}

main().catch(console.error);
