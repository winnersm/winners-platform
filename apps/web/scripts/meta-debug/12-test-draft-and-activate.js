#!/usr/bin/env node
// Test final:
// A) Crear ad en status DRAFT (¿funciona en adsets PAUSED?)
// B) Activar adset temporalmente, crear ad, pausarlo de nuevo

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

async function postBracket(adsetId, creativeId, name, status = "PAUSED") {
  const url = new URL(`${BASE}/act_${ACCOUNT_ID}/ads`);
  url.searchParams.set("access_token", TOKEN);
  const form = new URLSearchParams();
  form.set("name", name);
  form.set("adset_id", adsetId);
  form.set("creative[creative_id]", creativeId);
  form.set("status", status);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return res.json();
}

async function updateStatus(entityId, status) {
  const url = new URL(`${BASE}/${entityId}`);
  url.searchParams.set("access_token", TOKEN);
  const form = new URLSearchParams();
  form.set("status", status);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return res.json();
}

async function deleteEntity(id) {
  const url = new URL(`${BASE}/${id}`);
  url.searchParams.set("access_token", TOKEN);
  await fetch(url.toString(), { method: "DELETE" });
}

async function findAd(adsetId, name) {
  const json = await get(`${adsetId}/ads`, { fields: "id,name,status,effective_status", limit: "20" });
  return (json.data ?? []).find(a => a.name === name);
}

async function waitForPaused(adsetId) {
  for (let i = 0; i < 30; i++) {
    await delay(5000);
    const status = await get(adsetId, { fields: "effective_status" });
    if (status.effective_status !== "IN_PROCESS") return true;
  }
  return false;
}

