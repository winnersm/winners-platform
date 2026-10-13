#!/usr/bin/env node
// Test de solución final: copiar adset como ACTIVE desde el inicio
// ¿El tiempo de espera es menor que activando después?

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
  const form = new URLSearchParams({ status });
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

async function tryCreateAdWithVerification(adsetId, creativeId, adName) {
  const resp = await postBracket(adsetId, creativeId, adName);
  const directId = resp.id;

  // Siempre verificar si el ad fue creado (incluso con error 2)
  await delay(4000);
  const verifiedAd = await findAd(adsetId, adName);
  const createdId = directId ?? verifiedAd?.id;

  return { created: !!createdId, id: createdId, errorCode: resp.error?.code };
}

async function main() {
  console.log("=== SOLUCIÓN FINAL: Adset copiado como ACTIVE desde el inicio ===\n");

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

  console.log(`Campaña ACTIVA: ${campaign.id}`);
  console.log(`Adset original: ${origAdset.id}`);
  console.log(`Creative: ${creativeId}\n`);

  // === Escenario: Copiar adset con status_option ACTIVE ===
  console.log("Copiando adset con status_option=ACTIVE...");
  const t0 = Date.now();

  const copyResp = await postJSON(`${origAdset.id}/copies`, {
    campaign_id: campaign.id,
    status_option: "ACTIVE", // ← ACTIVE desde el inicio
  });
  const newAdsetId = copyResp.copied_adset_id ?? copyResp.id;
  if (!newAdsetId) { console.log("Error:", JSON.stringify(copyResp)); return; }
  console.log(`Adset: ${newAdsetId}`);

  // Poll cada 5s hasta que salga de IN_PROCESS
  let lastStatus = "IN_PROCESS";
  let exitTime = 0;
  for (let i = 0; i < 60; i++) {
    await delay(5000);
    const s = await get(newAdsetId, { fields: "status,effective_status" });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`  [${elapsed}s] status=${s.status} effective=${s.effective_status}`);

    if (s.effective_status !== "IN_PROCESS") {
      lastStatus = s.effective_status;
      exitTime = elapsed;

      // Intentar crear ad INMEDIATAMENTE después de salir de IN_PROCESS
      console.log(`\n  → Salió de IN_PROCESS a los ${elapsed}s. Intentando crear ad INMEDIATAMENTE...`);
      const r0 = await tryCreateAdWithVerification(newAdsetId, creativeId, "[IMMEDIATE] ad");
      console.log(`  [${elapsed}s] Inmediato: ${r0.created ? "✅ CREADO " + r0.id : "❌ No creado (error " + r0.errorCode + ")"}`);

      if (r0.created) {
        await deleteEntity(r0.id);
        console.log("\n✅ SOLUCIÓN RÁPIDA: No hace falta esperar tiempo adicional!");
        break;
      }

      // Si no funcionó inmediatamente, intentar en intervalos
      const waitPoints = [10, 20, 30, 60, 90, 120];
      let created = false;

      for (const waitSec of waitPoints) {
        const toWait = (waitSec * 1000) - (Date.now() - (t0 + exitTime * 1000));
        if (toWait > 0) {
          console.log(`  Esperando ${Math.round(toWait / 1000)}s más...`);
          await delay(toWait);
        }
        const currentElapsed = Math.round((Date.now() - t0) / 1000);
        const currentStatus = await get(newAdsetId, { fields: "status,effective_status" });
        const adName = `[+${waitSec}s] ad`;

        const result = await tryCreateAdWithVerification(newAdsetId, creativeId, adName);
        console.log(`  [${currentElapsed}s total / ${waitSec}s post-exit] status=${currentStatus.effective_status}: ${result.created ? "✅ CREADO " + result.id : "❌ No (error " + result.errorCode + ")"}`);

        if (result.created) {
          await deleteEntity(result.id);
          created = true;
          console.log(`\n✅ Ad creado después de ${waitSec}s post-IN_PROCESS!`);
          break;
        }
        await delay(1000);
      }

      if (!created) {
        console.log("\n❌ No se pudo crear ad incluso después de 120s post-IN_PROCESS");
      }

      break;
    }
  }

  // Pausar el adset
  console.log("\nPausando adset...");
  await setStatus(newAdsetId, "PAUSED");

  // Limpiar
  await delay(2000);
  const remainingAds = await get(`${newAdsetId}/ads`, { fields: "id,name", limit: "20" });
  for (const a of remainingAds.data ?? []) await deleteEntity(a.id);
  await deleteEntity(newAdsetId);
  console.log(`✅ Limpieza OK`);

  const totalTime = Math.round((Date.now() - t0) / 1000);
  console.log(`\nTest completado en ${totalTime}s`);
}

main().catch(console.error);
