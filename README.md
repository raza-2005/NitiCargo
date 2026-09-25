# NitiCargo (SIH26006)

Ministry of Steel freight intelligence dashboard — Next.js frontend + FastAPI / XGBoost backend.

## Links

- **GitHub:** https://github.com/raza-2005/NitiCargo
- **Vercel (frontend):** https://niticargo.vercel.app

## Local development

### Frontend
```bash
cd frontend
npm install
npm run dev
```

### Backend
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

## Production notes

### Frontend (Vercel)
Set `NEXT_PUBLIC_API_BASE` in Vercel to your Render API URL (e.g. `https://niticargo-api.onrender.com`).

### Backend (Render)
This repo includes `render.yaml`. Deploy from the Render dashboard Blueprint:

1. Open https://dashboard.render.com/blueprint/new?repo=https%3A%2F%2Fgithub.com%2Fraza-2005%2FNitiCargo
2. Apply the `niticargo-api` web service (free plan, `backend` root directory).
3. After deploy, copy the service URL and set it as `NEXT_PUBLIC_API_BASE` on Vercel.

Local defaults still use `http://127.0.0.1:8000`.
