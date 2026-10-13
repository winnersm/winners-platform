#!/usr/bin/env node
// Test definitivo: bracket notation (form-urlencoded) vs JSON para crear ads
// Con verificación posterior de si el ad realmente se creó (para detectar falsos errores)

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

async function postBracket(path, adsetId, creativeId, name) {
  // La forma exacta que funcionó en script 05
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  const form = new URLSearchParams();
  form.set("name", name);
  form.set("adset_id", adsetId);
  form.set("creative[creative_id]", creativeId);
  form.set("status", "PAUSED");
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
  const json = await get(`${adsetId}/ads`, { fields: "id,name,status", limit: "20" });
  return (json.data ?? []).find(a => a.name === name);
}

async function testAdCreation(adsetId, creativeId, label) {
  console.log(`\n--- ${label} ---`);
  const adName = `[TEST-${label}] ad`;

  // JSON format
  console.log("  JSON format:");
  const jsonResp = await postJSON(`act_${ACCOUNT_ID}/ads`, {
    name: adName + " JSON",
    adset_id: adsetId,
    creative: { creative_id: creativeId },
    status: "PAUSED",
  });
  console.log(`    Respuesta: code=${jsonResp.error?.code ?? "OK"} id=${jsonResp.id ?? "nulo"}`);
  await delay(4000); // esperar por si se creó de forma asíncrona
  const jsonAd = await findAd(adsetId, adName + " JSON");
  if (jsonResp.id || jsonAd) {
    const adId = jsonResp.id ?? jsonAd.id;
    console.log(`    ✅ Ad JSON CREADO: ${adId}`);
    await deleteEntity(adId);
  } else {
    console.log(`    ❌ Ad JSON NO creado`);
  }

  await delay(2000);

  // Bracket form-urlencoded format
  console.log("  BRACKET form-urlencoded format:");
  const bracketResp = await postBracket(`act_${ACCOUNT_ID}/ads`, adsetId, creativeId, adName + " BRACKET");
  console.log(`    Respuesta: code=${bracketResp.error?.code ?? "OK"} id=${bracketResp.id ?? "nulo"}`);
  await delay(4000); // esperar por si se creó de forma asíncrona
  const bracketAd = await findAd(adsetId, adName + " BRACKET");
  if (bracketResp.id || bracketAd) {
    const adId = bracketResp.id ?? bracketAd.id;
    console.log(`    ✅ Ad BRACKET CREADO: ${adId}`);
    await deleteEntity(adId);
  } else {
    console.log(`    ❌ Ad BRACKET NO creado`);
  }
}

async function main() {
  console.log("=== TEST DEFINITIVO: JSON vs BRACKET NOTATION ===\n");

  // 1. Datos base
  const campaigns = await get(`act_${ACCOUNT_ID}/campaigns`, {
    fields: "id,name",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "1",
  });
  const campaign = campaigns.data[0];
  const adsets = await get(`${campaign.id}/adsets`, { fields: "id,name,status,effective_status", limit: "1" });
  const origAdset = adsets.data[0];
  const origAds = await get(`${origAdset.id}/ads`, { fields: "id,name,creative{id}", limit: "1" });
  const origCreativeId = origAds.data[0].creative.id;

  console.log(`Adset original: ${origAdset.id} (${origAdset.effective_status})`);
  console.log(`Creative: ${origCreativeId}`);

  // TEST 1: En el adset original (ACTIVE)
  await testAdCreation(origAdset.id, origCreativeId, "ADSET-ORIGINAL-ACTIVE");

  // TEST 2: En un adset nuevo que espera a PAUSED
  console.log("\nCreando adset de prueba...");
  const t0 = Date.now();
  const copyResp = await postJSON(`${origAdset.id}/copies`, {
    campaign_id: campaign.id,
    status_option: "PAUSED",
  });
  const newAdsetId = copyResp.copied_adset_id ?? copyResp.id;
  if (!newAdsetId) {
    console.log("Error:", JSON.stringify(copyResp));
    return;
  }
  console.log(`Adset nuevo: ${newAdsetId} — esperando a PAUSED...`);

  // Poll hasta PAUSED
  let ready = false;
  while (!ready) {
    await delay(5000);
    const status = await get(newAdsetId, { fields: "effective_status" });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`  [${elapsed}s] ${status.effective_status}`);
    if (status.effective_status !== "IN_PROCESS") ready = true;
  }
  const totalWait = Math.round((Date.now() - t0) / 1000);
  console.log(`Adset PAUSED después de ${totalWait}s`);

  await testAdCreation(newAdsetId, origCreativeId, "ADSET-NUEVO-PAUSED");

  // Limpiar
  await delay(2000);
  await deleteEntity(newAdsetId);
  console.log(`\nAdset ${newAdsetId} eliminado`);

  console.log("\n=== FIN DEL TEST ===");
}

main().catch(console.error);
