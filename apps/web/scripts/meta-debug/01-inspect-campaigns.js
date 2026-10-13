#!/usr/bin/env node
// Script de diagnóstico: lista campañas activas y muestra estructura completa de ads
// Uso: node 01-inspect-campaigns.js

const TOKEN = "EAAS6BUWUpDIBRxHXt0rWgH4qUxUR8kOel9m39ZBjXfC2ZCahGWAPPrwl67kmNHCVI7glANeGbbJmHOZBXZAIJilQ1kqBUS9XifPnLCRc2EhSGvragis6Sd4nXqZBUFTYDumyC754LqvS0TN05AEculNqTy8Y12iaZCDOx82WcSunXLAIiUjwuTbaKkaPkAPAZDZD";
const ACCOUNT_ID = "1290585793259065";
const BASE = "https://graph.facebook.com/v21.0";

async function get(path, params = {}) {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const json = await res.json();
  if (json.error) {
    console.error(`ERROR /${path}:`, JSON.stringify(json.error, null, 2));
    return null;
  }
  return json;
}

async function main() {
  console.log("=== CAMPAÑAS ACTIVAS ===\n");

  const campaigns = await get(`act_${ACCOUNT_ID}/campaigns`, {
    fields: "id,name,status,objective",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "10",
  });

  if (!campaigns?.data?.length) {
    console.log("No hay campañas activas. Listando todas:");
    const all = await get(`act_${ACCOUNT_ID}/campaigns`, { fields: "id,name,status", limit: "5" });
    console.log(JSON.stringify(all?.data, null, 2));
    return;
  }

  console.log(`${campaigns.data.length} campañas activas encontradas:\n`);
  for (const c of campaigns.data) {
    console.log(`[${c.id}] ${c.name} (${c.status} / ${c.objective})`);
  }

  // Tomar la primera campaña activa e inspeccionar sus ads
  const campaign = campaigns.data[0];
  console.log(`\n=== INSPECCIONANDO: ${campaign.name} (${campaign.id}) ===\n`);

  const adsets = await get(`${campaign.id}/adsets`, {
    fields: "id,name,status",
    limit: "5",
  });

  if (!adsets?.data?.length) {
    console.log("Sin adsets");
    return;
  }

  console.log(`Adsets encontrados: ${adsets.data.length} (mostrando hasta 3)\n`);

  for (const adset of adsets.data.slice(0, 3)) {
    console.log(`\n--- Adset: ${adset.name} (${adset.id}) ---`);

    const ads = await get(`${adset.id}/ads`, {
      fields: "id,name,status,creative{id,name,object_type,asset_feed_spec,body,title,image_url,video_id,object_story_spec,use_page_actor_override,dynamic_ad_voice}",
      limit: "5",
    });

    if (!ads?.data?.length) {
      console.log("  Sin ads");
      continue;
    }

    for (const ad of ads.data) {
      console.log(`\n  Ad: ${ad.name} (${ad.id})`);
      console.log(`  Creative ID: ${ad.creative?.id}`);
      console.log(`  Creative object_type: ${ad.creative?.object_type}`);

      if (ad.creative?.asset_feed_spec) {
        const afs = ad.creative.asset_feed_spec;
        console.log(`  ⚠️  TIENE asset_feed_spec (Dynamic Creative / Multi-idioma):`);
        console.log(`     - bodies: ${afs.bodies?.length ?? 0}`);
        console.log(`     - titles: ${afs.titles?.length ?? 0}`);
        console.log(`     - images: ${afs.images?.length ?? 0}`);
        console.log(`     - videos: ${afs.videos?.length ?? 0}`);
        console.log(`     - call_to_action_types: ${JSON.stringify(afs.call_to_action_types)}`);
        if (afs.bodies) {
          console.log(`     - body langs: ${afs.bodies.map(b => b.adlabels?.map(l => l.name).join(',') || 'sin_label').join(' | ')}`);
        }
      } else if (ad.creative?.object_story_spec) {
        console.log(`  object_story_spec keys: ${Object.keys(ad.creative.object_story_spec).join(', ')}`);
      } else {
        console.log(`  Creative body: ${ad.creative?.body?.substring(0, 80)}`);
      }
    }
  }

  // Inspección profunda del primer ad
  console.log("\n\n=== INSPECCIÓN PROFUNDA DEL PRIMER AD ===\n");
  const firstAdset = adsets.data[0];
  const firstAds = await get(`${firstAdset.id}/ads`, {
    fields: "id,name,creative{id,name,object_type,asset_feed_spec,body,title,image_url,video_id,object_story_spec,use_page_actor_override,dynamic_ad_voice,instagram_actor_id,instagram_permalink_url,status}",
    limit: "1",
  });

  if (firstAds?.data?.[0]) {
    const ad = firstAds.data[0];
    console.log("AD COMPLETO:");
    console.log(JSON.stringify(ad, null, 2));
  }
}

main().catch(console.error);
