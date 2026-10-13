#!/usr/bin/env node
// Verificar el rol del System User en la cuenta y probar si PUT actualiza ads

const TOKEN = "EAAS6BUWUpDIBRxHXt0rWgH4qUxUR8kOel9m39ZBjXfC2ZCahGWAPPrwl67kmNHCVI7glANeGbbJmHOZBXZAIJilQ1kqBUS9XifPnLCRc2EhSGvragis6Sd4nXqZBUFTYDumyC754LqvS0TN05AEculNqTy8Y12iaZCDOx82WcSunXLAIiUjwuTbaKkaPkAPAZDZD";
const ACCOUNT_ID = "1290585793259065";
const BM_ID = "1323822102987102"; // owner del account
const SYSTEM_USER_ID = "122113683429348876";
const BASE = "https://graph.facebook.com/v21.0";

async function get(path, params = {}) {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  return res.json();
}

async function post(path, body = {}, contentType = "application/x-www-form-urlencoded") {
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
  // 1. Ver usuarios de la cuenta
  console.log("=== 1. USUARIOS DE LA AD ACCOUNT ===");
  const users = await get(`act_${ACCOUNT_ID}/users`, { fields: "id,name,role,status" });
  console.log(JSON.stringify(users, null, 2));

  // 2. Ver system users del BM dueño
  console.log("\n=== 2. SYSTEM USERS DEL BM ===");
  const systemUsers = await get(`${BM_ID}/system_users`, { fields: "id,name,role" });
  console.log(JSON.stringify(systemUsers, null, 2));

  // 3. Ver a qué cuentas tiene acceso el system user específico
  console.log("\n=== 3. AD ACCOUNTS DEL SYSTEM USER ===");
  const suAccounts = await get(`${SYSTEM_USER_ID}/assigned_ad_accounts`, { fields: "id,name,account_status,tasks" });
  console.log(JSON.stringify(suAccounts, null, 2));

  // 4. Probar si podemos hacer POST al ad existente (update de adset_id)
  console.log("\n=== 4. TEST: ¿PODEMOS ACTUALIZAR UN AD EXISTENTE? ===");
  // Obtener primer ad de la campaña activa
  const campaigns = await get(`act_${ACCOUNT_ID}/campaigns`, {
    fields: "id,name",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "1",
  });
  const campaign = campaigns.data?.[0];
  if (campaign) {
    const adsets = await get(`${campaign.id}/adsets`, { fields: "id,name", limit: "2" });
    const firstAdset = adsets.data?.[0];
    const secondAdset = adsets.data?.[1];
    if (firstAdset && secondAdset) {
      const ads = await get(`${firstAdset.id}/ads`, { fields: "id,name,status", limit: "1" });
      const testAd = ads.data?.[0];
      if (testAd) {
        console.log(`   Ad de prueba: ${testAd.id} (actualmente en adset ${firstAdset.id})`);
        console.log(`   Intentando mover a adset ${secondAdset.id}...`);
        // NOTA: Esto es solo una prueba de permisos — NO ejecutar si no estás seguro
        // const moveResult = await post(testAd.id, { adset_id: secondAdset.id });
        // console.log(JSON.stringify(moveResult, null, 2));
        console.log("   (Prueba de mover ad desactivada por seguridad)");
      }
    }
  }

  // 5. Probar endpoint alternativo: GET tasks del system user en esta cuenta
  console.log("\n=== 5. TASKS DEL SYSTEM USER EN ESTA CUENTA ===");
  const tasks = await get(`${BM_ID}/owned_ad_accounts`, {
    fields: "id,name,assigned_users{id,name,tasks}",
    filtering: JSON.stringify([{ field: "ad_account_id", operator: "EQUAL", value: ACCOUNT_ID }]),
  });
  console.log(JSON.stringify(tasks, null, 2));

  console.log("\n=== FIN ===");
}

main().catch(console.error);
