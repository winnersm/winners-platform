#!/usr/bin/env node
// Solución real: crear nuevo creativo con asset_feed_spec del original
// pero con degrees_of_freedom_spec limpio (sin standard_enhancements deprecado)

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
  if (json.error) throw new Error(`API Error ${json.error.code}: ${json.error.message}\n${JSON.stringify(json.error, null, 2)}`);
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
  if (json.error) {
    throw new Error(`API Error ${json.error.code}: ${json.error.message}\n${JSON.stringify(json.error, null, 2)}`);
  }
  return json;
}

async function deleteEntity(id) {
  const url = new URL(`${BASE}/${id}`);
  url.searchParams.set("access_token", TOKEN);
  const res = await fetch(url.toString(), { method: "DELETE" });
  return res.json();
}

// Construye degrees_of_freedom_spec sin standard_enhancements (o con OPT_OUT)
function buildCleanDegrees(original) {
  if (!original?.creative_features_spec) return undefined;
  const features = { ...original.creative_features_spec };
  // Eliminar standard_enhancements (campo deprecado que rompe /copies)
  delete features.standard_enhancements;
  return { creative_features_spec: features };
}

// Limpia el asset_feed_spec: quita thumbnail_url y añade ad_formats requerido
function cleanAssetFeedSpec(afs) {
  const hasVideos = afs.videos?.length > 0;
  const hasImages = afs.images?.length > 0;

  // Meta requiere exactamente un ad_format
  let ad_formats;
  if (hasVideos && !hasImages) ad_formats = ["SINGLE_VIDEO"];
  else if (hasImages && !hasVideos) ad_formats = ["SINGLE_IMAGE"];
  else ad_formats = ["AUTOMATIC_FORMAT"];

  const clean = {
    bodies: afs.bodies,
    titles: afs.titles,
    call_to_action_types: afs.call_to_action_types,
    ad_formats,
  };

  if (afs.descriptions) clean.descriptions = afs.descriptions;
  if (afs.link_urls) clean.link_urls = afs.link_urls;

  if (afs.videos) {
    // Quitar thumbnail_url — es generado, no se puede pasar al crear
    clean.videos = afs.videos.map(({ thumbnail_url, ...rest }) => rest);
  }

  if (afs.images) {
    clean.images = afs.images.map(({ thumbnail_url, ...rest }) => rest);
  }

  if (afs.asset_customization_rules) {
    clean.asset_customization_rules = afs.asset_customization_rules;
  }

  return clean;
}

