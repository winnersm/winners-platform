"""Listas de campos que pedimos al Graph API y reglas de que se copia y que no."""

CAMPAIGN_FIELDS = ",".join([
    "id", "name", "account_id", "objective", "status", "effective_status",
    "buying_type", "special_ad_categories", "special_ad_category_country",
    "daily_budget", "lifetime_budget", "bid_strategy", "spend_cap",
    "start_time", "stop_time", "promoted_object", "budget_remaining",
    "is_skadnetwork_attribution", "is_adset_budget_sharing_enabled",
])

ADSET_FIELDS = ",".join([
    "id", "name", "status", "effective_status", "campaign_id",
    "daily_budget", "lifetime_budget", "billing_event", "optimization_goal",
    "optimization_sub_event", "bid_strategy", "bid_amount", "targeting",
    "promoted_object", "attribution_spec", "start_time", "end_time",
    "destination_type", "pacing_type", "is_dynamic_creative",
    "frequency_control_specs", "multi_optimization_goal_weight",
    "dsa_beneficiary", "dsa_payor",
])

CREATIVE_SUBFIELDS = ",".join([
    "id", "name", "object_story_id", "effective_object_story_id",
    "object_story_spec", "asset_feed_spec", "url_tags", "object_type",
    "degrees_of_freedom_spec", "contextual_multi_ads", "image_hash",
    "image_url", "video_id", "call_to_action_type", "instagram_user_id",
    "source_instagram_media_id", "template_url_spec",
    "link_destination_display_url", "authorization_category",
])

AD_FIELDS = ",".join([
    "id", "name", "status", "effective_status", "adset_id",
    "tracking_specs", "conversion_domain",
    "creative{{{}}}".format(CREATIVE_SUBFIELDS),
])

ACCOUNT_FIELDS = ",".join([
    "id", "name", "account_status", "currency", "timezone_name",
    "business", "disable_reason", "amount_spent", "funding_source_details",
])

# Campos del adset que NO se copian: son propiedad del objeto original,
# los recalcula Meta, o pertenecen a la cuenta de origen.
ADSET_SKIP = {
    "id", "campaign_id", "effective_status", "created_time", "updated_time",
    "budget_remaining", "recommendations", "account_id", "source_adset_id",
}

# Claves de targeting que no sobreviven a un cambio de cuenta/BM:
# apuntan a assets (audiencias, listas de bloqueo) que viven en la cuenta origen.
# (Los intereses y comportamientos SI viajan: son IDs globales de Meta.)
TARGETING_ACCOUNT_BOUND = [
    "custom_audiences",
    "excluded_custom_audiences",
    "excluded_publisher_categories",
    "excluded_publisher_list_ids",
]
