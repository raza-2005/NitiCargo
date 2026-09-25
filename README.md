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

Set `NEXT_PUBLIC_API_BASE` in Vercel to your hosted FastAPI URL (CORS already allows `*`). Without it, the UI defaults to `http://127.0.0.1:8000`.
