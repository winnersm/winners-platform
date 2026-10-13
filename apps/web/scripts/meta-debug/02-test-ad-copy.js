#!/usr/bin/env node
// Test sistemático de cómo duplicar ads multi-idioma (asset_feed_spec)
// Prueba 3 enfoques en orden y reporta cuál funciona

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
  if (json.error) throw new Error(`API Error ${json.error.code}: ${json.error.message} [${json.error.type}]`);
  return json;
}

async function post(path, body = {}) {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.set(k, String(v));
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const json = await res.json();
  if (json.error) throw new Error(`API Error ${json.error.code}: ${json.error.message} [${json.error.type}]\n${JSON.stringify(json.error, null, 2)}`);
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
  const json = await res.json();
  if (json.error) throw new Error(`API Error ${json.error.code}: ${json.error.message} [${json.error.type}]\n${JSON.stringify(json.error, null, 2)}`);
  return json;
}

async function deleteAd(adId) {
  const url = new URL(`${BASE}/${adId}`);
  url.searchParams.set("access_token", TOKEN);
  const res = await fetch(url.toString(), { method: "DELETE" });
  const json = await res.json();
  return json;
}

async function deleteAdset(adsetId) {
  const url = new URL(`${BASE}/${adsetId}`);
  url.searchParams.set("access_token", TOKEN);
  const res = await fetch(url.toString(), { method: "DELETE" });
  const json = await res.json();
  return json;
}

