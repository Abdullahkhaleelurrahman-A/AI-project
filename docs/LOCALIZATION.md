# Localization (i18n)

MARUDAM strongly prioritizes Indian local language support to maximize accessibility for farmers across diverse linguistic regions.

## 1. Supported Languages
The system supports exactly 22 scheduled Indian languages, plus English:

`en` (English), `hi` (Hindi), `ta` (Tamil), `te` (Telugu), `mr` (Marathi), `gu` (Gujarati), `bn` (Bengali), `pa` (Punjabi), `kn` (Kannada), `ml` (Malayalam), `or` (Odia), `as` (Assamese), `ur` (Urdu), `sa` (Sanskrit), `ks` (Kashmiri), `ne` (Nepali), `sd` (Sindhi), `kok` (Konkani), `doi` (Dogri), `mai` (Maithili), `sat` (Santali), `mni` (Manipuri), `bho` (Bhojpuri).

## 2. Implementation Mechanism
- **File Structure:** `src/lib/i18n/locales/*.ts`
- **Canonical Schema:** English (`en.ts`) acts as the source of truth for all keys.
- **Loading:** The Next.js application uses a custom lightweight translation hook (`useTranslation`) rather than a heavy library like `i18next`.
- **RTL Detection:** The system includes automated Right-To-Left directionality switching, particularly vital for `ur` (Urdu) and `ks` (Kashmiri).

## 3. Translation Keys
Dictionaries are strongly typed in TypeScript to prevent missing translations from crashing the UI at runtime.
Categories include:
- `common`: Navigation, generic buttons (Save, Cancel).
- `dashboard`: Sensor names, statuses.
- `auth`: Login, registration prompts.
- `settings`: Profile updates, language selectors.

## 4. Maintenance Script
A python script `backend/scripts/translate_locales.py` was implemented using Google Gemini to automatically populate the 22 language files from the canonical English template, ensuring 100% key coverage.
