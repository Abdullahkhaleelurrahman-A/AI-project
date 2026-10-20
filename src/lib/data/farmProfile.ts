// =============================================================================
// Marudam — Unified Farm Profile Store (Single Source of Truth)
// =============================================================================
import { LOCATIONS, CROPS, getCropName, estimateGrowthStageId, getCropStageName } from './db';
import { isSupabaseConfigured, createClient } from '../supabase/client';
import type { Language } from '../i18n/translations';

export interface FarmProfileData {
  name: string;
  crop_id: string;
  district: string;
  state: string;
  sowing_date: string;
  device_id: string;
}

export interface FarmContextData {
  cropName: string;
  district: string;
  state: string;
  deviceId: string;
  growthStage: string;
}

const STORAGE_KEY = 'marudam-farm-profile';
const FARMER_NAME_KEY = 'marudam-farmer-name';
export const FARM_PROFILE_UPDATED_EVENT = 'marudam:farm-profile-updated';

/**
 * Returns default farm profile if nothing has ever been saved.
 * Default location is Vellore, Tamil Nadu with Brinjal.
 */
export function getDefaultFarmProfile(): FarmProfileData {
  return {
    name: 'Local Farmer',
    crop_id: 'brinjal',
    district: 'Vellore',
    state: 'Tamil Nadu',
    sowing_date: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
    device_id: 'FIELD_001',
  };
}

/**
 * Resolves the state for a given district from canonical LOCATIONS database.
 * If district is 'Vellore', returns 'Tamil Nadu'.
 */
export function getStateForDistrict(districtName: string): string {
  if (!districtName) return 'Tamil Nadu';
  const found = LOCATIONS.find(
    l => l.district.trim().toLowerCase() === districtName.trim().toLowerCase()
  );
  return found ? found.state : 'Tamil Nadu';
}

/**
 * Synchronously retrieves the stored farm profile from localStorage (browser).
 * If nothing has been saved yet, returns the default profile.
 */
export function getStoredFarmProfile(): FarmProfileData {
  if (typeof window === 'undefined') {
    return getDefaultFarmProfile();
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.crop_id && parsed.district) {
        // Ensure state is always consistent with the district
        const state = parsed.state || getStateForDistrict(parsed.district);
        return {
          name: parsed.name || localStorage.getItem(FARMER_NAME_KEY) || 'Local Farmer',
          crop_id: parsed.crop_id,
          district: parsed.district,
          state: state,
          sowing_date: parsed.sowing_date || new Date().toISOString().slice(0, 10),
          device_id: parsed.device_id || 'FIELD_001',
        };
      }
    }
  } catch (err) {
    console.warn('Error reading stored farm profile:', err);
  }

  return getDefaultFarmProfile();
}

/**
 * Builds the display-ready FarmContext object used by AppShell sidebar.
 */
export function buildFarmContext(profile: FarmProfileData, language: Language = 'English'): FarmContextData {
  const cropId = profile.crop_id || 'brinjal';
  const sowingDate = profile.sowing_date || new Date().toISOString().slice(0, 10);
  const stageId = estimateGrowthStageId(cropId, sowingDate);

  return {
    cropName: getCropName(cropId, language),
    district: profile.district || 'Vellore',
    state: profile.state || getStateForDistrict(profile.district),
    deviceId: profile.device_id || 'FIELD_001',
    growthStage: getCropStageName(cropId, stageId, language),
  };
}

/**
 * Saves updated farm profile to localStorage, syncs to Supabase if configured,
 * and broadcasts the custom event so the sidebar and all components update immediately.
 */
export async function saveFarmProfile(updates: Partial<FarmProfileData>): Promise<FarmProfileData> {
  const current = getStoredFarmProfile();
  
  // Resolve state automatically if district is changed or provided
  let resolvedState = updates.state;
  if (updates.district) {
    resolvedState = getStateForDistrict(updates.district);
  } else if (!resolvedState) {
    resolvedState = current.state || getStateForDistrict(current.district);
  }

  const updated: FarmProfileData = {
    name: updates.name ?? current.name ?? 'Local Farmer',
    crop_id: updates.crop_id ?? current.crop_id ?? 'brinjal',
    district: updates.district ?? current.district ?? 'Vellore',
    state: resolvedState,
    sowing_date: updates.sowing_date ?? current.sowing_date ?? new Date().toISOString().slice(0, 10),
    device_id: updates.device_id ?? current.device_id ?? 'FIELD_001',
  };

  // 1. Persist to localStorage
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      if (updated.name) {
        localStorage.setItem(FARMER_NAME_KEY, updated.name);
      }
    } catch (err) {
      console.warn('Could not save farm profile to localStorage:', err);
    }

    // 2. Broadcast update event so AppShell sidebar updates immediately with 0 delay
    try {
      window.dispatchEvent(
        new CustomEvent(FARM_PROFILE_UPDATED_EVENT, { detail: updated })
      );
    } catch (err) {
      console.warn('Could not dispatch farm profile update event:', err);
    }
  }

  // 3. Persist to Supabase if configured
  if (isSupabaseConfigured()) {
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        // Upsert profile name
        if (updated.name) {
          await supabase.from('profiles').update({ name: updated.name }).eq('user_id', user.id);
        }
        // Upsert farm
        await supabase.from('farms').insert({
          user_id: user.id,
          state: updated.state,
          district: updated.district,
          crop_id: updated.crop_id,
          sowing_date: updated.sowing_date,
          device_id: updated.device_id,
        });
      }
    } catch (err) {
      console.warn('Could not sync farm profile to Supabase:', err);
    }
  }

  return updated;
}
