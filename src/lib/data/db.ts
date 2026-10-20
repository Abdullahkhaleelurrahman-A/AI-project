// =============================================================================
// Marudam — Agricultural Data Layer
// =============================================================================
// All canonical IDs are language-independent.
// Localized names are resolved via helper functions using the farmer's language.
// =============================================================================

import type { Language } from '../i18n/translations';
export type { Language };

// ─────────────────────────────────────────────────────────────────────────────
// LOCATIONS
// ─────────────────────────────────────────────────────────────────────────────
export interface Location {
  id: string;
  state: string;
  district: string;
  climate_zone: string;
}

export const LOCATIONS: Location[] = [
  { id: 'TN-CBE', state: 'Tamil Nadu', district: 'Coimbatore',    climate_zone: 'Tropical Wet and Dry' },
  { id: 'TN-MDU', state: 'Tamil Nadu', district: 'Madurai',       climate_zone: 'Semi-Arid' },
  { id: 'TN-SLM', state: 'Tamil Nadu', district: 'Salem',         climate_zone: 'Tropical Wet and Dry' },
  { id: 'TN-TNJ', state: 'Tamil Nadu', district: 'Thanjavur',     climate_zone: 'Coastal' },
  { id: 'TN-VEL', state: 'Tamil Nadu', district: 'Vellore',       climate_zone: 'Semi-Arid' },
  { id: 'TN-TRU', state: 'Tamil Nadu', district: 'Tiruchirapalli',climate_zone: 'Tropical Wet and Dry' },

  { id: 'KA-BLR', state: 'Karnataka', district: 'Bengaluru Urban',climate_zone: 'Tropical Savanna' },
  { id: 'KA-MYS', state: 'Karnataka', district: 'Mysuru',         climate_zone: 'Semi-Arid' },
  { id: 'KA-HAS', state: 'Karnataka', district: 'Hassan',         climate_zone: 'Tropical Monsoon' },
  { id: 'KA-DHR', state: 'Karnataka', district: 'Dharwad',        climate_zone: 'Semi-Arid' },

  { id: 'AP-VSK', state: 'Andhra Pradesh', district: 'Visakhapatnam', climate_zone: 'Tropical Wet and Dry' },
  { id: 'AP-KUR', state: 'Andhra Pradesh', district: 'Kurnool',        climate_zone: 'Semi-Arid' },
  { id: 'AP-GNT', state: 'Andhra Pradesh', district: 'Guntur',         climate_zone: 'Tropical Wet and Dry' },

  { id: 'TL-HYD', state: 'Telangana', district: 'Hyderabad',  climate_zone: 'Tropical Savanna' },
  { id: 'TL-WAR', state: 'Telangana', district: 'Warangal',   climate_zone: 'Semi-Arid' },
  { id: 'TL-KHM', state: 'Telangana', district: 'Khammam',    climate_zone: 'Tropical Wet and Dry' },

  { id: 'MH-PUN', state: 'Maharashtra', district: 'Pune',   climate_zone: 'Tropical Wet and Dry' },
  { id: 'MH-NSK', state: 'Maharashtra', district: 'Nashik', climate_zone: 'Semi-Arid' },
  { id: 'MH-NGP', state: 'Maharashtra', district: 'Nagpur', climate_zone: 'Tropical Savanna' },

  { id: 'PB-LDH', state: 'Punjab', district: 'Ludhiana', climate_zone: 'Sub-Tropical' },
  { id: 'PB-ASR', state: 'Punjab', district: 'Amritsar', climate_zone: 'Semi-Arid' },
  { id: 'PB-PAT', state: 'Punjab', district: 'Patiala',  climate_zone: 'Sub-Tropical' },
];

// ─────────────────────────────────────────────────────────────────────────────
// SEASONS (localized)
// ─────────────────────────────────────────────────────────────────────────────
export interface Season {
  id: string;
  name_en: string;
  name_hi: string;
  name_ta: string;
  name_te: string;
  name_kn: string;
}

