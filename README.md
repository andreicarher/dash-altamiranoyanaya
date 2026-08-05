# Dashboard Comercial v2 — Altamirano & Anaya (ActionCoach)

Dashboard conectado en vivo a Google Sheets (sin backend, sin CSV manual).

## Fuente de datos
Google Sheet: `1mPDFUo38I4r7KlKyBvEvl9VCLsaZgifHSMUKYEaa14A`
Pestañas usadas: `Query-Meta`, `Query-Google`, `Base ZOHO OPS 2026`.
El Sheet debe seguir compartido como "Cualquier persona con el enlace" para que el
fetch desde el navegador funcione sin login.

## Cómo subir esto a GitHub (repo nuevo)

```bash
git init
git add .
git commit -m "Dashboard v2 - conexión en vivo a Google Sheets"
git branch -M main
git remote add origin https://github.com/<tu-usuario>/<nombre-del-repo>.git
git push -u origin main
```

## Cómo correrlo en local (opcional, para probar antes de subir)

```bash
npm install
npm run dev
```

Abre lo que indique la terminal (normalmente http://localhost:5173).

## Cómo desplegar en Vercel

1. Entra a vercel.com → "Add New Project" → importa este repo de GitHub.
2. Vercel detecta automáticamente que es un proyecto Vite (Framework Preset: Vite).
   No hace falta configurar nada más — build command `npm run build`, output `dist`.
3. Deploy. Cada vez que hagas push a `main`, Vercel actualiza el sitio solo.

## Actualizar datos
No hace falta actualizar nada en el código. Los datos se leen en vivo del Google
Sheet cada vez que alguien abre el dashboard. Solo mantén las pestañas actualizadas.

## Estructura
```
├── index.html          punto de entrada HTML
├── package.json        dependencias (react, recharts, papaparse, vite)
├── vite.config.js       config del bundler
└── src/
    ├── main.jsx         monta la app de React
    └── App.jsx          todo el dashboard (fetch + lógica + UI)
```
