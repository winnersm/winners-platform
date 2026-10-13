#!/usr/bin/env node
// Test simple: ¿Cuánto tiempo necesita un adset nuevo para aceptar ads?
// Usa el creative_id original, no crea nuevos creativos

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
  return res.json();
}

async function deleteEntity(id) {
  const url = new URL(`${BASE}/${id}`);
  url.searchParams.set("access_token", TOKEN);
  await fetch(url.toString(), { method: "DELETE" });
}

async function listAds(adsetId) {
  const json = await get(`${adsetId}/ads`, { fields: "id,name,status", limit: "20" });
  return json.data ?? [];
}

async function main() {
  console.log("=== TEST PROPAGACIÓN CON ESPERA LARGA ===\n");

  // Setup
  const campaigns = await get(`act_${ACCOUNT_ID}/campaigns`, {
    fields: "id,name",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "1",
  });
  const campaign = campaigns.data[0];
  const adsets = await get(`${campaign.id}/adsets`, { fields: "id,name", limit: "1" });
  const origAdset = adsets.data[0];
  const adsResp = await get(`${origAdset.id}/ads`, { fields: "id,name,creative{id}", limit: "1" });
  const origAd = adsResp.data[0];
  const creativeId = origAd.creative.id;

  console.log(`Campaña: ${campaign.name}`);
  console.log(`Adset original: ${origAdset.id}`);
  console.log(`Creative ID: ${creativeId}`);

  // Crear adset de prueba
  console.log("\nCreando adset de prueba...");
  const t0 = Date.now();
  const copyResp = await postJSON(`${origAdset.id}/copies`, {
    campaign_id: campaign.id,
    status_option: "PAUSED",
  });
  if (copyResp.error) {
    console.log("ERROR creando adset:", JSON.stringify(copyResp.error));
    return;
  }
  const testAdsetId = copyResp.copied_adset_id ?? copyResp.id;
  console.log(`✅ Adset: ${testAdsetId}\n`);

  // Verificar que el adset existe y está listo
  async function checkAdsetStatus() {
    const adset = await get(testAdsetId, { fields: "id,name,status,effective_status" });
    return adset;
  }

  // Intentar crear ad en intervalos crecientes
  const intervals = [5, 10, 20, 30, 60, 120]; // segundos
  let elapsed = 0;
  let successId = null;

  for (const waitSec of intervals) {
    const toWait = (waitSec * 1000) - (Date.now() - t0 - elapsed);
    if (toWait > 0) {
      console.log(`Esperando ${Math.round(toWait / 1000)}s... (total: ${waitSec}s desde creación del adset)`);
      await delay(toWait);
    }
    elapsed = Date.now() - t0;

    // Ver estado del adset
    const adsetStatus = await checkAdsetStatus();
    console.log(`[${waitSec}s] Adset status: ${adsetStatus.status} / effective: ${adsetStatus.effective_status}`);

    // Intentar crear ad
    const res = await postJSON(`act_${ACCOUNT_ID}/ads`, {
      name: `[WAIT-TEST-${waitSec}s] ad`,
      adset_id: testAdsetId,
      creative: { creative_id: creativeId },
      status: "PAUSED",
    });

    if (res.id) {
      console.log(`✅ ÉXITO a los ${waitSec}s! Ad creado: ${res.id}`);
      successId = res.id;
      await delay(1000);
      await deleteEntity(successId);
      console.log(`   (limpiado ${successId})`);
      break;
    } else {
      // Verificar si el ad se creó de todas formas (error falso)
      await delay(3000);
      const adsNow = await listAds(testAdsetId);
      const found = adsNow.find(a => a.name.includes(`[WAIT-TEST-${waitSec}s]`));
      if (found) {
        console.log(`⚠️  Error ${res.error?.code} pero ad SÍ se creó (silencioso): ${found.id}`);
        successId = found.id;
        await delay(1000);
        await deleteEntity(found.id);
        break;
      }
      console.log(`   ❌ Error ${res.error?.code}: ${res.error?.message?.substring(0, 60)}`);
    }
    await delay(1000);
  }

  // Limpiar
  console.log("\nLimpiando adset de prueba...");
  await delay(2000);
  const remainingAds = await listAds(testAdsetId);
  for (const a of remainingAds) {
    await deleteEntity(a.id);
  }
  await deleteEntity(testAdsetId);
  console.log(`✅ Adset ${testAdsetId} eliminado`);

  // Conclusión
  const totalTime = Date.now() - t0;
  console.log("\n========== CONCLUSIÓN ==========");
  if (successId) {
    console.log(`✅ SOLUCIÓN: esperar al menos ${Math.round(elapsed / 1000)}s`);
    console.log(`   (el test total tomó ${Math.round(totalTime / 1000)}s)`);
  } else {
    console.log("❌ El ad nunca se creó incluso después de 2+ minutos");
    console.log("   El problema NO es solo de propagación");
  }
  console.log("================================\n");
}

main().catch(console.error);
