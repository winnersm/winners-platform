#!/usr/bin/env node
// Probar deep_copy en adset con error detallado y también probar
// si podemos crear ads en adsets que YA SALIERON de IN_PROCESS

const TOKEN = "EAAS6BUWUpDIBRxHXt0rWgH4qUxUR8kOel9m39ZBjXfC2ZCahGWAPPrwl67kmNHCVI7glANeGbbJmHOZBXZAIJilQ1kqBUS9XifPnLCRc2EhSGvragis6Sd4nXqZBUFTYDumyC754LqvS0TN05AEculNqTy8Y12iaZCDOx82WcSunXLAIiUjwuTbaKkaPkAPAZDZD";
const ACCOUNT_ID = "1290585793259065";
const BASE = "https://graph.facebook.com/v21.0";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params = {}) {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  return res.json();
}

async function postForm(path, body) {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.set(k, String(v));
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return res.json();
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

async function main() {
  // 1. Obtener campaña y adset originales
  const campaigns = await get(`act_${ACCOUNT_ID}/campaigns`, {
    fields: "id,name",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "1",
  });
  const campaign = campaigns.data[0];

  const adsets = await get(`${campaign.id}/adsets`, { fields: "id,name,status,effective_status", limit: "3" });
  console.log("Adsets de la campaña activa:");
  for (const a of adsets.data) {
    console.log(`  ${a.id}: ${a.name} | status=${a.status} | effective=${a.effective_status}`);
  }
  const origAdset = adsets.data[0];

  // ===== TEST A: deep_copy=1 en adset =====
  console.log("\n=== TEST A: POST /{adsetId}/copies con deep_copy=1 ===");
  const deepCopyResult = await postForm(`${origAdset.id}/copies`, {
    campaign_id: campaign.id,
    status_option: "PAUSED",
    deep_copy: "1",
  });
  console.log("Resultado:", JSON.stringify(deepCopyResult, null, 2));

  // Si deep_copy funcionó, limpiar
  if (deepCopyResult.copied_adset_id || deepCopyResult.id) {
    const newId = deepCopyResult.copied_adset_id ?? deepCopyResult.id;
    console.log(`✅ deep_copy funcionó! Nuevo adset: ${newId}`);
    // Ver si tiene ads
    await delay(3000);
    const ads = await get(`${newId}/ads`, { fields: "id,name", limit: "10" });
    console.log(`  Ads en el nuevo adset: ${ads.data?.length ?? 0}`);
    if (ads.data?.length > 0) {
      console.log("  ✅ ¡DEEP COPY INCLUYE ADS!");
      for (const a of ads.data) console.log(`    - ${a.id}: ${a.name}`);
    }
    await delay(2000);
    await deleteEntity(newId);
    console.log(`  (Adset ${newId} eliminado)`);
  }

  // ===== TEST B: ¿Los adsets EXISTENTES de la campaña aceptan nuevos ads? =====
  console.log("\n=== TEST B: Crear ad en adset existente (ya establecido, no IN_PROCESS) ===");

  // Buscar adsets que NO estén en IN_PROCESS
  const stableAdsets = adsets.data.filter(a => a.effective_status !== "IN_PROCESS");
  console.log(`Adsets estables (no IN_PROCESS): ${stableAdsets.length}`);

  if (stableAdsets.length > 0) {
    const stableAdset = stableAdsets[0];
    console.log(`Usando adset: ${stableAdset.id} (${stableAdset.effective_status})`);

    // Obtener su creative
    const ads = await get(`${stableAdset.id}/ads`, { fields: "id,name,creative{id}", limit: "1" });
    const existingAd = ads.data?.[0];

    if (existingAd) {
      console.log(`Creative del adset: ${existingAd.creative.id}`);

      const newAdResult = await postJSON(`act_${ACCOUNT_ID}/ads`, {
        name: "[TEST-STABLE] ad",
        adset_id: stableAdset.id,
        creative: { creative_id: existingAd.creative.id },
        status: "PAUSED",
      });

      console.log(`Resultado crear ad: ${JSON.stringify(newAdResult)}`);

      // Verificar si se creó (incluso si devolvió error)
      await delay(3000);
      const adsNow = await get(`${stableAdset.id}/ads`, { fields: "id,name,status", limit: "20" });
      const testAd = adsNow.data?.find(a => a.name === "[TEST-STABLE] ad");

      if (newAdResult.id) {
        console.log(`✅ Ad creado directamente: ${newAdResult.id}`);
        await deleteEntity(newAdResult.id);
      } else if (testAd) {
        console.log(`✅ Ad creado silenciosamente: ${testAd.id}`);
        await deleteEntity(testAd.id);
      } else {
        console.log("❌ Ad NO se creó");
      }
    } else {
      console.log("El adset estable no tiene ads para obtener un creative");
    }
  }

  // ===== TEST C: Crear adset nuevo → esperar hasta que salga de IN_PROCESS → crear ad =====
  console.log("\n=== TEST C: Crear adset + poll hasta PAUSED + crear ad ===");
  const t0 = Date.now();

  const newAdsetResp = await postJSON(`${origAdset.id}/copies`, {
    campaign_id: campaign.id,
    status_option: "PAUSED",
  });

  if (newAdsetResp.error) {
    console.log("Error creando adset:", JSON.stringify(newAdsetResp.error));
    return;
  }

  const newAdsetId = newAdsetResp.copied_adset_id ?? newAdsetResp.id;
  console.log(`Adset nuevo: ${newAdsetId}`);

  // Obtener creative del adset original
  const origAds = await get(`${origAdset.id}/ads`, { fields: "id,name,creative{id}", limit: "1" });
  const origCreativeId = origAds.data?.[0]?.creative?.id;
  console.log(`Creative original: ${origCreativeId}`);

  // Poll hasta que salga de IN_PROCESS (máx 10 minutos)
  console.log("Polling status hasta que salga de IN_PROCESS...");
  let ready = false;
  let attempts = 0;
  const maxAttempts = 60; // 10 min con 10s de intervalo

  while (!ready && attempts < maxAttempts) {
    await delay(10000); // 10 segundos
    attempts++;
    const adsetStatus = await get(newAdsetId, { fields: "id,status,effective_status" });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`  [${elapsed}s] effective_status: ${adsetStatus.effective_status}`);

    if (adsetStatus.effective_status !== "IN_PROCESS") {
      ready = true;
      console.log(`✅ Adset listo después de ${elapsed}s! Status: ${adsetStatus.effective_status}`);
    }
  }

  if (ready) {
    console.log("Intentando crear ad ahora...");
    const adResult = await postJSON(`act_${ACCOUNT_ID}/ads`, {
      name: "[POLL-TEST] ad",
      adset_id: newAdsetId,
      creative: { creative_id: origCreativeId },
      status: "PAUSED",
    });

    console.log(`Resultado: ${JSON.stringify(adResult)}`);

    await delay(3000);
    const adsCheck = await get(`${newAdsetId}/ads`, { fields: "id,name", limit: "5" });
    console.log(`Ads en adset: ${adsCheck.data?.length ?? 0}`);
    for (const a of adsCheck.data ?? []) {
      console.log(`  - ${a.id}: ${a.name}`);
      await deleteEntity(a.id);
    }
  } else {
    console.log("❌ Adset nunca salió de IN_PROCESS en 10 minutos");
  }

  // Limpiar adset
  await delay(2000);
  await deleteEntity(newAdsetId);
  console.log(`Adset ${newAdsetId} eliminado`);

  const totalTime = Math.round((Date.now() - t0) / 1000);
  console.log(`\nTest C completado en ${totalTime}s`);
}

main().catch(console.error);
