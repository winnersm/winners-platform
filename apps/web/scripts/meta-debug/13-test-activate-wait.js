#!/usr/bin/env node
// Test final: activar adset copiado, esperar 30-60s, intentar crear ad

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

async function postBracket(adsetId, creativeId, name) {
  const url = new URL(`${BASE}/act_${ACCOUNT_ID}/ads`);
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

async function setStatus(entityId, status) {
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
  const json = await get(`${adsetId}/ads`, { fields: "id,name", limit: "20" });
  return (json.data ?? []).find(a => a.name === name);
}

async function waitUntilNotInProcess(adsetId) {
  for (let i = 0; i < 30; i++) {
    await delay(5000);
    const s = await get(adsetId, { fields: "effective_status" });
    if (s.effective_status !== "IN_PROCESS") return s.effective_status;
  }
  return "TIMEOUT";
}

async function main() {
  // Setup
  const campaigns = await get(`act_${ACCOUNT_ID}/campaigns`, {
    fields: "id,name",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "1",
  });
  const campaign = campaigns.data[0];
  const adsets = await get(`${campaign.id}/adsets`, { fields: "id,name", limit: "1" });
  const origAdset = adsets.data[0];
  const origAds = await get(`${origAdset.id}/ads`, { fields: "id,name,creative{id}", limit: "1" });
  const creativeId = origAds.data[0].creative.id;

  console.log(`Campaña: ${campaign.id}`);
  console.log(`Adset original: ${origAdset.id}`);
  console.log(`Creative: ${creativeId}\n`);

  // Crear adset de prueba en la campaña ACTIVA (no en nueva campaña)
  console.log("Creando adset de prueba en campaña ACTIVA...");
  const t0 = Date.now();
  const copyResp = await postJSON(`${origAdset.id}/copies`, {
    campaign_id: campaign.id, // ← campaña ACTIVA
    status_option: "PAUSED",
  });
  const newAdsetId = copyResp.copied_adset_id ?? copyResp.id;
  if (!newAdsetId) { console.log("Error:", JSON.stringify(copyResp)); return; }
  console.log(`Adset: ${newAdsetId}`);

  // Esperar que salga de IN_PROCESS
  console.log("Esperando que salga de IN_PROCESS...");
  const finalStatus = await waitUntilNotInProcess(newAdsetId);
  const elapsedInitial = Math.round((Date.now() - t0) / 1000);
  console.log(`Salió a: ${finalStatus} en ${elapsedInitial}s\n`);

  // Intentar crear ad en el adset PAUSED de la campaña ACTIVA
  console.log("TEST 1: Bracket en adset PAUSED (campaña ACTIVA)");
  {
    const adName = "[T1] ad";
    const resp = await postBracket(newAdsetId, creativeId, adName);
    console.log(`  Respuesta: code=${resp.error?.code ?? "OK"}`);
    await delay(4000);
    const ad = await findAd(newAdsetId, adName);
    if (resp.id || ad) {
      console.log(`  ✅ ÉXITO: ${resp.id ?? ad?.id}`);
      await deleteEntity(resp.id ?? ad?.id);
    } else {
      console.log("  ❌ No creado");
    }
  }

  await delay(2000);

  // Activar el adset y esperar 30 segundos
  console.log("\nActivando adset y esperando 30s...");
  const actResp = await setStatus(newAdsetId, "ACTIVE");
  console.log(`  Resultado: ${JSON.stringify(actResp)}`);

  const tActivated = Date.now();

  // Poll en intervalos para probar ad creation después de cada wait
  const waits = [5, 10, 20, 30, 60];
  let created = false;

  for (const waitSec of waits) {
    const toWait = (waitSec * 1000) - (Date.now() - tActivated);
    if (toWait > 0) await delay(toWait);
    const elapsed = Math.round((Date.now() - tActivated) / 1000);

    const status = await get(newAdsetId, { fields: "status,effective_status" });
    console.log(`\nTEST post-activación ${elapsed}s: status=${status.status} effective=${status.effective_status}`);

    const adName = `[T-${waitSec}s] ad`;
    const resp = await postBracket(newAdsetId, creativeId, adName);
    console.log(`  Respuesta: code=${resp.error?.code ?? "OK"}`);

    await delay(4000);
    const ad = await findAd(newAdsetId, adName);
    if (resp.id || ad) {
      const adId = resp.id ?? ad?.id;
      console.log(`  ✅ AD CREADO después de ${elapsed}s de activación! ID: ${adId}`);
      await deleteEntity(adId);
      created = true;
      break;
    } else {
      console.log(`  ❌ No creado a los ${elapsed}s`);
    }
    await delay(1000);
  }

  // Pausar el adset de nuevo
  console.log("\nPausando adset de prueba...");
  await setStatus(newAdsetId, "PAUSED");

  // Limpiar
  await delay(2000);
  const remainingAds = await get(`${newAdsetId}/ads`, { fields: "id,name", limit: "20" });
  for (const a of remainingAds.data ?? []) await deleteEntity(a.id);
  await deleteEntity(newAdsetId);
  console.log(`Adset ${newAdsetId} eliminado`);

  console.log(`\n========== CONCLUSIÓN ==========`);
  if (created) {
    console.log(`✅ La solución: activar adset, esperar N segundos, crear ad, pausar`);
  } else {
    console.log(`❌ Incluso con activación no funciona en ventana de 60s`);
    console.log(`   → Puede necesitar más tiempo de propagación post-activación`);
  }
  console.log("================================\n");
}

main().catch(console.error);
