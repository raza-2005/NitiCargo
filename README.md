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
Live API: **https://niticargo-api.onrender.com**

Dashboard: https://dashboard.render.com/web/srv-dar355m0tbcc738r746g

This repo includes `render.yaml`. Auto-deploys from `main` with root directory `backend`.

Free-tier note: the first request after idle can take ~30–60s while the instance wakes up.