export const SEASONS: Season[] = [
  {
    id: 'KHARIF',
    name_en: 'Kharif (Monsoon)',
    name_hi: 'खरीफ (मानसून)',
    name_ta: 'கரீஃப் (மழைக்காலம்)',
    name_te: 'ఖరీఫ్ (వర్షాకాలం)',
    name_kn: 'ಖರೀಫ್ (ಮಳೆಗಾಲ)',
  },
  {
    id: 'RABI',
    name_en: 'Rabi (Winter)',
    name_hi: 'रबी (शीतकाल)',
    name_ta: 'ராபி (குளிர்காலம்)',
    name_te: 'రబీ (చలికాలం)',
    name_kn: 'ರಬಿ (ಚಳಿಗಾಲ)',
  },
  {
    id: 'ZAID',
    name_en: 'Zaid (Summer)',
    name_hi: 'जायद (ग्रीष्मकाल)',
    name_ta: 'ஜாயத் (கோடைக்காலம்)',
    name_te: 'జాయిద్ (వేసవికాలం)',
    name_kn: 'ಜಾಯಿದ್ (ಬೇಸಿಗೆಕಾಲ)',
  },
];

export function getSeasonName(seasonId: string, language: Language): string {
  const season = SEASONS.find(s => s.id === seasonId);
  if (!season) return seasonId;
  const key = `name_${language.toLowerCase().slice(0, 2)}` as keyof Season;
  return (season[key] as string) || season.name_en;
}

// ─────────────────────────────────────────────────────────────────────────────
// GROWTH STAGES (localized)
// ─────────────────────────────────────────────────────────────────────────────
export interface GrowthStage {
  id: string;
  name_en: string;
  name_hi: string;
  name_ta: string;
  name_te: string;
  name_kn: string;
  duration_days: number;
}

export function getGrowthStageName(stageId: string, cropId: string, language: Language): string {
  const crop = CROPS[cropId];
  if (!crop) return stageId;
  const stage = crop.stages.find(s => s.id === stageId);
  if (!stage) return stageId;
  const key = `name_${language.toLowerCase().slice(0, 2)}` as keyof GrowthStage;
  return (stage[key] as string) || stage.name_en;
}

// ─────────────────────────────────────────────────────────────────────────────
// CROPS (localized)
// ─────────────────────────────────────────────────────────────────────────────
export interface Crop {
  id: string;
  name_en: string;
  name_hi: string;
  name_ta: string;
  name_te: string;
  name_kn: string;
  scientific_name: string;
  stages: GrowthStage[];
}