async function main() {
  console.log("=== TEST DE DUPLICACIÓN DE ADS MULTI-IDIOMA ===\n");

  // 1. Obtener primera campaña activa
  console.log("1. Buscando campaña activa...");
  const campaigns = await get(`act_${ACCOUNT_ID}/campaigns`, {
    fields: "id,name,status",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "1",
  });
  const campaign = campaigns.data[0];
  console.log(`   ✓ Campaña: ${campaign.name} (${campaign.id})\n`);

  // 2. Obtener primer adset y primer ad
  console.log("2. Obteniendo adset y ad originales...");
  const adsets = await get(`${campaign.id}/adsets`, { fields: "id,name", limit: "1" });
  const origAdset = adsets.data[0];
  console.log(`   ✓ Adset original: ${origAdset.name} (${origAdset.id})`);

  const adsResp = await get(`${origAdset.id}/ads`, {
    fields: "id,name,creative{id,name,object_type,asset_feed_spec,object_story_spec,instagram_actor_id}",
    limit: "1",
  });
  const origAd = adsResp.data[0];
  const creative = origAd.creative;
  console.log(`   ✓ Ad original: ${origAd.name} (${origAd.id})`);
  console.log(`   ✓ Creative ID: ${creative.id} (tipo: ${creative.object_type})`);
  console.log(`   ✓ Tiene asset_feed_spec: ${!!creative.asset_feed_spec}`);

  if (creative.asset_feed_spec) {
    const afs = creative.asset_feed_spec;
    console.log(`   ✓ asset_feed_spec: ${afs.bodies?.length} bodies, ${afs.titles?.length} titles, ${afs.videos?.length} videos`);
  }
  console.log();

  // 3. Crear un adset de prueba (copia del original)
  console.log("3. Creando adset de PRUEBA para las pruebas...");
  const newAdsetResp = await post(`${origAdset.id}/copies`, {
    campaign_id: campaign.id,
    status_option: "PAUSED",
  });
  const newAdsetId = newAdsetResp.copied_adset_id ?? newAdsetResp.id;
  console.log(`   ✓ Adset de prueba creado: ${newAdsetId}\n`);

  await delay(5000); // esperar propagación

  const results = {};

  // ===== ENFOQUE A: POST /{adId}/copies con adset_id =====
  console.log("===== ENFOQUE A: POST /{adId}/copies con adset_id =====");
  try {
    const res = await post(`${origAd.id}/copies`, {
      adset_id: newAdsetId,
      status_option: "PAUSED",
    });
    console.log("✅ ENFOQUE A FUNCIONÓ:", JSON.stringify(res, null, 2));
    results.A = { success: true, response: res };
    // Limpiar el ad creado
    if (res.copied_ad_id || res.id) {
      const cleanId = res.copied_ad_id ?? res.id;
      await delay(1000);
      await deleteAd(cleanId);
      console.log(`   (ad de prueba ${cleanId} eliminado)\n`);
    }
  } catch (e) {
    console.log(`❌ ENFOQUE A FALLÓ: ${e.message}\n`);
    results.A = { success: false, error: e.message };
  }

  await delay(2000);

  // ===== ENFOQUE B: POST /{adId}/copies sin adset_id (mismo adset) =====
  console.log("===== ENFOQUE B: POST /{adId}/copies SIN adset_id (mismo adset) =====");
  try {
    const res = await post(`${origAd.id}/copies`, { status_option: "PAUSED" });
    console.log("✅ ENFOQUE B FUNCIONÓ:", JSON.stringify(res, null, 2));
    results.B = { success: true, response: res };
    // Limpiar
    if (res.copied_ad_id || res.id) {
      const cleanId = res.copied_ad_id ?? res.id;
      await delay(1000);
      await deleteAd(cleanId);
      console.log(`   (ad de prueba ${cleanId} eliminado)\n`);
    }
  } catch (e) {
    console.log(`❌ ENFOQUE B FALLÓ: ${e.message}\n`);
    results.B = { success: false, error: e.message };
  }

  await delay(2000);

  // ===== ENFOQUE C: Crear nuevo creativo + ad desde asset_feed_spec =====
  if (creative.asset_feed_spec) {
    console.log("===== ENFOQUE C: Crear nuevo creativo con asset_feed_spec completo =====");
    try {
      // Necesitamos object_story_spec o page_id para el nuevo creativo
      // Obtener el creativo completo con más campos
      const fullCreative = await get(creative.id, {
        fields: "id,name,object_type,asset_feed_spec,object_story_spec,instagram_actor_id,page_id",
      });
      console.log("   Creative completo:");
      console.log(`   - object_type: ${fullCreative.object_type}`);
      console.log(`   - page_id: ${fullCreative.page_id}`);
      console.log(`   - instagram_actor_id: ${fullCreative.instagram_actor_id}`);
      console.log(`   - object_story_spec keys: ${Object.keys(fullCreative.object_story_spec ?? {}).join(", ")}`);

      // Construir el nuevo creativo
      const newCreativePayload = {
        name: `[TEST] ${creative.name}`,
        object_story_spec: JSON.stringify(fullCreative.object_story_spec),
        asset_feed_spec: JSON.stringify(fullCreative.asset_feed_spec),
      };

      if (fullCreative.instagram_actor_id) {
        newCreativePayload.instagram_actor_id = fullCreative.instagram_actor_id;
      }

      const newCreative = await postJSON(`act_${ACCOUNT_ID}/adcreatives`, {
        name: `[TEST] ${creative.name}`,
        object_story_spec: fullCreative.object_story_spec,
        asset_feed_spec: fullCreative.asset_feed_spec,
        ...(fullCreative.instagram_actor_id ? { instagram_actor_id: fullCreative.instagram_actor_id } : {}),
      });
      console.log(`   ✓ Nuevo creativo creado: ${newCreative.id}`);

      await delay(2000);

      // Crear el ad con el nuevo creativo
      const newAd = await postJSON(`act_${ACCOUNT_ID}/ads`, {
        name: `[TEST] ${origAd.name}`,
        adset_id: newAdsetId,
        creative: { creative_id: newCreative.id },
        status: "PAUSED",
      });
      console.log("✅ ENFOQUE C FUNCIONÓ:", JSON.stringify(newAd, null, 2));
      results.C = { success: true, response: newAd };

      // Limpiar
      await delay(1000);
      await deleteAd(newAd.id);
      console.log(`   (ad de prueba ${newAd.id} eliminado)`);
    } catch (e) {
      console.log(`❌ ENFOQUE C FALLÓ: ${e.message}\n`);
      results.C = { success: false, error: e.message };
    }
  }

  await delay(2000);

  // ===== ENFOQUE D: POST /act_{accountId}/ads con creative_id del original (bracket notation) =====
  console.log("===== ENFOQUE D: POST /act_{accountId}/ads con creative_id original (bracket notation) =====");
  try {
    const url = new URL(`${BASE}/act_${ACCOUNT_ID}/ads`);
    url.searchParams.set("access_token", TOKEN);
    const form = new URLSearchParams();
    form.set("name", `[TEST] ${origAd.name}`);
    form.set("adset_id", newAdsetId);
    form.set("creative[creative_id]", creative.id);
    form.set("status", "PAUSED");
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const json = await res.json();
    if (json.error) throw new Error(`API Error ${json.error.code}: ${json.error.message} [${json.error.type}]\n${JSON.stringify(json.error, null, 2)}`);
    console.log("✅ ENFOQUE D FUNCIONÓ:", JSON.stringify(json, null, 2));
    results.D = { success: true, response: json };
    await delay(1000);
    await deleteAd(json.id);
  } catch (e) {
    console.log(`❌ ENFOQUE D FALLÓ: ${e.message}\n`);
    results.D = { success: false, error: e.message };
  }

  // Limpiar adset de prueba
  await delay(2000);
  console.log("\n=== LIMPIANDO adset de prueba ===");
  const delResult = await deleteAdset(newAdsetId);
  console.log(`   Adset ${newAdsetId}: ${JSON.stringify(delResult)}`);

  // Resumen
  console.log("\n\n========== RESUMEN ==========");
  for (const [key, val] of Object.entries(results)) {
    console.log(`ENFOQUE ${key}: ${val.success ? "✅ ÉXITO" : "❌ FALLO — " + val.error?.split("\n")[0]}`);
  }
  console.log("=============================\n");
}

main().catch(console.error);
