from typing import Optional, Dict, Any
from app.services import supabase_service
from app.utils.logger import get_logger

logger = get_logger("india_context_service")

async def get_context_for_device(device_id: str) -> Dict[str, Any]:
    """
    Resolves the India agricultural context for a given device.
    
    Resolution Priority:
      Farm Override -> District Dataset -> State Fallback -> Unavailable
    """
    client = supabase_service.get_client()
    
    # Default context template
    context = {
        "state": "unknown",
        "district": "unknown",
        "crop": "unknown",
        "growth_stage": "unknown",
        "soil_type": "unknown",
        "irrigation_method": "unknown",
        "irrigation_source": "unknown",
        "water_availability_class": "unknown",
        "climate_zone": "unknown",
        "major_language": "unknown",
        "mother_tongue": "unknown",
        "context_status": "unavailable",
        "weather_observations": None,
    }

    if not client:
        return context

    # 1. Get farm details for the device
    farm_res = client.table("farms").select("*").eq("device_id", device_id).execute()
    if not farm_res.data:
        logger.warning(f"No farm found for device {device_id}")
        return context

    farm = farm_res.data[0]
    
    # Populate initial context from farm
    state = farm.get("state")
    district = farm.get("district")
    crop_id = farm.get("crop_id")
    user_id = farm.get("user_id")
    
    # Fetch user's preferred language
    user_language = "English"
    if user_id:
        profile_res = client.table("profiles").select("language").eq("user_id", user_id).execute()
        if profile_res.data and profile_res.data[0].get("language"):
            user_language = profile_res.data[0]["language"]
            
    context["user_language"] = user_language
    
    context["state"] = state or "unknown"
    context["district"] = district or "unknown"
    context["crop"] = crop_id or "unknown"
    context["growth_stage"] = "vegetative"  # Default fallback, can be improved
    
    # Farm Overrides (from newly added schema columns)
    farm_soil_type = farm.get("soil_type")
    farm_climate_zone = farm.get("climate_zone")
    farm_irrigation_method = farm.get("irrigation_method")
    farm_irrigation_source = farm.get("irrigation_source")

    if not state or not district:
        return context

    context["context_status"] = "partial"

    try:
        # Resolve state_code and district_code
        loc_res = client.table("india_locations").select("state_code, district_code").eq("state", state).eq("district", district).execute()
        
        state_code = None
        district_code = None
        
        if loc_res.data:
            state_code = loc_res.data[0]["state_code"]
            district_code = loc_res.data[0]["district_code"]

        # 2. Crops Context
        if state_code and district_code and crop_id:
            crop_res = client.table("india_district_crops").select("*") \
                .eq("state_code", state_code) \
                .eq("district_code", district_code) \
                .eq("crop", crop_id).execute()
            
            if crop_res.data:
                # Crop is known in the district
                if crop_res.data[0]["data_status"] == "PROVISIONAL_STATE_PROFILE":
                    context["context_status"] = "provisional_crop"
                else:
                    context["context_status"] = "available"

        # 3. Irrigation Context
        if farm_irrigation_method:
            context["irrigation_method"] = farm_irrigation_method
        if farm_irrigation_source:
            context["irrigation_source"] = farm_irrigation_source
            
        if not farm_irrigation_method or not farm_irrigation_source:
            if state_code and district_code:
                irrig_res = client.table("india_district_irrigation").select("*") \
                    .eq("state_code", state_code) \
                    .eq("district_code", district_code).execute()
                
                if irrig_res.data:
                    row = irrig_res.data[0]
                    if not farm_irrigation_method:
                        context["irrigation_method"] = row.get("primary_irrigation_method") or "unknown"
                    if not farm_irrigation_source:
                        context["irrigation_source"] = row.get("primary_water_source") or "unknown"
                        
                    if row.get("data_status") == "PROVISIONAL_STATE_PROFILE" and context["context_status"] != "unavailable":
                        context["context_status"] = "provisional_irrigation"

        # 4. Water Availability Context
        water_res = client.table("india_district_water").select("derived_stage_class") \
            .eq("state", state) \
            .eq("district", district).execute()
        if water_res.data:
            context["water_availability_class"] = water_res.data[0].get("derived_stage_class") or "unknown"
        
        # 5. Language Context
        if state_code and district_code:
            lang_res = client.table("india_district_languages").select("*") \
                .eq("state_code", state_code) \
                .eq("district_code", district_code).execute()
            if lang_res.data:
                context["major_language"] = lang_res.data[0].get("major_language") or "unknown"
                context["mother_tongue"] = lang_res.data[0].get("mother_tongue") or "unknown"

        # 6. Soil Type & Climate Zone (from farm or default)
        if farm_soil_type:
            context["soil_type"] = farm_soil_type
        if farm_climate_zone:
            context["climate_zone"] = farm_climate_zone

        # 7. Weather Observations for Adaptive Baseline
        if state and district:
            try:
                from app.services import weather_service
                from app.config import settings
                if settings.weather_configured:
                    obs = await weather_service.get_weather_observations_for_baseline(district=district, state=state)
                    if obs:
                        context["weather_observations"] = obs
            except Exception as w_err:
                logger.warning(f"Failed to fetch weather observations for context: {w_err}")

    except Exception as e:
        logger.error(f"Error resolving India context for device {device_id}: {e}")

    return context
