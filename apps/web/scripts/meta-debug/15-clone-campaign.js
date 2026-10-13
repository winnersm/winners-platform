#!/usr/bin/env node
// Clonar campaña completa con nuevo token — prueba de rate limit independiente

const TOKEN = "EAAdx2E7n4wsBR8X4WfzUCMIu7JZCZBmiVLUViNwPtH7AD76UDcqhsKb5cNt2tBRWIQk9sz5KnAxt0R3S8p4c4kw8k71tZBZANBoYiV15Ec4BaBdbOeeJwGcf3U4QRdnj0SyIC8pWKeVDZAZCRKolmIkmhzH6lVw4YuaUpE3eZA2SaZBmKvzDQzKaZBUSlv5p6bAZDZD";
const ACCOUNT_ID = "1290585793259065";
const CAMPAIGN_ID = "120247571828700378";
const BASE = "https://graph.facebook.com/v21.0";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params = {}, retries = 4) {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url.toString());
    const json = await res.json();
    if (!json.error) return json;
    const code = json.error.code;
    console.error(`  [GET /${path}] intento ${attempt + 1} → ${code}: ${json.error.message}`);
    if (code === 17 && attempt < retries) {
      const wait = 5000 * Math.pow(2, attempt);
      console.warn(`  Rate limit (17), esperando ${wait / 1000}s...`);
      await delay(wait);
      continue;
    }
    throw new Error(`Meta API error ${code}: ${json.error.message}`);
  }
}

async function post(path, body) {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  const encoded = new URLSearchParams(Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]))).toString();
  for (let attempt = 0; attempt <= 3; attempt++) {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: encoded,
    });
    const json = await res.json();
    if (!json.error) return json;
    const code = json.error.code;
    console.error(`  [POST /${path}] intento ${attempt + 1} → ${code}: ${json.error.message}`);
    if ((code === 2 || code === 1) && attempt < 3) {
      await delay(1000 * (attempt + 1));
      continue;
    }
    throw new Error(`Meta API error ${code}: ${json.error.message}`);
  }
}

async function postBracket(adsetId, creativeId, name) {
  const url = new URL(`${BASE}/act_${ACCOUNT_ID}/ads`);
  url.searchParams.set("access_token", TOKEN);
  const form = new URLSearchParams();
  form.set("name", name);
  form.set("adset_id", adsetId);
  form.set("creative[creative_id]", creativeId);
  form.set("status", "PAUSED");

  for (let attempt = 0; attempt <= 4; attempt++) {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const json = await res.json();
    if (json.id) return json.id;

    const code = json.error?.code;
    const subcode = json.error?.error_subcode;

    if (code === 2 || code === 1) {
      await delay(5000);
      try {
        const adsJson = await get(`${adsetId}/ads`, { fields: "id,name", limit: "100" }, 0);
        const found = (adsJson.data ?? []).find(a => a.name === name);
        if (found) { console.log(`  ✅ Ad "${name}" creado (verificado por GET): ${found.id}`); return found.id; }
      } catch {
        console.warn(`  ⚠️ Verificación falló por rate limit para "${name}" — asumiendo creado`);
        return "unverified";
      }
    }

    if (code === 100 && subcode === 1487833 && attempt < 4) {
      console.warn(`  CDN error "${name}", reintentando en 60s (intento ${attempt + 1}/4)...`);
      await delay(60000);
      continue;
    }

    console.error(`  ❌ Ad "${name}" falló: code=${code} subcode=${subcode}`);
    return null;
  }
  return null;
}

async function setStatus(entityId, status) {
  const url = new URL(`${BASE}/${entityId}`);
  url.searchParams.set("access_token", TOKEN);
  await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ status }).toString(),
  });
}

