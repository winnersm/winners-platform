#!/usr/bin/env node
// Test: ¿cuánto tiempo necesita un adset recién copiado para aceptar nuevos ads?

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

// Intenta crear el ad y verifica si se creó (incluso si devuelve error)
async function tryCreateAd(adsetId, creativeId, attemptNum) {
  console.log(`  [Intento ${attemptNum}] Creando ad en adset ${adsetId}...`);
  const response = await postJSON(`act_${ACCOUNT_ID}/ads`, {
    name: `[PROP-TEST-${attemptNum}] ad`,
    adset_id: adsetId,
    creative: { creative_id: creativeId },
    status: "PAUSED",
  });

  if (response.id) {
    console.log(`  ✅ Éxito directo! Ad ID: ${response.id}`);
    return { success: true, id: response.id };
  } else if (response.error) {
    console.log(`  Error: code=${response.error.code} message="${response.error.message}"`);
    // Verificar si el ad se creó de todas formas (2-3 segundos después)
    await delay(3000);
    const ads = await get(`${adsetId}/ads`, { fields: "id,name,created_time", limit: "10" });
    const newAds = (ads.data ?? []).filter(a => a.name.includes(`[PROP-TEST-${attemptNum}]`));
    if (newAds.length > 0) {
      console.log(`  ⚠️  Error ${response.error.code} pero ad SÍ se creó: ${newAds[0].id}`);
      return { success: true, id: newAds[0].id, wasError: true };
    }
    return { success: false, error: response.error };
  }
  return { success: false };
}

async function main() {
  console.log("=== TEST DE PROPAGACIÓN: tiempos de espera vs éxito de ad creation ===\n");

  // Obtener datos base
  const campaigns = await get(`act_${ACCOUNT_ID}/campaigns`, {
    fields: "id,name",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "1",
  });
  const campaign = campaigns.data[0];
  const adsets = await get(`${campaign.id}/adsets`, { fields: "id,name", limit: "1" });
  const origAdset = adsets.data[0];
  const adsResp = await get(`${origAdset.id}/ads`, { fields: "id,name,creative{id}", limit: "1" });
  const creativeId = adsResp.data[0].creative.id;

  console.log(`Campaña: ${campaign.name}`);
  console.log(`Adset original: ${origAdset.id}`);
  console.log(`Creative ID: ${creativeId}\n`);

  // Test también con el nuevo creativo que sabemos que funciona (asset_feed_spec limpio)
  // Crear un nuevo creativo limpio
  console.log("Preparando creativo limpio (sin standard_enhancements)...");
  const origCreative = await get(creativeId, {
    fields: "id,name,asset_feed_spec,object_story_spec,degrees_of_freedom_spec,url_tags",
  });

  // Limpiar asset_feed_spec
  const afs = origCreative.asset_feed_spec;
  const cleanAFS = {
    bodies: afs.bodies,
    titles: afs.titles,
    call_to_action_types: afs.call_to_action_types,
    ad_formats: ["SINGLE_VIDEO"],
    videos: afs.videos.map(({ thumbnail_url, ...rest }) => rest),
  };
  if (afs.descriptions) cleanAFS.descriptions = afs.descriptions;

  // Limpiar degrees
  const features = { ...origCreative.degrees_of_freedom_spec?.creative_features_spec };
  delete features.standard_enhancements;
  const cleanDegrees = { creative_features_spec: features };

  const newCreativeResp = await postJSON(`act_${ACCOUNT_ID}/adcreatives`, {
    name: `[PROP-TEST] creativo`,
    object_story_spec: origCreative.object_story_spec,
    asset_feed_spec: cleanAFS,
    degrees_of_freedom_spec: cleanDegrees,
    url_tags: origCreative.url_tags,
  });

  const newCreativeId = newCreativeResp.id;
  if (!newCreativeId) {
    console.log("Error creando creativo:", JSON.stringify(newCreativeResp));
    return;
  }
  console.log(`✅ Creativo limpio: ${newCreativeId}\n`);

  // Crear adset de prueba
  console.log("Creando adset de prueba...");
  const t0 = Date.now();
  const copyResp = await postJSON(`${origAdset.id}/copies`, {
    campaign_id: campaign.id,
    status_option: "PAUSED",
  });
  const testAdsetId = copyResp.copied_adset_id ?? copyResp.id;
  if (!testAdsetId) {
    console.log("Error creando adset:", JSON.stringify(copyResp));
    return;
  }
  console.log(`✅ Adset de prueba: ${testAdsetId} (creado en ${Date.now() - t0}ms)\n`);

  // Intentar crear ad en distintos intervalos de tiempo
  const waits = [0, 5000, 10000, 20000, 30000, 60000]; // milisegundos
  let totalWaited = 0;
  let successAdId = null;
  let successWait = null;

  // Usar AMBOS creativos (el original con error conocido y el nuevo limpio)
  const creativesToTest = [creativeId, newCreativeId];

  for (const waitMs of waits) {
    if (successAdId) break;

    const waitSinceStart = totalWaited + waitMs;
    if (waitMs > 0) {
      console.log(`\nEsperando ${waitMs / 1000}s más... (total desde creación: ${waitSinceStart / 1000}s)`);
      await delay(waitMs);
      totalWaited += waitMs;
    } else {
      console.log(`\nIntento inmediato (${totalWaited / 1000}s desde creación):`);
    }

    for (const cid of creativesToTest) {
      const attempt = waits.indexOf(waitMs) * creativesToTest.length + creativesToTest.indexOf(cid) + 1;
      const result = await tryCreateAd(testAdsetId, cid, attempt);
      if (result.success) {
        successAdId = result.id;
        successWait = totalWaited;
        console.log(`\n🎉 ÉXITO con creative ${cid === creativeId ? "ORIGINAL" : "LIMPIO"} después de ${successWait / 1000}s de espera!`);
        // Limpiar el ad creado
        await delay(2000);
        await deleteEntity(successAdId);
        console.log(`   (Ad ${successAdId} eliminado)`);
        break;
      }
      await delay(2000);
    }
  }

  // Limpiar
  console.log("\nLimpiando...");
  await delay(2000);
  // Eliminar ads de prueba que pudieran haber quedado
  const remainingAds = await get(`${testAdsetId}/ads`, { fields: "id,name", limit: "20" });
  for (const a of remainingAds.data ?? []) {
    await deleteEntity(a.id);
    console.log(`  Ad ${a.id} eliminado`);
  }
  await delay(1000);
  await deleteEntity(testAdsetId);
  console.log(`  Adset ${testAdsetId} eliminado`);
  await delay(1000);
  await deleteEntity(newCreativeId);
  console.log(`  Creativo ${newCreativeId} eliminado`);

  // Conclusión
  console.log("\n========== CONCLUSIÓN ==========");
  if (successAdId) {
    console.log(`✅ La solución es esperar ${successWait / 1000}s después de crear el adset`);
    console.log(`   Recomendación: usar ${Math.ceil(successWait / 1000) + 5}s de margen en la app`);
  } else {
    console.log("❌ El ad nunca se creó incluso después de 60+ segundos de espera");
    console.log("   El problema NO es de propagación — es algo más profundo");
  }
  console.log("================================\n");
}

main().catch(console.error);
