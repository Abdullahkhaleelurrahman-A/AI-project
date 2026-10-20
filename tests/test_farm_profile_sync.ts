// Test unified farm profile logic, state resolution, and simulated event dispatch
import { 
  getStateForDistrict, 
  getDefaultFarmProfile, 
  buildFarmContext, 
  getStoredFarmProfile, 
  saveFarmProfile,
  FARM_PROFILE_UPDATED_EVENT 
} from '../src/lib/data/farmProfile';
import { CROPS, LOCATIONS } from '../src/lib/data/db';

console.log('--- Testing Farm Profile & State Resolution ---');

// 1. Test District -> State auto-resolution
const velloreState = getStateForDistrict('Vellore');
console.log(`District: Vellore -> State: "${velloreState}"`);
if (velloreState !== 'Tamil Nadu') {
  throw new Error(`Expected Tamil Nadu for Vellore, got ${velloreState}`);
}

const coimbatoreState = getStateForDistrict('Coimbatore');
console.log(`District: Coimbatore -> State: "${coimbatoreState}"`);
if (coimbatoreState !== 'Tamil Nadu') {
  throw new Error(`Expected Tamil Nadu for Coimbatore, got ${coimbatoreState}`);
}

const mysuruState = getStateForDistrict('Mysuru');
console.log(`District: Mysuru -> State: "${mysuruState}"`);
if (mysuruState !== 'Karnataka') {
  throw new Error(`Expected Karnataka for Mysuru, got ${mysuruState}`);
}

// 2. Test Default Profile
const def = getDefaultFarmProfile();
console.log('Default profile:', def);
if (def.district !== 'Vellore' || def.state !== 'Tamil Nadu' || def.crop_id !== 'brinjal') {
  throw new Error(`Unexpected default profile: ${JSON.stringify(def)}`);
}

// 3. Test buildFarmContext
const context = buildFarmContext({
  name: 'Local Farmer',
  crop_id: 'brinjal',
  district: 'Vellore',
  state: 'Tamil Nadu',
  sowing_date: new Date().toISOString().slice(0, 10),
  device_id: 'FIELD_001',
}, 'English');

console.log('FarmContext for Brinjal & Vellore:', context);
if (context.cropName !== 'Brinjal' || context.district !== 'Vellore' || context.state !== 'Tamil Nadu') {
  throw new Error(`Unexpected farm context: ${JSON.stringify(context)}`);
}

// 4. Test Simulated Browser Environment (Window + localStorage + CustomEvent)
const mockStorage: Record<string, string> = {};
let dispatchedEventDetail: any = null;

(global as any).window = {
  dispatchEvent: (event: any) => {
    if (event.type === FARM_PROFILE_UPDATED_EVENT) {
      dispatchedEventDetail = event.detail;
    }
  }
};

(global as any).localStorage = {
  getItem: (key: string) => mockStorage[key] || null,
  setItem: (key: string, val: string) => { mockStorage[key] = val; },
  removeItem: (key: string) => { delete mockStorage[key]; },
};

(global as any).CustomEvent = class CustomEvent {
  type: string;
  detail: any;
  constructor(type: string, params?: { detail: any }) {
    this.type = type;
    this.detail = params?.detail;
  }
};

async function testSave() {
  console.log('Testing saveFarmProfile in simulated browser environment...');
  
  // Save Crop = Brinjal and District = Vellore
  const updated = await saveFarmProfile({
    crop_id: 'brinjal',
    district: 'Vellore',
    sowing_date: '2026-10-01',
    device_id: 'FIELD_001',
  });

  console.log('Saved result:', updated);
  if (updated.state !== 'Tamil Nadu') {
    throw new Error(`Expected State to be Tamil Nadu, got: ${updated.state}`);
  }
  if (updated.crop_id !== 'brinjal') {
    throw new Error(`Expected Crop to be brinjal, got: ${updated.crop_id}`);
  }
  if (updated.district !== 'Vellore') {
    throw new Error(`Expected District to be Vellore, got: ${updated.district}`);
  }

  // Check event was dispatched
  if (!dispatchedEventDetail || dispatchedEventDetail.crop_id !== 'brinjal' || dispatchedEventDetail.district !== 'Vellore') {
    throw new Error(`Event was not dispatched properly: ${JSON.stringify(dispatchedEventDetail)}`);
  }
  console.log('✓ CustomEvent dispatched successfully to all listeners with detail:', dispatchedEventDetail);

  // Check read back from stored profile
  const stored = getStoredFarmProfile();
  console.log('Read back from stored profile:', stored);
  if (stored.crop_id !== 'brinjal' || stored.district !== 'Vellore' || stored.state !== 'Tamil Nadu') {
    throw new Error(`Stored profile does not match saved data: ${JSON.stringify(stored)}`);
  }
  console.log('✓ Persistence verified in localStorage');
}

testSave().then(() => {
  console.log('=== ALL FARM SYNC UNIT & INTEGRATION TESTS PASSED ===');
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
