# Security Architecture

## 1. Environment Variables & Secret Handling

MARUDAM strictly enforces separation of concerns between public frontend API keys and backend service roles.

### Frontend (`.env.local`)
- **`NEXT_PUBLIC_SUPABASE_URL`**: Safe to expose in the browser. Points to the Supabase instance.
- **`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`**: Safe to expose. Subject to Row Level Security (RLS). Cannot write or read sensitive data unless RLS policies permit it.
- **`OPENAI_API_KEY`**: **WARNING**: This is currently located in `.env.local`. It MUST NOT be prefixed with `NEXT_PUBLIC_` to prevent it from leaking into the client bundle. The Next.js API routes or the local FastAPI backend should handle Gemini calls.

### Backend (`backend/.env`)
- **`SUPABASE_SERVICE_ROLE_KEY`**: Highly sensitive. Grants root access to the Supabase database, bypassing all RLS policies. It is used strictly by the FastAPI backend to insert sensor readings and baselines. NEVER exposed to the frontend.
- **`GEMINI_API_KEY`**: Highly sensitive. Used by `ai_service.py` to generate Chat responses.

## 2. Supabase Row Level Security (RLS)

By default, Supabase tables are secure and reject all requests.

1. **Backend Inserts**: The Python backend uses the Service Role Key, meaning it is not blocked by RLS.
2. **Frontend Reads**: A custom script (`setup_rls.sql`) was created to explicitly apply `GRANT SELECT` and `CREATE POLICY ... FOR SELECT USING (true)` on the `sensor_readings`, `anomalies`, `devices`, and `farms` tables. This allows the Vercel frontend to fetch the dashboard data without throwing a `401 Unauthorized` error.
3. **Data Modification**: The dashboard is intentionally read-only. No RLS policies exist that allow public `INSERT`, `UPDATE`, or `DELETE`.

## 3. Network and CORS

- **FastAPI CORS**: Configured via `CORS_ORIGINS` in `.env`. By default, only allows `http://localhost:3000` to prevent malicious cross-origin requests to the local hardware integration server.