async function main() {
  console.log("=== CLONE CAMPAÑA con nuevo token ===\n");

  // FASE 1: Obtener nombre de campaña original
  const campInfo = await get(CAMPAIGN_ID, { fields: "id,name" });
  const newName = `[Copia] ${campInfo.name}`;
  console.log(`Campaña original: ${campInfo.name}`);

  // FASE 2: Copiar campaña como ACTIVE
  console.log(`\nCopiando campaña como ACTIVE...`);
  const campCopy = await post(`${CAMPAIGN_ID}/copies`, { name: newName, status_option: "ACTIVE" });
  const newCampaignId = campCopy.copied_campaign_id ?? campCopy.id;
  console.log(`✅ Nueva campaña: ${newCampaignId}`);

  // FASE 3: Obtener adsets originales
  console.log(`\nObteniendo adsets originales...`);
  const adsetsJson = await get(`${CAMPAIGN_ID}/adsets`, { fields: "id,name", limit: "200" });
  const origAdsets = adsetsJson.data ?? [];
  console.log(`${origAdsets.length} adsets encontrados`);

  // FASE 4: Copiar adsets
  console.log(`\nCopiando adsets en paralelo...`);
  const adsetResults = await Promise.all(origAdsets.map(async (adset) => {
    try {
      const r = await post(`${adset.id}/copies`, { campaign_id: newCampaignId, status_option: "ACTIVE" });
      const newId = r.copied_adset_id ?? r.id;
      console.log(`  ✅ ${adset.name} → ${newId}`);
      return { origId: adset.id, newId };
    } catch (e) {
      console.error(`  ❌ Falló copiar adset ${adset.id}: ${e.message}`);
      return null;
    }
  }));
  const adsetMap = adsetResults.filter(Boolean);
  console.log(`\n${adsetMap.length}/${origAdsets.length} adsets copiados`);

  // FASE 5: Un solo GET al primer adset original para obtener nombre y creative ID
  console.log(`\nObteniendo creative del primer adset original...`);
  const firstOrigId = adsetMap[0].origId;
  const firstAdsJson = await get(`${firstOrigId}/ads`, { fields: "id,name,creative{id}", limit: "1" });
  const firstAd = (firstAdsJson.data ?? []).find(a => a.creative?.id);
  if (!firstAd) { console.error("❌ No se encontró ad en el primer adset original"); return; }
  const sharedAd = { name: firstAd.name, creativeId: firstAd.creative.id };
  console.log(`  ✅ Creative ID: ${sharedAd.creativeId} | Nombre: "${sharedAd.name}"`);

  // FASE 6: Poll IN_PROCESS en paralelo
  console.log(`\nEsperando que salgan de IN_PROCESS...`);
  await Promise.all(adsetMap.map(async ({ newId }) => {
    for (let i = 0; i < 60; i++) {
      await delay(5000);
      try {
        const s = await get(newId, { fields: "effective_status" });
        if (s.effective_status !== "IN_PROCESS") return;
      } catch {}
    }
    console.warn(`  ⚠️ Adset ${newId} tardó >5 min en salir de IN_PROCESS`);
  }));

  console.log(`Settling 15s post-IN_PROCESS...`);
  await delay(15000);

  // FASE 7: Crear ads en paralelo
  console.log(`\nCreando ads en paralelo...`);
  const adResults = await Promise.all(adsetMap.map(async ({ newId }, i) => {
    const adId = await postBracket(newId, sharedAd.creativeId, sharedAd.name);
    if (adId) console.log(`  ✅ [${i + 1}/25] Ad "${sharedAd.name}": ${adId}`);
    else console.log(`  ❌ [${i + 1}/25] Adset ${newId} falló`);
    return { newId, adId };
  }));

  const failed = adResults.filter(r => !r.adId).map(r => r.newId);
  const unverified = adResults.filter(r => r.adId === "unverified").map(r => r.newId);
  let adsOk = adResults.filter(r => r.adId && r.adId !== "unverified").length;

  // FASE 8: Segundo pase — verificar unverified y reintentar fallidos
  const needsCheck = [...unverified, ...failed];
  if (needsCheck.length > 0) {
    console.log(`\nSegundo pase: ${needsCheck.length} adsets a verificar/reintentar...`);
    console.log(`Esperando 30s para que baje el rate limit...`);
    await delay(30000);

    for (const newId of needsCheck) {
      // Primero verificar si el ad ya existe
      try {
        const check = await get(`${newId}/ads`, { fields: "id,name", limit: "10" }, 1);
        const existing = (check.data ?? []).find(a => a.name === sharedAd.name);
        if (existing) {
          console.log(`  ✅ [verificado] Adset ${newId}: ad ya existe → ${existing.id}`);
          adsOk++;
          continue;
        }
      } catch {}

      // No existe → reintentar
      const adId = await postBracket(newId, sharedAd.creativeId, sharedAd.name);
      if (adId) {
        adsOk++;
        console.log(`  ✅ [reintento] Adset ${newId}: ${adId}`);
      } else {
        console.log(`  ❌ [reintento] Adset ${newId}: falló de nuevo`);
      }
      await delay(1000);
    }
  }

  // FASE 9: Pausar campaña
  console.log(`\nPausando campaña nueva...`);
  await setStatus(newCampaignId, "PAUSED");

  console.log(`\n=== COMPLETADO: ${adsetMap.length} adsets, ${adsOk}/${adsetMap.length} ads ===`);
  console.log(`Nueva campaña ID: ${newCampaignId}`);
}

main().catch(console.error);
