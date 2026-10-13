#!/usr/bin/env node
// Diagnóstico: verificar permisos del token y si POST /ads funciona con cualquier payload

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

async function rawPost(path, body, contentType = "application/json") {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: contentType === "application/json" ? JSON.stringify(body) : new URLSearchParams(Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v)]))).toString(),
  });
  return res.json();
}

async function main() {
  console.log("=== 1. DEBUG TOKEN ===");
  const debug = await get("debug_token", { input_token: TOKEN });
  if (debug.data) {
    const d = debug.data;
    console.log(`  type: ${d.type}`);
    console.log(`  app_id: ${d.app_id}`);
    console.log(`  user_id: ${d.user_id}`);
    console.log(`  expires_at: ${d.expires_at ? new Date(d.expires_at * 1000).toISOString() : "never"}`);
    console.log(`  is_valid: ${d.is_valid}`);
    console.log(`  scopes: ${d.scopes?.join(", ")}`);
    console.log(`  granular_scopes: ${JSON.stringify(d.granular_scopes?.map(s => s.scope))}`);
  } else {
    console.log("  No se pudo debuggear el token (necesita app_access_token)");
    console.log(`  Respuesta: ${JSON.stringify(debug)}`);
  }

  console.log("\n=== 2. VERIFICAR ACCESO A LA CUENTA ===");
  const account = await get(`act_${ACCOUNT_ID}`, { fields: "id,name,account_status,disable_reason,owner" });
  console.log(`  id: ${account.id}`);
  console.log(`  name: ${account.name}`);
  console.log(`  status: ${account.account_status}`);
  console.log(`  disable_reason: ${account.disable_reason}`);
  console.log(`  owner: ${account.owner}`);

  console.log("\n=== 3. VERIFICAR PERMISOS EN LA CUENTA ===");
  const perms = await get(`act_${ACCOUNT_ID}`, { fields: "user_role,user_tos_accepted" });
  console.log(`  user_role: ${perms.user_role}`);
  console.log(`  Full: ${JSON.stringify(perms)}`);

  // Obtener un creativo existente que haya creado el token actual
  console.log("\n=== 4. CREATIVOS DE LA CUENTA ===");
  const creativos = await get(`act_${ACCOUNT_ID}/adcreatives`, {
    fields: "id,name,status",
    limit: "3",
  });
  console.log(`  ${JSON.stringify(creativos)}`);

  // Crear creativo de prueba mínimo (imagen simple)
  console.log("\n=== 5. CREAR CREATIVO MÍNIMO DE PRUEBA ===");
  const minCreative = await rawPost(`act_${ACCOUNT_ID}/adcreatives`, {
    name: "[MIN-TEST] creative",
    object_story_spec: {
      page_id: "1064665993406543",
      link_data: {
        link: "https://www.example.com",
        message: "Test message",
        name: "Test title",
        description: "Test desc",
        image_hash: null,
      },
    },
  });
  console.log(`  Resultado: ${JSON.stringify(minCreative)}`);

  // Obtener un adset existente para prueba minimal de ad
  console.log("\n=== 6. TEST MÍNIMO DE POST /ads ===");
  const campaigns = await get(`act_${ACCOUNT_ID}/campaigns`, {
    fields: "id,name",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "1",
  });
  const campaign = campaigns.data?.[0];

  if (campaign) {
    const adsets = await get(`${campaign.id}/adsets`, { fields: "id,name", limit: "1" });
    const adset = adsets.data?.[0];
    const ads = await get(`${adset.id}/ads`, { fields: "id,name,creative{id}", limit: "1" });
    const existingAd = ads.data?.[0];
    const existingCreativeId = existingAd?.creative?.id;

    if (existingCreativeId && adset) {
      console.log(`  Usando creative existente: ${existingCreativeId}, adset: ${adset.id}`);

      // Test A: JSON body
      const testA = await rawPost(`act_${ACCOUNT_ID}/ads`, {
        name: "[MIN-TEST-A] ad",
        adset_id: adset.id,
        creative: { creative_id: existingCreativeId },
        status: "PAUSED",
      });
      console.log(`  Test A (JSON body): ${JSON.stringify(testA)}`);

      await delay(2000);

      // Test B: form-urlencoded bracket notation
      const testB = await rawPost(`act_${ACCOUNT_ID}/ads`, {
        name: "[MIN-TEST-B] ad",
        adset_id: adset.id,
        "creative[creative_id]": existingCreativeId,
        status: "PAUSED",
      }, "application/x-www-form-urlencoded");
      console.log(`  Test B (form bracket): ${JSON.stringify(testB)}`);

      // Si alguno tuvo éxito, limpiarlo
      if (testA.id) {
        await delay(1000);
        const delUrl = new URL(`${BASE}/${testA.id}`);
        delUrl.searchParams.set("access_token", TOKEN);
        await fetch(delUrl.toString(), { method: "DELETE" });
        console.log(`  (limpiado ad ${testA.id})`);
      }
      if (testB.id) {
        await delay(1000);
        const delUrl = new URL(`${BASE}/${testB.id}`);
        delUrl.searchParams.set("access_token", TOKEN);
        await fetch(delUrl.toString(), { method: "DELETE" });
        console.log(`  (limpiado ad ${testB.id})`);
      }
    }
  }

  console.log("\n=== DIAGNÓSTICO COMPLETADO ===");
}

main().catch(console.error);
