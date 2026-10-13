#!/usr/bin/env node
// Inspección COMPLETA del creative para entender qué campos deprecados tiene
// y cómo construir uno nuevo limpio

const TOKEN = "EAAS6BUWUpDIBRxHXt0rWgH4qUxUR8kOel9m39ZBjXfC2ZCahGWAPPrwl67kmNHCVI7glANeGbbJmHOZBXZAIJilQ1kqBUS9XifPnLCRc2EhSGvragis6Sd4nXqZBUFTYDumyC754LqvS0TN05AEculNqTy8Y12iaZCDOx82WcSunXLAIiUjwuTbaKkaPkAPAZDZD";
const ACCOUNT_ID = "1290585793259065";
const BASE = "https://graph.facebook.com/v21.0";

// Creative ID del ad que inspeccionamos
const CREATIVE_ID = "1690571432002936";

async function get(path, params = {}) {
  const url = new URL(`${BASE}/${path}`);
  url.searchParams.set("access_token", TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  const json = await res.json();
  if (json.error) throw new Error(`API Error ${json.error.code}: ${json.error.message}\n${JSON.stringify(json.error, null, 2)}`);
  return json;
}

async function main() {
  // 1. Obtener el creativo con TODOS los campos relevantes
  console.log("=== CREATIVE COMPLETO ===\n");

  const creative = await get(CREATIVE_ID, {
    fields: [
      "id",
      "name",
      "object_type",
      "status",
      "asset_feed_spec",
      "object_story_spec",
      "object_story_id",
      "instagram_actor_id",
      "instagram_user_id",
      "instagram_permalink_url",
      "thumbnail_url",
      "effective_object_story_id",
      "call_to_action_type",
      "url_tags",
      "use_page_actor_override",
      "dynamic_ad_voice",
      "degrees_of_freedom_spec",
    ].join(","),
  });

  console.log("CAMPOS DEL CREATIVE:");
  console.log(`  id: ${creative.id}`);
  console.log(`  name: ${creative.name}`);
  console.log(`  object_type: ${creative.object_type}`);
  console.log(`  status: ${creative.status}`);
  console.log(`  object_story_id: ${creative.object_story_id}`);
  console.log(`  effective_object_story_id: ${creative.effective_object_story_id}`);
  console.log(`  instagram_actor_id: ${creative.instagram_actor_id}`);
  console.log(`  instagram_user_id: ${creative.instagram_user_id}`);
  console.log(`  use_page_actor_override: ${creative.use_page_actor_override}`);
  console.log(`  dynamic_ad_voice: ${creative.dynamic_ad_voice}`);
  console.log(`  call_to_action_type: ${creative.call_to_action_type}`);
  console.log(`  url_tags: ${creative.url_tags}`);

  if (creative.degrees_of_freedom_spec) {
    console.log(`  degrees_of_freedom_spec: ${JSON.stringify(creative.degrees_of_freedom_spec)}`);
  }

  if (creative.object_story_spec) {
    console.log(`\n  object_story_spec keys: ${Object.keys(creative.object_story_spec).join(", ")}`);
    if (creative.object_story_spec.page_id) {
      console.log(`  object_story_spec.page_id: ${creative.object_story_spec.page_id}`);
    }
    console.log(`  object_story_spec completo:\n${JSON.stringify(creative.object_story_spec, null, 4)}`);
  }

  if (creative.asset_feed_spec) {
    const afs = creative.asset_feed_spec;
    console.log(`\n  asset_feed_spec CLAVES TOP-LEVEL: ${Object.keys(afs).join(", ")}`);
    console.log(`  - bodies: ${afs.bodies?.length ?? 0}`);
    console.log(`  - titles: ${afs.titles?.length ?? 0}`);
    console.log(`  - videos: ${afs.videos?.length ?? 0}`);
    console.log(`  - images: ${afs.images?.length ?? 0}`);
    console.log(`  - call_to_action_types: ${JSON.stringify(afs.call_to_action_types)}`);
    console.log(`  - optimization_type: ${afs.optimization_type}`);
    console.log(`  - enhancements: ${JSON.stringify(afs.enhancements)}`);
    console.log(`  - asset_customization_rules: ${afs.asset_customization_rules ? `${afs.asset_customization_rules.length} reglas` : "ninguna"}`);
    console.log(`  - ad_formats: ${JSON.stringify(afs.ad_formats)}`);

    // Buscar campos de "standard enhancements" — qué claves desconocidas hay
    const knownKeys = ["bodies", "titles", "videos", "images", "call_to_action_types", "descriptions", "link_urls", "captions", "ad_formats", "optimization_type", "enhancements", "asset_customization_rules", "adlabels", "additional_data"];
    const unknownKeys = Object.keys(afs).filter((k) => !knownKeys.includes(k));
    if (unknownKeys.length) {
      console.log(`\n  ⚠️  CLAVES DESCONOCIDAS EN asset_feed_spec (posibles deprecated):`);
      for (const k of unknownKeys) {
        console.log(`     ${k}: ${JSON.stringify(afs[k])}`);
      }
    }

    // Primer body completo
    if (afs.bodies?.[0]) {
      console.log(`\n  Primer body completo: ${JSON.stringify(afs.bodies[0], null, 4)}`);
    }
    // Primer video completo
    if (afs.videos?.[0]) {
      console.log(`\n  Primer video completo: ${JSON.stringify(afs.videos[0], null, 4)}`);
    }
    // Primer title completo
    if (afs.titles?.[0]) {
      console.log(`\n  Primer title completo: ${JSON.stringify(afs.titles[0], null, 4)}`);
    }
  }

  // 2. Obtener el effective_object_story_id para ver la estructura de la story
  if (creative.effective_object_story_id) {
    console.log(`\n\n=== OBJECT STORY (${creative.effective_object_story_id}) ===`);
    try {
      const [pageId] = creative.effective_object_story_id.split("_");
      console.log(`  Page ID extraído: ${pageId}`);
    } catch (e) {
      console.log(`  No se pudo parsear effective_object_story_id`);
    }
  }

  // 3. Dump completo del creative para referencia
  console.log("\n\n=== DUMP COMPLETO (sin asset_feed_spec extenso) ===");
  const dumpCreative = { ...creative };
  if (dumpCreative.asset_feed_spec) {
    dumpCreative.asset_feed_spec = {
      ...dumpCreative.asset_feed_spec,
      bodies: `[${dumpCreative.asset_feed_spec.bodies?.length} bodies - truncado]`,
      titles: `[${dumpCreative.asset_feed_spec.titles?.length} titles - truncado]`,
    };
  }
  console.log(JSON.stringify(dumpCreative, null, 2));
}

main().catch(console.error);
