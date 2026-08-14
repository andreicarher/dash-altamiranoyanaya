// Función serverless de Vercel. Corre en el servidor, NUNCA en el navegador
// del visitante — por eso el token vive en variables de ambiente y jamás
// llega al bundle de React.
//
// Variables de ambiente requeridas en Vercel (Project Settings → Environment
// Variables):
//   META_ACCESS_TOKEN   — token de un System User de Business Manager, con
//                         permiso ads_read sobre la cuenta de Altamirano & Anaya.
//                         Un token de System User NO expira (a diferencia de
//                         un token de usuario normal, que caduca ~60 días).
//   META_AD_ACCOUNT_ID  — 683428495438424 (sin el prefijo "act_")
//
// Uso desde el frontend:
//   GET /api/meta-ads-performance?date_from=2026-07-01&date_to=2026-08-11

const API_VERSION = "v21.0";

// Tipos de "acción" de Meta que consideramos el "Resultado" de la campaña.
// Coinciden con la conversión de "lead en el sitio web", que es el objetivo
// configurado en las campañas de A&A. Si algún día el objetivo cambia (por
// ejemplo a mensajes de WhatsApp), hay que agregar ese action_type aquí.
const RESULT_ACTION_TYPES = [
  "offsite_conversion.fb_pixel_lead",
  "onsite_conversion.lead_grouped",
  "onsite_web_lead",
  "lead",
];

async function fetchAllPages(url) {
  const out = [];
  let next = url;
  while (next) {
    const res = await fetch(next);
    const json = await res.json();
    if (json.error) {
      throw new Error(`Meta API error: ${json.error.message} (code ${json.error.code})`);
    }
    out.push(...(json.data || []));
    next = json.paging && json.paging.next ? json.paging.next : null;
  }
  return out;
}

function mapStatus(effectiveStatus) {
  if (!effectiveStatus) return { label: "Desconocido", kind: "unknown" };
  if (effectiveStatus.includes("ACTIVE")) return { label: "Activo", kind: "active" };
  if (effectiveStatus.includes("PAUSED")) return { label: "Pausado", kind: "paused" };
  if (effectiveStatus.includes("DELETED") || effectiveStatus.includes("ARCHIVED")) {
    return { label: "Eliminado", kind: "paused" };
  }
  return { label: effectiveStatus, kind: "other" };
}

export default async function handler(req, res) {
  const token = process.env.META_ACCESS_TOKEN;
  const adAccountId = process.env.META_AD_ACCOUNT_ID;

  if (!token || !adAccountId) {
    res.status(500).json({
      error:
        "Faltan variables de ambiente META_ACCESS_TOKEN y/o META_AD_ACCOUNT_ID en Vercel. Ve a Project Settings → Environment Variables.",
    });
    return;
  }

  const { date_from, date_to } = req.query;
  if (!date_from || !date_to) {
    res.status(400).json({ error: "Faltan los parámetros date_from y date_to (formato YYYY-MM-DD)." });
    return;
  }

  const fields = [
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
    "spend",
    "reach",
    "impressions",
    "clicks",
    "frequency",
    "unique_ctr",
    "actions",
    "cost_per_action_type",
  ].join(",");

  const timeRange = encodeURIComponent(JSON.stringify({ since: date_from, until: date_to }));

  try {
    // 1) Métricas de desempeño del período (varían según el filtro de fechas).
    const insightsUrl =
      `https://graph.facebook.com/${API_VERSION}/act_${adAccountId}/insights` +
      `?level=ad&fields=${fields}&time_range=${timeRange}&limit=500&access_token=${token}`;
    const insightsRows = await fetchAllPages(insightsUrl);

    // 2) Estado ACTUAL de cada anuncio (Activo/Pausado). Esto es un atributo
    //    de "ahora", no cambia según el rango de fechas seleccionado.
    const statusUrl =
      `https://graph.facebook.com/${API_VERSION}/act_${adAccountId}/ads` +
      `?fields=id,effective_status&limit=500&access_token=${token}`;
    const statusRows = await fetchAllPages(statusUrl);
    const statusById = {};
    statusRows.forEach((a) => {
      statusById[a.id] = a.effective_status;
    });

    const rows = insightsRows.map((r) => {
      const actions = r.actions || [];
      const costs = r.cost_per_action_type || [];
      let resultado = 0;
      let costoPorResultado = null;
      let resultTypeUsed = null;
      for (const t of RESULT_ACTION_TYPES) {
        const found = actions.find((a) => a.action_type === t);
        if (found) {
          resultado = parseFloat(found.value) || 0;
          resultTypeUsed = t;
          const c = costs.find((a) => a.action_type === t);
          costoPorResultado = c ? parseFloat(c.value) : null;
          break;
        }
      }
      const status = mapStatus(statusById[r.ad_id]);
      return {
        campaignId: r.campaign_id,
        campaignName: r.campaign_name,
        adsetId: r.adset_id,
        adsetName: r.adset_name,
        adId: r.ad_id,
        adName: r.ad_name,
        statusLabel: status.label,
        statusKind: status.kind,
        spend: parseFloat(r.spend || 0),
        reach: parseInt(r.reach || 0, 10),
        impressions: parseInt(r.impressions || 0, 10),
        clicks: parseInt(r.clicks || 0, 10),
        frequency: parseFloat(r.frequency || 0),
        uniqueCtr: parseFloat(r.unique_ctr || 0),
        resultado,
        costoPorResultado,
        resultTypeUsed,
      };
    });

    rows.sort((a, b) => b.spend - a.spend);

    // Cache de 5 minutos en el edge de Vercel — evita pegarle a la API de
    // Meta en cada refresh si varias personas ven el dashboard al mismo tiempo.
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({ rows, dateFrom: date_from, dateTo: date_to });
  } catch (err) {
    res.status(500).json({ error: err.message || String(err) });
  }
}