export const CROPS: Record<string, Crop> = {
  'tomato': {
    id: 'tomato',
    name_en: 'Tomato',
    name_hi: 'टमाटर',
    name_ta: 'தக்காளி',
    name_te: 'టొమాటో',
    name_kn: 'ಟೊಮೇಟೊ',
    scientific_name: 'Solanum lycopersicum',
    stages: [
      { id: 'seedling',   name_en: 'Seedling',   name_hi: 'अंकुरण',    name_ta: 'முளைப்பு',         name_te: 'మొలక దశ',      name_kn: 'ಮೊಳಕೆ',        duration_days: 20 },
      { id: 'vegetative', name_en: 'Vegetative', name_hi: 'वानस्पतिक', name_ta: 'வளர்ச்சி நிலை',   name_te: 'శాఖీయ దశ',     name_kn: 'ಸಸ್ಯ ಬೆಳವಣಿಗೆ', duration_days: 35 },
      { id: 'flowering',  name_en: 'Flowering',  name_hi: 'फूलन',      name_ta: 'பூக்கும் நிலை',   name_te: 'పుష్పించే దశ',  name_kn: 'ಹೂಬಿಡುವ ಹಂತ',  duration_days: 20 },
      { id: 'fruiting',   name_en: 'Fruiting',   name_hi: 'फलन',       name_ta: 'காய்க்கும் நிலை', name_te: 'ఫలించే దశ',     name_kn: 'ಹಣ್ಣಾಗುವ ಹಂತ', duration_days: 30 },
      { id: 'maturity',   name_en: 'Maturity',   name_hi: 'परिपक्वता', name_ta: 'முதிர்ச்சி நிலை', name_te: 'పక్వ దశ',       name_kn: 'ಪ್ರೌಢ ಹಂತ',    duration_days: 15 },
    ],
  },
  'brinjal': {
    id: 'brinjal',
    name_en: 'Brinjal',
    name_hi: 'बैंगन',
    name_ta: 'கத்திரிக்காய்',
    name_te: 'వంకాయ',
    name_kn: 'ಬದನೆಕಾಯಿ',
    scientific_name: 'Solanum melongena',
    stages: [
      { id: 'seedling',    name_en: 'Seedling',      name_hi: 'अंकुरण',    name_ta: 'முளைப்பு',         name_te: 'మొలక దశ',       name_kn: 'ಮೊಳಕೆ',        duration_days: 25 },
      { id: 'vegetative',  name_en: 'Vegetative',    name_hi: 'वानस्पतिक', name_ta: 'வளர்ச்சி நிலை',   name_te: 'శాఖీయ దశ',      name_kn: 'ಸಸ್ಯ ಬೆಳವಣಿಗೆ', duration_days: 35 },
      { id: 'flowering',   name_en: 'Flowering',     name_hi: 'फूलन',      name_ta: 'பூக்கும் நிலை',   name_te: 'పుష్పించే దశ',   name_kn: 'ಹೂಬಿಡುವ ಹಂತ',  duration_days: 20 },
      { id: 'fruiting',    name_en: 'Fruiting',      name_hi: 'फलन',       name_ta: 'காய்க்கும் நிலை', name_te: 'ఫలించే దశ',      name_kn: 'ಹಣ್ಣಾಗುವ ಹಂತ', duration_days: 40 },
      { id: 'maturity',    name_en: 'Maturity',      name_hi: 'परिपक्वता', name_ta: 'முதிர்ச்சி நிலை', name_te: 'పక్వ దశ',        name_kn: 'ಪ್ರೌಢ ಹಂತ',    duration_days: 20 },
    ],
  },
  'rice': {
    id: 'rice',
    name_en: 'Rice',
    name_hi: 'चावल',
    name_ta: 'நெல்',
    name_te: 'వరి',
    name_kn: 'ಭತ್ತ',
    scientific_name: 'Oryza sativa',
    stages: [
      { id: 'seedling',    name_en: 'Seedling',           name_hi: 'अंकुरण',     name_ta: 'நாற்று நிலை',      name_te: 'మొలక దశ',        name_kn: 'ಮೊಳಕೆ',          duration_days: 25 },
      { id: 'tillering',   name_en: 'Tillering',          name_hi: 'कल्लेदार',   name_ta: 'கத்திரித்தல்',    name_te: 'పిలక దశ',        name_kn: 'ಸಹಕಂಡ ಹಂತ',     duration_days: 40 },
      { id: 'panicle',     name_en: 'Panicle Initiation', name_hi: 'गुच्छे',     name_ta: 'கதிர் உருவாக்கம்', name_te: 'కంకి ప్రారంభ దశ', name_kn: 'ತೆನೆ ಆರಂಭ',    duration_days: 25 },
      { id: 'flowering',   name_en: 'Flowering',          name_hi: 'फूलन',       name_ta: 'பூக்கும் நிலை',   name_te: 'పుష్పించే దశ',   name_kn: 'ಹೂಬಿಡುವ ಹಂತ',  duration_days: 15 },
      { id: 'maturity',    name_en: 'Maturity',           name_hi: 'परिपक्वता',  name_ta: 'முதிர்ச்சி',      name_te: 'పక్వ దశ',        name_kn: 'ಪ್ರೌಢ ಹಂತ',     duration_days: 30 },
    ],
  },
  'wheat': {
    id: 'wheat',
    name_en: 'Wheat',
    name_hi: 'गेहूँ',
    name_ta: 'கோதுமை',
    name_te: 'గోధుమ',
    name_kn: 'ಗೋಧಿ',
    scientific_name: 'Triticum aestivum',
    stages: [
      { id: 'seedling',  name_en: 'Seedling',  name_hi: 'अंकुरण',    name_ta: 'முளைப்பு',       name_te: 'మొలక దశ',     name_kn: 'ಮೊಳಕೆ',        duration_days: 20 },
      { id: 'tillering', name_en: 'Tillering', name_hi: 'कल्लेदार',  name_ta: 'கத்திரித்தல்',  name_te: 'పిలక దశ',     name_kn: 'ಸಹಕಂಡ ಹಂತ',   duration_days: 40 },
      { id: 'heading',   name_en: 'Heading',   name_hi: 'शीर्षक',    name_ta: 'கதிர் உருவாக்கம்', name_te: 'తల దశ',    name_kn: 'ತಲೆ ಹಂತ',     duration_days: 30 },
      { id: 'flowering', name_en: 'Flowering', name_hi: 'फूलन',      name_ta: 'பூக்கும் நிலை', name_te: 'పుష్పించే దశ', name_kn: 'ಹೂಬಿಡುವ ಹಂತ', duration_days: 15 },
      { id: 'maturity',  name_en: 'Maturity',  name_hi: 'परिपक्वता', name_ta: 'முதிர்ச்சி',    name_te: 'పక్వ దశ',     name_kn: 'ಪ್ರೌಢ ಹಂತ',   duration_days: 35 },
    ],
  },
  'cotton': {
    id: 'cotton',
    name_en: 'Cotton',
    name_hi: 'कपास',
    name_ta: 'பருத்தி',
    name_te: 'పత్తి',
    name_kn: 'ಹತ್ತಿ',
    scientific_name: 'Gossypium',
    stages: [
      { id: 'seedling',   name_en: 'Seedling',          name_hi: 'अंकुरण',    name_ta: 'முளைப்பு',          name_te: 'మొలక దశ',         name_kn: 'ಮೊಳಕೆ',        duration_days: 20 },
      { id: 'vegetative', name_en: 'Vegetative',        name_hi: 'वानस्पतिक', name_ta: 'வளர்ச்சி நிலை',    name_te: 'శాఖీయ దశ',        name_kn: 'ಸಸ್ಯ ಬೆಳವಣಿಗೆ', duration_days: 45 },
      { id: 'squaring',   name_en: 'Squaring',          name_hi: 'वर्गाकार',  name_ta: 'மொட்டு நிலை',      name_te: 'చదరపు దశ',        name_kn: 'ಮೊಗ್ಗು ಹಂತ',   duration_days: 25 },
      { id: 'flowering',  name_en: 'Flowering',         name_hi: 'फूलन',      name_ta: 'பூக்கும் நிலை',    name_te: 'పుష్పించే దశ',    name_kn: 'ಹೂಬಿಡುವ ಹಂತ',  duration_days: 30 },
      { id: 'boll_dev',   name_en: 'Boll Development',  name_hi: 'बोल विकास', name_ta: 'காய் வளர்ச்சி',    name_te: 'కాయ అభివృద్ధి',  name_kn: 'ಕಾಯಿ ಅಭಿವೃದ್ಧಿ', duration_days: 40 },
    ],
  },
  'groundnut': {
    id: 'groundnut',
    name_en: 'Groundnut',
    name_hi: 'मूंगफली',
    name_ta: 'வேர்க்கடலை',
    name_te: 'వేరుశనగ',
    name_kn: 'ಕಡಲೆಕಾಯಿ',
    scientific_name: 'Arachis hypogaea',
    stages: [
      { id: 'seedling',   name_en: 'Seedling',   name_hi: 'अंकुरण',    name_ta: 'முளைப்பு',       name_te: 'మొలక దశ',     name_kn: 'ಮೊಳಕೆ',        duration_days: 15 },
      { id: 'vegetative', name_en: 'Vegetative', name_hi: 'वानस्पतिक', name_ta: 'வளர்ச்சி நிலை', name_te: 'శాఖీయ దశ',    name_kn: 'ಸಸ್ಯ ಬೆಳವಣಿಗೆ', duration_days: 30 },
      { id: 'flowering',  name_en: 'Flowering',  name_hi: 'फूलन',      name_ta: 'பூக்கும் நிலை', name_te: 'పుష్పించే దశ', name_kn: 'ಹೂಬಿಡುವ ಹಂತ',  duration_days: 25 },
      { id: 'pod_dev',    name_en: 'Pod Development', name_hi: 'फली विकास', name_ta: 'காய் வளர்ச்சி', name_te: 'పాడ్ అభివృద్ధి', name_kn: 'ಕೋಡು ಅಭಿವೃದ್ಧಿ', duration_days: 35 },
      { id: 'maturity',   name_en: 'Maturity',   name_hi: 'परिपक्वता', name_ta: 'முதிர்ச்சி',    name_te: 'పక్వ దశ',     name_kn: 'ಪ್ರೌಢ ಹಂತ',   duration_days: 20 },
    ],
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function getCropName(cropId: string, language: Language): string {
  const crop = CROPS[cropId];
  if (!crop) return cropId;
  const key = `name_${language.toLowerCase().slice(0, 2)}` as keyof Crop;
  return (crop[key] as string) || crop.name_en;
}

export function getCropStageName(cropId: string, stageId: string, language: Language): string {
  const crop = CROPS[cropId];
  if (!crop) return stageId;
  const stage = crop.stages.find(s => s.id === stageId);
  if (!stage) return stageId;
  const key = `name_${language.toLowerCase().slice(0, 2)}` as keyof GrowthStage;
  return (stage[key] as string) || stage.name_en;
}

// ─────────────────────────────────────────────────────────────────────────────
// CROP PROFILES (regional baseline expectations)
// ─────────────────────────────────────────────────────────────────────────────
export interface CropProfile {
  id: string;
  crop_id: string;
  growth_stage: string;
  optimal_temp_min: number;
  optimal_temp_max: number;
  soil_moisture_min: number;
  soil_moisture_max: number;
  ph_min: number;
  ph_max: number;
  ec_min: number;
  ec_max: number;
}

export const CROP_PROFILES: CropProfile[] = [
  {
    id: 'tom-seedling', crop_id: 'tomato', growth_stage: 'seedling',
    optimal_temp_min: 22, optimal_temp_max: 30,
    soil_moisture_min: 55, soil_moisture_max: 70,
    ph_min: 6.0, ph_max: 6.8, ec_min: 1.0, ec_max: 2.0
  },
  {
    id: 'tom-veg', crop_id: 'tomato', growth_stage: 'vegetative',
    optimal_temp_min: 24, optimal_temp_max: 32,
    soil_moisture_min: 50, soil_moisture_max: 70,
    ph_min: 6.0, ph_max: 6.8, ec_min: 1.5, ec_max: 2.5
  },
  {
    id: 'tom-flowering', crop_id: 'tomato', growth_stage: 'flowering',
    optimal_temp_min: 20, optimal_temp_max: 28,
    soil_moisture_min: 60, soil_moisture_max: 80,
    ph_min: 6.0, ph_max: 6.8, ec_min: 1.5, ec_max: 2.8
  },
  {
    id: 'tom-fruiting', crop_id: 'tomato', growth_stage: 'fruiting',
    optimal_temp_min: 22, optimal_temp_max: 30,
    soil_moisture_min: 55, soil_moisture_max: 75,
    ph_min: 6.0, ph_max: 6.8, ec_min: 1.5, ec_max: 2.5
  },
  {
    id: 'brn-seedling', crop_id: 'brinjal', growth_stage: 'seedling',
    optimal_temp_min: 22, optimal_temp_max: 30,
    soil_moisture_min: 55, soil_moisture_max: 70,
    ph_min: 5.5, ph_max: 6.5, ec_min: 1.0, ec_max: 2.0
  },
  {
    id: 'brn-vegetative', crop_id: 'brinjal', growth_stage: 'vegetative',
    optimal_temp_min: 25, optimal_temp_max: 35,
    soil_moisture_min: 50, soil_moisture_max: 70,
    ph_min: 5.5, ph_max: 6.8, ec_min: 1.5, ec_max: 2.5
  },
  {
    id: 'brn-flowering', crop_id: 'brinjal', growth_stage: 'flowering',
    optimal_temp_min: 25, optimal_temp_max: 32,
    soil_moisture_min: 60, soil_moisture_max: 80,
    ph_min: 5.5, ph_max: 6.8, ec_min: 1.5, ec_max: 3.0
  },
  {
    id: 'brn-fruiting', crop_id: 'brinjal', growth_stage: 'fruiting',
    optimal_temp_min: 25, optimal_temp_max: 35,
    soil_moisture_min: 55, soil_moisture_max: 75,
    ph_min: 5.5, ph_max: 6.8, ec_min: 1.5, ec_max: 2.8
  },
  {
    id: 'rice-tillering', crop_id: 'rice', growth_stage: 'tillering',
    optimal_temp_min: 25, optimal_temp_max: 35,
    soil_moisture_min: 80, soil_moisture_max: 100,
    ph_min: 5.5, ph_max: 6.5, ec_min: 1.0, ec_max: 2.0
  },
  {
    id: 'wheat-vegetative', crop_id: 'wheat', growth_stage: 'vegetative',
    optimal_temp_min: 15, optimal_temp_max: 25,
    soil_moisture_min: 40, soil_moisture_max: 65,
    ph_min: 6.0, ph_max: 7.5, ec_min: 1.0, ec_max: 2.0
  },
  {
    id: 'default', crop_id: 'default', growth_stage: 'default',
    optimal_temp_min: 22, optimal_temp_max: 30,
    soil_moisture_min: 40, soil_moisture_max: 60,
    ph_min: 6.0, ph_max: 7.0, ec_min: 1.0, ec_max: 2.0
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// LOGIC — Season, Growth Stage, Baseline
// ─────────────────────────────────────────────────────────────────────────────

export function estimateSeasonId(sowingDate: string): string {
  if (!sowingDate) return 'KHARIF';
  const month = new Date(sowingDate).getMonth() + 1;
  if (month >= 6 && month <= 10) return 'KHARIF';
  if (month >= 11 || month <= 3) return 'RABI';
  return 'ZAID';
}

/** @deprecated use estimateSeasonId + getSeasonName instead */
export function estimateSeason(sowingDate: string): string {
  return estimateSeasonId(sowingDate);
}

export function estimateGrowthStageId(cropId: string, sowingDate: string): string {
  const crop = CROPS[cropId];
  if (!crop || !sowingDate) return 'seedling';
  const diffTime = Math.abs(new Date().getTime() - new Date(sowingDate).getTime());
  const daysSinceSowing = Math.floor(diffTime / (1000 * 60 * 60 * 24));
  let cumulative = 0;
  for (const stage of crop.stages) {
    cumulative += stage.duration_days;
    if (daysSinceSowing <= cumulative) return stage.id;
  }
  return crop.stages[crop.stages.length - 1].id;
}

/** @deprecated use estimateGrowthStageId + getCropStageName instead */
export function estimateGrowthStage(cropId: string, sowingDate: string): string {
  return estimateGrowthStageId(cropId, sowingDate);
}

export function getInitialBaseline(cropId: string, growthStage: string): CropProfile {
  const profile = CROP_PROFILES.find(
    p => p.crop_id === cropId && p.growth_stage === growthStage
  );
  return profile ?? CROP_PROFILES.find(p => p.id === 'default')!;
}

// Kept for dashboard backward compat — now a thin wrapper
export const MOCK_FARMER_PROFILE = {
  name: '',
  language: 'English',
  state: '',
  district: '',
  cropId: 'tomato',
  sowingDate: '',
};

export const STATES = Array.from(new Set(LOCATIONS.map(l => l.state))).sort();