async function main() {
  console.log("=== TEST: CREAR NUEVO CREATIVO + AD (solución multi-idioma) ===\n");

  // 1. Obtener campaña activa
  console.log("1. Obteniendo campaña activa...");
  const campaigns = await get(`act_${ACCOUNT_ID}/campaigns`, {
    fields: "id,name",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "1",
  });
  const campaign = campaigns.data[0];
  console.log(`   ✓ Campaña: ${campaign.name} (${campaign.id})\n`);

  // 2. Obtener primer adset y su primer ad con TODOS los campos del creative
  console.log("2. Obteniendo ad original completo...");
  const adsets = await get(`${campaign.id}/adsets`, { fields: "id,name", limit: "1" });
  const origAdset = adsets.data[0];

  const adsResp = await get(`${origAdset.id}/ads`, {
    fields: [
      "id",
      "name",
      "status",
      "targeting",
      "creative{id,name,object_type,asset_feed_spec,object_story_spec,instagram_user_id,degrees_of_freedom_spec,url_tags}",
    ].join(","),
    limit: "1",
  });

  const origAd = adsResp.data[0];
  const creative = origAd.creative;

  console.log(`   ✓ Ad: ${origAd.name} (${origAd.id})`);
  console.log(`   ✓ Creative: ${creative.id}`);
  console.log(`   ✓ object_story_spec.page_id: ${creative.object_story_spec?.page_id}`);
  console.log(`   ✓ object_story_spec.instagram_user_id: ${creative.object_story_spec?.instagram_user_id}`);
  console.log(`   ✓ asset_feed_spec: ${creative.asset_feed_spec?.bodies?.length} bodies, ${creative.asset_feed_spec?.videos?.length} videos`);
  console.log(`   ✓ degrees_of_freedom_spec keys: ${Object.keys(creative.degrees_of_freedom_spec?.creative_features_spec ?? {}).join(", ")}`);
  console.log(`   ✓ url_tags: ${creative.url_tags?.substring(0, 60)}...`);

  // 3. Crear adset de prueba
  console.log("\n3. Creando adset de prueba...");
  const newAdsetResp = await postJSON(`${origAdset.id}/copies`, {
    campaign_id: campaign.id,
    status_option: "PAUSED",
  });
  const newAdsetId = newAdsetResp.copied_adset_id ?? newAdsetResp.id;
  console.log(`   ✓ Adset de prueba: ${newAdsetId}`);

  await delay(5000); // propagación

  let newCreativeId = null;
  let newAdId = null;
  let success = false;

  // 4. Intentar crear nuevo creativo
  console.log("\n4. Creando nuevo creativo (sin standard_enhancements)...");

  const cleanAFS = cleanAssetFeedSpec(creative.asset_feed_spec);
  const cleanDegrees = buildCleanDegrees(creative.degrees_of_freedom_spec);

  const newCreativePayload = {
    name: `[TEST-COPIA] ${creative.name}`,
    object_story_spec: creative.object_story_spec,
    asset_feed_spec: cleanAFS,
  };

  if (creative.url_tags) newCreativePayload.url_tags = creative.url_tags;
  if (creative.instagram_user_id) newCreativePayload.instagram_user_id = creative.instagram_user_id;
  if (cleanDegrees) newCreativePayload.degrees_of_freedom_spec = cleanDegrees;

  console.log("   Payload del nuevo creativo:");
  console.log(`     - object_story_spec: page_id=${newCreativePayload.object_story_spec?.page_id}`);
  console.log(`     - asset_feed_spec: ${cleanAFS.bodies?.length} bodies, ${cleanAFS.videos?.length} videos`);
  console.log(`     - degrees_of_freedom_spec: ${cleanDegrees ? "presente (sin standard_enhancements)" : "omitido"}`);

  try {
    const newCreative = await postJSON(`act_${ACCOUNT_ID}/adcreatives`, newCreativePayload);
    newCreativeId = newCreative.id;
    console.log(`   ✅ Creativo creado: ${newCreativeId}\n`);
  } catch (e) {
    console.log(`   ❌ Error creando creativo:\n${e.message}\n`);

    // Intento alternativo: sin degrees_of_freedom_spec
    console.log("   Reintentando SIN degrees_of_freedom_spec...");
    const payloadSinDegrees = { ...newCreativePayload };
    delete payloadSinDegrees.degrees_of_freedom_spec;
    try {
      const newCreative = await postJSON(`act_${ACCOUNT_ID}/adcreatives`, payloadSinDegrees);
      newCreativeId = newCreative.id;
      console.log(`   ✅ Creativo creado (sin degrees): ${newCreativeId}\n`);
    } catch (e2) {
      console.log(`   ❌ También falló sin degrees:\n${e2.message}\n`);
    }
  }

  // 5. Crear el ad con el nuevo creativo
  if (newCreativeId) {
    console.log("5. Creando ad con el nuevo creativo...");
    await delay(2000);
    try {
      const newAd = await postJSON(`act_${ACCOUNT_ID}/ads`, {
        name: `[TEST-COPIA] ${origAd.name}`,
        adset_id: newAdsetId,
        creative: { creative_id: newCreativeId },
        status: "PAUSED",
      });
      newAdId = newAd.id;
      console.log(`   ✅ AD CREADO: ${newAdId}`);
      console.log(`   Respuesta: ${JSON.stringify(newAd, null, 2)}`);
      success = true;
    } catch (e) {
      console.log(`   ❌ Error creando ad:\n${e.message}`);
    }
  }

  // 6. Limpiar
  console.log("\n6. Limpiando entidades de prueba...");
  await delay(2000);

  if (newAdId) {
    const r = await deleteEntity(newAdId);
    console.log(`   Ad ${newAdId}: ${JSON.stringify(r)}`);
    await delay(1000);
  }

  if (newCreativeId) {
    const r = await deleteEntity(newCreativeId);
    console.log(`   Creative ${newCreativeId}: ${JSON.stringify(r)}`);
    await delay(1000);
  }

  const r = await deleteEntity(newAdsetId);
  console.log(`   Adset ${newAdsetId}: ${JSON.stringify(r)}`);

  // Resultado
  console.log(`\n\n========== RESULTADO ==========`);
  console.log(success ? "✅ SOLUCIÓN ENCONTRADA: crear nuevo creativo + ad funciona" : "❌ Ningún enfoque funcionó");
  console.log("================================\n");
}

main().catch(console.error);