async function main() {
  console.log("=== TEST FINAL: DRAFT STATUS Y ACTIVATE TEMPORAL ===\n");

  // Setup
  const campaigns = await get(`act_${ACCOUNT_ID}/campaigns`, {
    fields: "id,name",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "1",
  });
  const campaign = campaigns.data[0];
  const adsets = await get(`${campaign.id}/adsets`, { fields: "id,name,status,effective_status", limit: "1" });
  const origAdset = adsets.data[0];
  const origAds = await get(`${origAdset.id}/ads`, { fields: "id,name,creative{id}", limit: "1" });
  const creativeId = origAds.data[0].creative.id;

  console.log(`Campaña activa: ${campaign.id}`);
  console.log(`Adset original: ${origAdset.id} (${origAdset.effective_status})`);
  console.log(`Creative: ${creativeId}\n`);

  // ===== TEST A: Ad con status DRAFT en adset ACTIVE =====
  console.log("=== TEST A: status=DRAFT en adset ACTIVE ===");
  {
    const resp = await postBracket(origAdset.id, creativeId, "[DRAFT-TEST-A] ad", "DRAFT");
    console.log(`  Respuesta: code=${resp.error?.code ?? "OK"} id=${resp.id ?? "nulo"}`);
    await delay(4000);
    const ad = await findAd(origAdset.id, "[DRAFT-TEST-A] ad");
    if (resp.id || ad) {
      console.log(`  ✅ Ad DRAFT en ACTIVE creado: ${resp.id ?? ad.id}`);
      await deleteEntity(resp.id ?? ad.id);
    } else {
      console.log("  ❌ Ad DRAFT en ACTIVE NO creado");
    }
  }

  await delay(2000);

  // ===== Crear adset de prueba para tests B y C =====
  console.log("\nCreando adset de prueba (PAUSED)...");
  const t0 = Date.now();
  const newAdsetResp = await postJSON(`${origAdset.id}/copies`, {
    campaign_id: campaign.id,
    status_option: "PAUSED",
  });
  const newAdsetId = newAdsetResp.copied_adset_id ?? newAdsetResp.id;
  console.log(`  Adset: ${newAdsetId}`);

  // Esperar PAUSED
  console.log("  Esperando PAUSED...");
  await waitForPaused(newAdsetId);
  const adsetStatus = await get(newAdsetId, { fields: "status,effective_status" });
  console.log(`  ✓ Adset: status=${adsetStatus.status} effective=${adsetStatus.effective_status}\n`);

  // ===== TEST B: Ad con status DRAFT en adset PAUSED =====
  console.log("=== TEST B: status=DRAFT en adset PAUSED ===");
  {
    const resp = await postBracket(newAdsetId, creativeId, "[DRAFT-TEST-B] ad", "DRAFT");
    console.log(`  Respuesta: code=${resp.error?.code ?? "OK"} id=${resp.id ?? "nulo"}`);
    if (resp.error) console.log(`  Error completo: ${JSON.stringify(resp.error)}`);
    await delay(4000);
    const ad = await findAd(newAdsetId, "[DRAFT-TEST-B] ad");
    if (resp.id || ad) {
      console.log(`  ✅ Ad DRAFT en PAUSED creado: ${resp.id ?? ad.id}`);
      await deleteEntity(resp.id ?? ad.id);
    } else {
      console.log("  ❌ Ad DRAFT en PAUSED NO creado");
    }
  }

  await delay(2000);

  // ===== TEST C: Activar adset + crear ad (PAUSED) + pausar =====
  console.log("\n=== TEST C: Activar adset temporalmente + crear ad PAUSED + pausar ===");
  {
    // Activar adset
    console.log("  Activando adset...");
    const activateResp = await updateStatus(newAdsetId, "ACTIVE");
    console.log(`  Resultado activación: ${JSON.stringify(activateResp)}`);
    await delay(3000);

    const activeStatus = await get(newAdsetId, { fields: "status,effective_status" });
    console.log(`  Status post-activación: status=${activeStatus.status} effective=${activeStatus.effective_status}`);

    // Crear ad
    const resp = await postBracket(newAdsetId, creativeId, "[ACTIVE-TEST-C] ad", "PAUSED");
    console.log(`  Respuesta crear ad: code=${resp.error?.code ?? "OK"} id=${resp.id ?? "nulo"}`);
    await delay(4000);
    const ad = await findAd(newAdsetId, "[ACTIVE-TEST-C] ad");

    let createdAdId = resp.id ?? ad?.id;
    if (createdAdId) {
      console.log(`  ✅ Ad creado: ${createdAdId}`);
      // Pausar adset de nuevo
      await delay(1000);
      const pauseResp = await updateStatus(newAdsetId, "PAUSED");
      console.log(`  Resultado pausar: ${JSON.stringify(pauseResp)}`);
    } else {
      console.log("  ❌ Ad NO creado");
    }

    // Limpiar ad si se creó
    if (createdAdId) {
      await delay(2000);
      await deleteEntity(createdAdId);
      console.log(`  Ad ${createdAdId} eliminado`);
    }
  }

  // ===== TEST D: Crear NUEVA campaña PAUSED con adset ACTIVE =====
  console.log("\n=== TEST D: Nueva campaña PAUSED + adset status=ACTIVE ===");
  {
    // Copiar campaña como PAUSED
    console.log("  Copiando campaña como PAUSED...");
    const newCampaignResp = await postJSON(`${campaign.id}/copies`, {
      name: `[TEST-D] ${campaign.id}`,
      status_option: "PAUSED",
    });
    const newCampaignId = newCampaignResp.copied_campaign_id ?? newCampaignResp.id;
    if (!newCampaignId) {
      console.log("  Error copiando campaña:", JSON.stringify(newCampaignResp));
      return;
    }
    console.log(`  Nueva campaña: ${newCampaignId} (PAUSED)`);

    // Copiar adset con status ACTIVE
    const newAdset2Resp = await postJSON(`${origAdset.id}/copies`, {
      campaign_id: newCampaignId,
      status_option: "ACTIVE", // ← ACTIVE en lugar de PAUSED
    });
    const newAdset2Id = newAdset2Resp.copied_adset_id ?? newAdset2Resp.id;
    if (!newAdset2Id) {
      console.log("  Error copiando adset:", JSON.stringify(newAdset2Resp));
      // Limpiar campaña
      await deleteEntity(newCampaignId);
      return;
    }
    console.log(`  Nuevo adset: ${newAdset2Id}`);

    // Esperar PAUSED del adset
    console.log("  Esperando que adset salga de IN_PROCESS...");
    await waitForPaused(newAdset2Id);
    const d2Status = await get(newAdset2Id, { fields: "status,effective_status" });
    console.log(`  Adset: status=${d2Status.status} effective=${d2Status.effective_status}`);

    // Crear ad
    const resp = await postBracket(newAdset2Id, creativeId, "[D-TEST] ad", "PAUSED");
    console.log(`  Respuesta: code=${resp.error?.code ?? "OK"} id=${resp.id ?? "nulo"}`);
    await delay(4000);
    const ad = await findAd(newAdset2Id, "[D-TEST] ad");
    if (resp.id || ad) {
      console.log(`  ✅ Ad creado: ${resp.id ?? ad.id}`);
      await deleteEntity(resp.id ?? ad.id);
    } else {
      console.log("  ❌ Ad NO creado");
    }

    // Limpiar
    await delay(2000);
    await deleteEntity(newAdset2Id);
    await delay(1000);
    await deleteEntity(newCampaignId);
    console.log(`  Limpieza OK`);
  }

  // Limpiar adset de prueba principal
  console.log("\nLimpiando adset principal de prueba...");
  await delay(2000);
  const remainingAds = await get(`${newAdsetId}/ads`, { fields: "id,name", limit: "20" });
  for (const a of remainingAds.data ?? []) await deleteEntity(a.id);
  await deleteEntity(newAdsetId);
  console.log(`✅ Limpieza completada`);

  console.log("\n=== FIN ===");
}

main().catch(console.error);
