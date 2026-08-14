import React, { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from "recharts";

/* =========================================================================
   DASHBOARD COMERCIAL v2 — Altamirano & Anaya (ActionCoach) / Rockin
   Fuente de datos: Google Sheets en vivo (sin backend, sin upload manual)
   ID del Sheet: 1mPDFUo38I4r7KlKyBvEvl9VCLsaZgifHSMUKYEaa14A
   Pestañas usadas:
     - "Query-Meta"          -> inversión Meta Ads (nivel anuncio, diario)
     - "Query-Google"        -> inversión Google Ads (nivel campaña, diario)
     - "Base ZOHO OPS 2026"  -> leads / pipeline comercial

   SUPUESTOS CONFIRMADOS CON ANDREI (04-ago-2026):
     1. Query-Google no trae columna de año -> se asume que TODA la data de
        esa pestaña es 2026. Si en el futuro hay datos de 2027 en esa misma
        pestaña, este dashboard los contará como 2026 (hay que revisar).
     2. "Fuentes pagadas" = campo `Fuente de Sospechoso` en {Rockin, Facebook
        Ads, Instagram}. No se usa utm_source para esta clasificación.
   ========================================================================= */

const SHEET_ID = "1mPDFUo38I4r7KlKyBvEvl9VCLsaZgifHSMUKYEaa14A";
const TABS_SOURCE = {
  // OJO: la pestaña real se llama "Query-Meta " CON UN ESPACIO al final.
  // Sin ese espacio, Google Sheets no encuentra coincidencia exacta y
  // devuelve silenciosamente la PRIMERA pestaña del archivo (el resumen
  // mensual) en vez de un error — así se perdía toda la inversión de Meta.
  meta: "Query-Meta ",
  google: "Query-Google",
  zoho: "Base ZOHO OPS 2026",
};
const csvUrl = (sheetName) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;

const ASSUMED_YEAR_GOOGLE = 2026;
// Andrei confirmó (05-ago-2026) que solo se debe usar data de 2026 en todo
// el dashboard — hay algunos leads viejos en el CRM con fecha corrupta o de
// años anteriores (ej. 2022) que deben excluirse. Si el próximo año quieres
// incluir 2027, actualiza este valor (o conviértelo en un rango).
const VALID_YEAR = 2026;
const PAID_SOURCES = ["rockin", "facebook ads", "instagram"];
const NO_CONTACTADO_FASE = "identificación de sospechoso";
const SEGUIMIENTO_FINAL_FASE = "seguimiento final";
const PROGRAMA_ACEPTADO_FASE = "programa aceptado";

// Paleta extraída directamente del manual de identidad AltamiranoAnaya.2024
// (valores vectoriales exactos, no aproximados a ojo):
//   Azul marino  #245193  — color primario del isotipo
//   Azul vivo    #3B4BA7  — variante de aplicación del isotipo
//   Rojo carmesí #D1193F  — color secundario (versión sello / franja roja)
//   Gris carbón  #515254  — franja inferior del manual, usado aquí como texto
// Tipografía: Source Sans Pro es la fuente real que Illustrator dejó
// embebida en el PDF de marca (texto de apoyo del manual). Playfair
// Display se usa solo en títulos como eco editorial del logotipo serif
// de alto contraste — no se intenta clonar el logotipo, que está
// vectorizado a mano.
const COLORS = {
  bg: "#F7F7F8",
  bgCard: "#FFFFFF",
  bgCardAlt: "#F1F2F5",
  border: "#E2E4E9",
  navy: "#245193",
  navyDeep: "#1B3D70",
  blue: "#3B4BA7",
  crimson: "#D1193F",
  green: "#1E8A4C",
  red: "#D1193F",
  yellow: "#C77D0A",
  muted: "#6B6D72",
  text: "#211D1D",
  // alias para no romper referencias existentes a COLORS.gold/teal
  gold: "#245193",
  teal: "#3B4BA7",
};

const CHART_COLORS = [COLORS.navy, COLORS.crimson, COLORS.blue, COLORS.yellow, COLORS.green, "#8A8D93"];

const FONT_DISPLAY = "'Playfair Display', Georgia, serif";
const FONT_BODY = "'Source Sans Pro', 'Segoe UI', system-ui, sans-serif";

const THRESHOLDS = {
  noContactado: { green: 50, yellow: 70 }, // < verde, <= amarillo, > rojo
  cplPagado: { green: 300, yellow: 500 },
  miniCod: { green: 40, yellow: 20 }, // > verde, >= amarillo, < rojo (invertido)
  diasSF: { green: 35, yellow: 65 },
};

/* -------------------------------------------------------------------------
   HELPERS DE PARSEO
   ------------------------------------------------------------------------- */

function toNumber(v) {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") return v;
  const cleaned = String(v).replace(/[$%\s]/g, "").replace(/,/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function normalize(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // quita acentos
}

// Acepta "3/08/2026", "03/08/26", "4/08/2026 1:00 PM", etc.
function parseDMY(str) {
  if (!str) return null;
  const s = String(str).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (!m) return null;
  let [, d, mo, y] = m;
  d = parseInt(d, 10);
  mo = parseInt(mo, 10);
  y = parseInt(y, 10);
  if (y < 100) y += 2000;
  const dt = new Date(y, mo - 1, d);
  return isNaN(dt.getTime()) ? null : dt;
}

function isFilled(v) {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

const MESES_ABREV = {
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5,
  jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11,
};

// Las columnas "Date" de Query-Meta/Query-Google vienen como "4-ago"
// (día-mes abreviado en español, sin año). Combinamos con el año que sí
// tenemos por otra columna para reconstruir una fecha real y así poder
// filtrar por rango de fechas exacto (no solo por mes/semana).
function parseSpanishAbbrevDate(str, year) {
  if (!str || !year) return null;
  const m = String(str).trim().toLowerCase().match(/^(\d{1,2})-([a-záéíóúñ]{3,4})/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const mon = MESES_ABREV[m[2].slice(0, 3)];
  if (mon === undefined) return null;
  const d = new Date(year, mon, day);
  return isNaN(d.getTime()) ? null : d;
}

// Semana ISO (lunes a domingo) — misma convención que usa Meta/ZOHO
// en sus columnas "Week (Starting on Monday)" / "SEMANA CREACIÓN".
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// Encuentra el valor de una fila probando varias claves candidatas (por si
// Papaparse renombra headers duplicados con sufijos _1, _2...)
function pick(row, candidates) {
  for (const c of candidates) {
    if (row[c] !== undefined) return row[c];
  }
  return undefined;
}

// Devuelve filas como OBJETOS, pero construidos a mano tomando SIEMPRE la
// PRIMERA columna que coincide con cada nombre de encabezado. Esto evita el
// bug de Papaparse con hojas que repiten encabezados (p. ej. "Query-Google"
// trae dos tablas pegadas, ambas con columnas "Month"/"Week"/"Campaign").
async function fetchCsv(sheetName) {
  const res = await fetch(csvUrl(sheetName));
  if (!res.ok) {
    throw new Error(
      `No se pudo leer la pestaña "${sheetName}" (HTTP ${res.status}). Verifica que el Google Sheet siga compartido como "Cualquier persona con el enlace".`
    );
  }
  const text = await res.text();
  const parsed = Papa.parse(text, { header: false, skipEmptyLines: true });
  const raw = parsed.data;
  if (!raw.length) return [];

  const headerRow = raw[0];
  const firstIndexOf = {};
  headerRow.forEach((h, i) => {
    const key = String(h || "").trim();
    if (key && !(key in firstIndexOf)) firstIndexOf[key] = i;
  });

  const rows = [];
  for (let i = 1; i < raw.length; i++) {
    const arr = raw[i];
    const obj = {};
    for (const key in firstIndexOf) {
      obj[key] = arr[firstIndexOf[key]];
    }
    rows.push(obj);
  }
  return rows;
}

// Si el nombre de una pestaña no coincide EXACTO (mayúsculas, espacios,
// etc.), Google Sheets no da error — regresa silenciosamente la PRIMERA
// pestaña del archivo. Esta validación evita que eso pase inadvertido:
// revisa que las columnas esperadas realmente existan en lo que llegó.
function assertColumns(rows, requiredCols, sheetName) {
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const missing = requiredCols.filter((c) => !cols.includes(c));
  if (missing.length) {
    throw new Error(
      `La pestaña "${sheetName}" no trae las columnas esperadas (falta: ${missing.join(", ")}). ` +
        `Esto casi siempre significa que el nombre de la pestaña cambió o tiene espacios/mayúsculas ` +
        `distintas a lo configurado, y Google Sheets regresó otra pestaña por error. Columnas recibidas: ` +
        `${cols.slice(0, 8).join(", ")}${cols.length > 8 ? "…" : ""}`
    );
  }
}

/* -------------------------------------------------------------------------
   PROCESAMIENTO: INVERSIÓN
   ------------------------------------------------------------------------- */

// Nombres EXACTOS de campaña de Google Ads activas al momento de construir
// esto (confirmado por Andrei el 05-ago-2026). Cualquier campaña que no
// matchee ninguna de las dos cae en "otras" — así, si mañana se crea una
// campaña nueva, no se clasifica mal en silencio, se ve aparte y hay que
// mapearla a mano aquí.
const GOOGLE_CAMPAIGN_MAP = {
  "ro_mx_lea_pro_desafio": "search",
  "ro_mx_awa_bra_youtube canal": "youtube",
};
function classifyGoogleCampaign(campaignName) {
  const norm = normalize(campaignName);
  return GOOGLE_CAMPAIGN_MAP[norm] || "otras";
}

function processMetaInvestment(rows) {
  // columnas: Year, Month, Date, Week (Starting on Monday), Campaign name, ..., Total Cost, ..., Website leads
  const out = [];
  for (const r of rows) {
    const year = parseInt(pick(r, ["Year"]), 10);
    const month = parseInt(pick(r, ["Month"]), 10);
    const week = parseInt(pick(r, ["Week (Starting on Monday)", "Week"]), 10);
    const cost = toNumber(pick(r, ["Total Cost"]));
    const websiteLeads = toNumber(pick(r, ["Website leads"]));
    if (!year || year !== VALID_YEAR || !month) continue;
    const date = parseSpanishAbbrevDate(pick(r, ["Date"]), year);
    out.push({ year, month, week: isNaN(week) ? null : week, date, cost, websiteLeads, canal: "Meta" });
  }
  return out;
}

function processGoogleInvestment(rows) {
  // primer bloque: Date, Week (Starting on Monday), Month, Campaign, ..., Cost, Conversions, ...
  const out = [];
  for (const r of rows) {
    const month = parseInt(pick(r, ["Month"]), 10);
    const week = parseInt(pick(r, ["Week (Starting on Monday)", "Week"]), 10);
    const cost = toNumber(pick(r, ["Cost"]));
    const conversions = toNumber(pick(r, ["Conversions"]));
    const campaign = pick(r, ["Campaign"]) || "";
    if (!month) continue;
    const date = parseSpanishAbbrevDate(pick(r, ["Date"]), ASSUMED_YEAR_GOOGLE);
    out.push({
      year: ASSUMED_YEAR_GOOGLE,
      month,
      week: isNaN(week) ? null : week,
      date,
      cost,
      conversions,
      campaign,
      googleChannel: classifyGoogleCampaign(campaign),
      canal: "Google",
    });
  }
  return out;
}

/* -------------------------------------------------------------------------
   PROCESAMIENTO: LEADS ZOHO
   ------------------------------------------------------------------------- */

function processZohoLeads(rows) {
  const out = [];
  for (const r of rows) {
    const idRegistro = pick(r, ["ID de registro"]);
    if (!isFilled(idRegistro)) continue;

    const fuente = pick(r, ["Fuente de Sospechoso"]) || "";
    const fuenteNorm = normalize(fuente);
    const paid = PAID_SOURCES.includes(fuenteNorm);

    const fase = pick(r, ["Fase"]) || "";
    const faseNorm = normalize(fase);

    const horaCreacion = parseDMY(pick(r, ["Hora de creación"]));
    const horaModificacion = parseDMY(pick(r, ["Hora de modificación"]));

    let anioCreacion = parseInt(pick(r, ["AÑO CREACIÓN"]), 10) || (horaCreacion ? horaCreacion.getFullYear() : null);
    let mesCreacion = parseInt(pick(r, ["MES CREACIÓN"]), 10) || (horaCreacion ? horaCreacion.getMonth() + 1 : null);
    let semanaCreacion = parseInt(pick(r, ["SEMANA CREACIÓN LEAD"]), 10) || null;
    // Filas con fecha corrupta o vacía en el Sheet a veces caen en el clásico
    // "día cero" de hojas de cálculo (30/31-dic-1899). Cualquier año fuera de
    // un rango razonable se descarta para que no ensucie las vistas por
    // mes/semana (el lead sigue contando en los totales generales).
    if (!anioCreacion || anioCreacion !== VALID_YEAR) {
      anioCreacion = null;
      mesCreacion = null;
      semanaCreacion = null;
    }

    const fechaMiniCod = pick(r, ["Fecha/hora de MiniCOD"]);
    const fechaCodLuisa = pick(r, ["Fecha/hora COD Luisa"]);
    const fechaCodVictor = pick(r, ["Fecha/hora COD Víctor", "Fecha/hora COD Victor"]);
    const fechaDiagnostico = pick(r, ["Fecha/hora cita de diagnóstico", "Fecha/hora cita de diagnostico"]);

    const reachedMiniCod = isFilled(fechaMiniCod);
    const reachedCod = isFilled(fechaCodLuisa) || isFilled(fechaCodVictor);
    const reachedDiagnostico = isFilled(fechaDiagnostico);

    // Fechas reales de los eventos (para "actividad real": cuándo OCURRIÓ la
    // llamada, no cuándo entró el lead). Si hay COD con Luisa y Víctor, se usa
    // la que sí tenga fecha (o la más antigua si ambas la tienen).
    const dMiniCod = parseDMY(fechaMiniCod);
    const dCodLuisa = parseDMY(fechaCodLuisa);
    const dCodVictor = parseDMY(fechaCodVictor);
    const dCod =
      dCodLuisa && dCodVictor ? (dCodLuisa < dCodVictor ? dCodLuisa : dCodVictor) : dCodLuisa || dCodVictor || null;
    const dDiagnostico = parseDMY(fechaDiagnostico);

    const propietario = pick(r, ["Propietario de Oportunidad"]) || "";
    const esAdan = normalize(propietario).includes("adan cortes");

    const campania =
      pick(r, ["utm_campaign (Sospechosos convertidos)", "utm_campaign"]) || "Sin UTM";
    const campaniaFinal = isFilled(campania) ? campania : "Sin UTM";
    const utmContent = pick(r, ["utm_content"]) || "";

    out.push({
      id: idRegistro,
      nombre: pick(r, ["Nombre completo"]) || "",
      fuente,
      paid,
      fase,
      faseNorm,
      noContactado: faseNorm === normalize(NO_CONTACTADO_FASE),
      seguimientoFinal: faseNorm === normalize(SEGUIMIENTO_FINAL_FASE),
      programaAceptado: faseNorm === normalize(PROGRAMA_ACEPTADO_FASE),
      horaCreacion,
      horaModificacion,
      anioCreacion,
      mesCreacion,
      semanaCreacion,
      reachedMiniCod,
      reachedCod,
      reachedDiagnostico,
      eventoMiniCod: dMiniCod,
      eventoCod: dCod,
      eventoDiagnostico: dDiagnostico,
      propietario,
      esAdan,
      campania: campaniaFinal,
      utmContent,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------
   AGREGACIONES
   ------------------------------------------------------------------------- */

const MESES_LARGO = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

function computeFunnel(leads) {
  const total = leads.length;
  const noContactados = leads.filter((l) => l.noContactado).length;
  const miniCod = leads.filter((l) => l.reachedMiniCod).length;
  const cod = leads.filter((l) => l.reachedCod).length;
  const cierres = leads.filter((l) => l.programaAceptado).length;
  return {
    total,
    noContactados,
    noContactadosPct: total ? (noContactados / total) * 100 : 0,
    miniCod,
    miniCodPct: total ? (miniCod / total) * 100 : 0,
    cod,
    codPct: total ? (cod / total) * 100 : 0,
    cierres,
  };
}

function buildPeriodTable(leads, investment, periodKey) {
  // periodKey: 'mes' -> agrupa por (anioCreacion, mesCreacion)
  //            'semana' -> agrupa por (anioCreacion, semanaCreacion)
  const groups = {};

  const keyOf = (year, p) => `${year}-${String(p).padStart(2, "0")}`;

  for (const l of leads) {
    if (!l.anioCreacion) continue;
    const p = periodKey === "mes" ? l.mesCreacion : l.semanaCreacion;
    if (!p) continue;
    const k = keyOf(l.anioCreacion, p);
    if (!groups[k]) groups[k] = { key: k, year: l.anioCreacion, period: p, leads: [], investment: 0 };
    groups[k].leads.push(l);
  }

  for (const inv of investment) {
    const p = periodKey === "mes" ? inv.month : inv.week;
    if (!p) continue;
    const k = keyOf(inv.year, p);
    if (!groups[k]) groups[k] = { key: k, year: inv.year, period: p, leads: [], investment: 0 };
    groups[k].investment += inv.cost;
  }

  const rows = Object.values(groups).map((g) => {
    const allLeads = g.leads;
    const paidLeads = allLeads.filter((l) => l.paid);
    const funnelAll = computeFunnel(allLeads);
    const funnelPaid = computeFunnel(paidLeads);
    const cplPagado = funnelPaid.total ? g.investment / funnelPaid.total : null;
    const cplGeneral = funnelAll.total ? g.investment / funnelAll.total : null;
    const cierresPagados = paidLeads.filter((l) => l.programaAceptado).length;
    const costoPorCierrePagado = cierresPagados ? g.investment / cierresPagados : null;
    return {
      ...g,
      label: periodKey === "mes" ? `${MESES_LARGO[g.period - 1]} ${g.year}` : `Sem ${g.period} ${g.year}`,
      leadsTotal: funnelAll.total,
      leadsPaid: funnelPaid.total,
      noContactadosPct: funnelAll.noContactadosPct,
      miniCodPct: funnelAll.miniCodPct,
      codPct: funnelAll.codPct,
      cierres: funnelAll.cierres,
      cierresPagados,
      cplPagado,
      cplGeneral,
      costoPorCierrePagado,
      inversion: g.investment,
    };
  });

  rows.sort((a, b) => (a.year - b.year) || (a.period - b.period));
  return rows;
}

// Actividad REAL: cuenta llamadas/citas que OCURRIERON en cada semana,
// según la fecha del evento — sin importar cuándo entró el lead al CRM.
function buildActividadRealSemanal(leads) {
  const groups = {};
  const bump = (date, field) => {
    if (!date) return;
    const year = date.getFullYear();
    const week = isoWeek(date);
    const k = `${year}-${String(week).padStart(2, "0")}`;
    if (!groups[k]) groups[k] = { key: k, year, period: week, miniCod: 0, cod: 0, diagnostico: 0 };
    groups[k][field] += 1;
  };
  for (const l of leads) {
    bump(l.eventoMiniCod, "miniCod");
    bump(l.eventoCod, "cod");
    bump(l.eventoDiagnostico, "diagnostico");
  }
  const rows = Object.values(groups).map((g) => ({ ...g, label: `Sem ${g.period} ${g.year}` }));
  rows.sort((a, b) => a.year - b.year || a.period - b.period);
  return rows;
}

// Costo de inversión / leads pagados que llegaron a cada etapa del embudo.
function computeCostosPorEtapa(paidLeads, investmentTotal) {
  const stages = [
    { key: "lead", label: "Lead (entrada)", count: paidLeads.length },
    { key: "miniCod", label: "Mini-COD", count: paidLeads.filter((l) => l.reachedMiniCod).length },
    { key: "cod", label: "COD", count: paidLeads.filter((l) => l.reachedCod).length },
    { key: "diagnostico", label: "Diagnóstico", count: paidLeads.filter((l) => l.reachedDiagnostico).length },
    { key: "cierre", label: "Programa Aceptado", count: paidLeads.filter((l) => l.programaAceptado).length },
  ];
  return stages.map((s) => ({ ...s, costo: s.count ? investmentTotal / s.count : null }));
}

// Distribución de la Fase ACTUAL de los leads, agrupada por el período en
// que ENTRARON (mes o semana, según granularidad). Útil para ver mes/semana
// a mes/semana en qué parte del pipeline se quedaron.
function computePipelinePorFase(leads, periodKey, topN = 6) {
  const faseCounts = {};
  for (const l of leads) {
    const f = l.fase || "Sin fase";
    faseCounts[f] = (faseCounts[f] || 0) + 1;
  }
  const topFases = Object.entries(faseCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([f]) => f);
  const topSet = new Set(topFases);

  const groups = {};
  for (const l of leads) {
    if (!l.anioCreacion) continue;
    const p = periodKey === "mes" ? l.mesCreacion : l.semanaCreacion;
    if (!p) continue;
    const k = `${l.anioCreacion}-${String(p).padStart(2, "0")}`;
    if (!groups[k]) {
      groups[k] = { key: k, year: l.anioCreacion, period: p, total: 0, fases: {} };
    }
    const g = groups[k];
    g.total += 1;
    const f = topSet.has(l.fase) ? l.fase : l.fase ? "Otras" : "Sin fase";
    g.fases[f] = (g.fases[f] || 0) + 1;
  }

  const columns = [...topFases, "Otras"];
  const rows = Object.values(groups).map((g) => ({
    ...g,
    label: periodKey === "mes" ? `${MESES_LARGO[g.period - 1]} ${g.year}` : `Sem ${g.period} ${g.year}`,
  }));
  rows.sort((a, b) => a.year - b.year || a.period - b.period);
  return { rows, columns };
}

function semaforo(metric, value) {
  if (value === null || value === undefined || isNaN(value)) return COLORS.muted;
  switch (metric) {
    case "noContactado":
      return value < THRESHOLDS.noContactado.green
        ? COLORS.green
        : value <= THRESHOLDS.noContactado.yellow
        ? COLORS.yellow
        : COLORS.red;
    case "cplPagado":
      return value < THRESHOLDS.cplPagado.green
        ? COLORS.green
        : value <= THRESHOLDS.cplPagado.yellow
        ? COLORS.yellow
        : COLORS.red;
    case "miniCod":
      return value > THRESHOLDS.miniCod.green
        ? COLORS.green
        : value >= THRESHOLDS.miniCod.yellow
        ? COLORS.yellow
        : COLORS.red;
    case "diasSF":
      return value <= THRESHOLDS.diasSF.green
        ? COLORS.green
        : value <= THRESHOLDS.diasSF.yellow
        ? COLORS.yellow
        : COLORS.red;
    default:
      return COLORS.muted;
  }
}

function fmtMoney(v) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return v.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
}
function fmtPct(v) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return `${v.toFixed(1)}%`;
}

/* =========================================================================
   COMPONENTES DE UI
   ========================================================================= */

function Badge({ color, children }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 10,
        height: 10,
        borderRadius: 999,
        background: color,
        marginRight: 6,
      }}
    />
  );
}

// Chip de color con fondo tenue — más fácil de escanear en una tabla larga
// que solo texto coloreado.
const PILL_TINTS = {
  [COLORS.green]: { bg: "#E7F5EC", fg: "#116B33" },
  [COLORS.yellow]: { bg: "#FEF6E7", fg: "#8A5A07" },
  [COLORS.red]: { bg: "#FBE7EB", fg: "#8A0F2C" },
};
function Pill({ color, children }) {
  const tint = PILL_TINTS[color] || { bg: COLORS.bgCardAlt, fg: COLORS.text };
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 999,
        background: tint.bg,
        color: tint.fg,
        fontWeight: 700,
        fontSize: 12.5,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function KpiCard({ label, value, sub, color, highlight = false, delta = null }) {
  // Cuando la tarjeta trae un color de semáforo (rojo/ámbar/verde), se resalta
  // con un acento lateral y un fondo tenue del mismo tono — así lo urgente
  // salta a la vista sin tener que leer el número.
  const isAlert = highlight && (color === COLORS.red || color === COLORS.crimson || color === COLORS.yellow);
  const tint = color === COLORS.yellow ? "#FEF6E7" : "#FBE7EB";
  return (
    <div
      style={{
        background: isAlert ? tint : COLORS.bgCard,
        border: `1px solid ${isAlert ? color : COLORS.border}`,
        borderLeft: `4px solid ${isAlert ? color : COLORS.navy}`,
        borderRadius: 10,
        padding: "18px 20px",
        flex: "1 1 180px",
        minWidth: 160,
        boxShadow: "0 1px 3px rgba(33,29,29,0.06)",
      }}
    >
      <div style={{ fontSize: 12, color: COLORS.muted, textTransform: "uppercase", letterSpacing: 0.6, fontWeight: 600 }}>
        {label}
      </div>
      <div style={{ fontFamily: FONT_DISPLAY, fontSize: 38, fontWeight: 700, color: color || COLORS.navyDeep, marginTop: 6 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12.5, color: COLORS.muted, marginTop: 4 }}>{sub}</div>}
      {delta}
    </div>
  );
}

function Delta({ current, previous, invert = false }) {
  if (previous === null || previous === undefined || previous === 0 || current === null || current === undefined) {
    return <span style={{ color: COLORS.muted }}>—</span>;
  }
  const diff = current - previous;
  const pct = (diff / Math.abs(previous)) * 100;
  const isGood = invert ? diff < 0 : diff > 0;
  const color = diff === 0 ? COLORS.muted : isGood ? COLORS.green : COLORS.red;
  const arrow = diff === 0 ? "→" : diff > 0 ? "↑" : "↓";
  return (
    <span style={{ color, fontWeight: 600, fontSize: 12 }}>
      {arrow} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

// Línea de delta pensada para ir debajo de un KpiCard, comparando contra el
// período anterior equivalente (mismo número de días, inmediatamente antes).
// Formato "↑ 123% vs periodo anterior" — igual al patrón de referencia.
function KpiDelta({ current, previous, invert = false }) {
  if (previous === null || previous === undefined) {
    return null;
  }
  return (
    <div style={{ marginTop: 6, fontSize: 12 }}>
      <Delta current={current} previous={previous} invert={invert} />
      <span style={{ color: COLORS.muted, marginLeft: 6 }}>vs periodo anterior</span>
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "10px 16px",
        borderRadius: 8,
        border: `1px solid ${active ? COLORS.navy : COLORS.border}`,
        background: active ? "rgba(36,81,147,0.10)" : "#FFFFFF",
        color: active ? COLORS.navyDeep : COLORS.text,
        fontWeight: active ? 700 : 500,
        cursor: "pointer",
        fontSize: 13,
        fontFamily: FONT_BODY,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function Card({ children, style }) {
  return (
    <div
      style={{
        background: COLORS.bgCard,
        border: `1px solid ${COLORS.border}`,
        borderTop: `3px solid ${COLORS.navy}`,
        borderRadius: 10,
        padding: 20,
        boxShadow: "0 1px 3px rgba(33,29,29,0.06)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// Pequeña leyenda de qué pestaña(s) del Google Sheet alimentan cada
// gráfica/tabla — para que Andrei sepa a qué corregir si un número se ve mal.
function SourceNote({ children }) {
  return (
    <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 10, fontStyle: "italic" }}>
      Fuente: {children}
    </div>
  );
}
const SOURCE_ZOHO = "Base ZOHO OPS 2026";
const SOURCE_ADS = "Query-Meta + Query-Google";
const SOURCE_BOTH = "Base ZOHO OPS 2026 + Query-Meta + Query-Google";

// Etiqueta pequeña estilo "eyebrow" para encabezar cada sección de una vista.
function SectionLabel({ children }) {
  return (
    <div
      style={{
        color: COLORS.navy,
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.8,
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function ChartTooltip({ active, payload, label, isMoney = false }) {
  if (!active || !payload || !payload.length) return null;
  const fmt = (v) => (typeof v === "number" ? (isMoney ? fmtMoney(v) : v.toLocaleString("es-MX")) : v);
  return (
    <div
      style={{
        background: "#FFFFFF",
        border: `1px solid ${COLORS.border}`,
        borderRadius: 8,
        padding: "8px 12px",
        fontSize: 12,
        boxShadow: "0 2px 8px rgba(33,29,29,0.12)",
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4, color: COLORS.text }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color }}>
          {p.name}: <strong>{fmt(p.value)}</strong>
        </div>
      ))}
    </div>
  );
}

// Gráfica de barras genérica reutilizable en varias vistas.
// moneyAxis=true formatea el eje de valores y el tooltip como pesos MXN.
function SimpleBarChart({ data, bars, xKey = "label", height = 260, layout = "horizontal", moneyAxis = false }) {
  const valueAxisProps = moneyAxis ? { tickFormatter: (v) => fmtMoney(v) } : {};
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout={layout} margin={{ top: 10, right: 16, left: layout === "vertical" ? 60 : 0, bottom: 0 }}>
          <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" horizontal={layout !== "vertical"} vertical={layout === "vertical"} />
          {layout === "vertical" ? (
            <>
              <XAxis type="number" stroke={COLORS.muted} tick={{ fontSize: 11 }} {...valueAxisProps} />
              <YAxis type="category" dataKey={xKey} stroke={COLORS.muted} tick={{ fontSize: 11 }} width={140} />
            </>
          ) : (
            <>
              <XAxis dataKey={xKey} type="category" stroke={COLORS.muted} tick={{ fontSize: 11 }} />
              <YAxis stroke={COLORS.muted} tick={{ fontSize: 11 }} {...valueAxisProps} />
            </>
          )}
          <Tooltip content={<ChartTooltip isMoney={moneyAxis} />} />
          {bars.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
          {bars.map((b, i) => (
            <Bar key={b.key} dataKey={b.key} name={b.name || b.key} fill={b.color || CHART_COLORS[i % CHART_COLORS.length]} radius={[4, 4, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// Dona / pastel genérico.
function SimpleDonut({ data, height = 240 }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div style={{ height, display: "flex", alignItems: "center", gap: 20 }}>
      <div style={{ width: height, height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="55%" outerRadius="85%" paddingAngle={2}>
              {data.map((d, i) => (
                <Cell key={i} fill={d.color || CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div style={{ fontSize: 13 }}>
        {data.map((d, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: d.color || CHART_COLORS[i % CHART_COLORS.length],
                display: "inline-block",
              }}
            />
            <span style={{ color: COLORS.text }}>{d.name}</span>
            <span style={{ color: COLORS.muted }}>
              {d.value.toLocaleString("es-MX")} ({total ? ((d.value / total) * 100).toFixed(0) : 0}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Table({ columns, rows, rowStyle }) {
  return (
    <div style={{ overflowX: "auto", border: `1px solid ${COLORS.border}`, borderRadius: 10, background: COLORS.bgCard }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{
                  textAlign: c.align || "left",
                  padding: "10px 12px",
                  color: COLORS.navy,
                  background: COLORS.bgCardAlt,
                  borderBottom: `1px solid ${COLORS.border}`,
                  whiteSpace: "nowrap",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                  fontWeight: 700,
                }}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              style={{
                background: i % 2 === 0 ? "transparent" : COLORS.bgCardAlt,
                ...(rowStyle ? rowStyle(row, i) : {}),
              }}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  style={{
                    padding: "10px 12px",
                    borderBottom: `1px solid ${COLORS.border}`,
                    color: COLORS.text,
                    textAlign: c.align || "left",
                    whiteSpace: "nowrap",
                  }}
                >
                  {c.render ? c.render(row) : row[c.key]}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} style={{ padding: 20, textAlign: "center", color: COLORS.muted }}>
                Sin datos para este período.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------
   VISTA 1: RESUMEN EJECUTIVO
   ------------------------------------------------------------------------- */

function ResumenEjecutivo({ leads, investment, investmentTotal, weeklyRows, prevLeads, prevInvestmentTotal, hasPrevPeriod }) {
  const paidLeads = leads.filter((l) => l.paid);
  const funnelAll = computeFunnel(leads);
  const funnelPaid = computeFunnel(paidLeads);
  const cplPagado = funnelPaid.total ? investmentTotal / funnelPaid.total : null;
  const cplGeneral = funnelAll.total ? investmentTotal / funnelAll.total : null;

  // Mismas métricas, pero para el período anterior equivalente — para poder
  // mostrar el delta (▲▼) debajo de cada tarjeta. Si no hay período anterior
  // (p. ej. filtro "Todo"), estos quedan en null y el delta simplemente no
  // se muestra.
  const prevPaidLeads = (prevLeads || []).filter((l) => l.paid);
  const prevFunnelAll = hasPrevPeriod ? computeFunnel(prevLeads) : null;
  const prevFunnelPaid = hasPrevPeriod ? computeFunnel(prevPaidLeads) : null;
  const prevCplPagado = hasPrevPeriod && prevFunnelPaid.total ? prevInvestmentTotal / prevFunnelPaid.total : null;
  const prevCplGeneral = hasPrevPeriod && prevFunnelAll.total ? prevInvestmentTotal / prevFunnelAll.total : null;

  const last2 = weeklyRows.slice(-2);
  const alertaNC =
    last2.length === 2 && last2.every((w) => w.noContactadosPct > THRESHOLDS.noContactado.yellow);

  // Inversión y resultados por canal. "Resultado" es la métrica que reporta
  // cada plataforma (NO es lo mismo que un lead real en ZOHO):
  // Meta -> Website leads, Google -> Conversions.
  const metaRows = investment.filter((r) => r.canal === "Meta");
  const googleSearchRows = investment.filter((r) => r.canal === "Google" && r.googleChannel === "search");
  const googleYoutubeRows = investment.filter((r) => r.canal === "Google" && r.googleChannel === "youtube");
  const googleOtrasRows = investment.filter((r) => r.canal === "Google" && r.googleChannel === "otras");

  const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
  const canales = [
    { label: "Meta Ads", inversion: sum(metaRows, "cost"), resultado: sum(metaRows, "websiteLeads"), resultadoLabel: "Registros landing" },
    { label: "Google Search", inversion: sum(googleSearchRows, "cost"), resultado: sum(googleSearchRows, "conversions"), resultadoLabel: "Registros landing" },
    { label: "Google YouTube", inversion: sum(googleYoutubeRows, "cost"), resultado: sum(googleYoutubeRows, "conversions"), resultadoLabel: "Suscriptores al Canal" },
    ...(googleOtrasRows.length
      ? [{ label: "Google (otras campañas)", inversion: sum(googleOtrasRows, "cost"), resultado: sum(googleOtrasRows, "conversions"), resultadoLabel: "Conversiones" }]
      : []),
  ].map((c) => ({ ...c, costoPorResultado: c.resultado ? c.inversion / c.resultado : null }));

  return (
    <div>
      {alertaNC && (
        <div
          style={{
            background: "#FBE7EB",
            border: `1px solid ${COLORS.crimson}`,
            borderRadius: 10,
            padding: "12px 16px",
            marginBottom: 18,
            color: "#8A0F2C",
            fontSize: 13,
          }}
        >
          ⚠️ Alerta: % de no contactados por arriba de {THRESHOLDS.noContactado.yellow}% en las últimas 2
          semanas completas. Este ha sido históricamente el mayor cuello de botella del embudo.
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 24 }}>
        <KpiCard
          label="Leads pagados (período)"
          value={funnelPaid.total.toLocaleString("es-MX")}
          delta={
            <KpiDelta
              current={funnelPaid.total}
              previous={hasPrevPeriod ? prevFunnelPaid.total : null}
              fmtAbs={(v) => v.toLocaleString("es-MX")}
            />
          }
        />
        <KpiCard
          label="Inversión total"
          value={fmtMoney(investmentTotal)}
          delta={<KpiDelta current={investmentTotal} previous={hasPrevPeriod ? prevInvestmentTotal : null} fmtAbs={fmtMoney} />}
        />
        <KpiCard
          label="CPL pagado"
          value={fmtMoney(cplPagado)}
          color={semaforo("cplPagado", cplPagado)}
          sub="Inversión / leads de fuentes pagadas"
          highlight
          delta={<KpiDelta current={cplPagado} previous={prevCplPagado} invert fmtAbs={fmtMoney} />}
        />
        <KpiCard
          label="CPL general"
          value={fmtMoney(cplGeneral)}
          sub="Inversión / todos los leads"
          delta={<KpiDelta current={cplGeneral} previous={prevCplGeneral} invert fmtAbs={fmtMoney} />}
        />
        <KpiCard
          label="Mini-COD rate"
          value={fmtPct(funnelAll.miniCodPct)}
          color={semaforo("miniCod", funnelAll.miniCodPct)}
          highlight
          delta={
            <KpiDelta
              current={funnelAll.miniCodPct}
              previous={hasPrevPeriod ? prevFunnelAll.miniCodPct : null}
              fmtAbs={(v) => `${v.toFixed(1)} pts`}
            />
          }
        />
        <KpiCard
          label="Cierres (Programa Aceptado)"
          value={funnelAll.cierres.toLocaleString("es-MX")}
          delta={
            <KpiDelta
              current={funnelAll.cierres}
              previous={hasPrevPeriod ? prevFunnelAll.cierres : null}
              fmtAbs={(v) => v.toLocaleString("es-MX")}
            />
          }
        />
      </div>

      <Card style={{ marginBottom: 20 }}>
        <SectionLabel>Inversión y resultados por canal</SectionLabel>
        <div style={{ color: COLORS.muted, fontSize: 12.5, marginBottom: 14 }}>
          "Resultado" es la métrica que reporta cada plataforma publicitaria: Registros landing en Meta Ads
          y Google Search, Suscriptores al Canal en Google YouTube — no es lo mismo que un lead real dado
          de alta en ZOHO, es la atribución que hace la propia plataforma.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
          <SimpleBarChart
            data={canales.map((c) => ({ label: c.label, Inversión: Math.round(c.inversion) }))}
            bars={[{ key: "Inversión", color: COLORS.navy }]}
            moneyAxis
          />
          <SimpleBarChart
            data={canales.map((c) => ({ label: c.label, Resultado: Math.round(c.resultado) }))}
            bars={[{ key: "Resultado", color: COLORS.crimson }]}
          />
        </div>
        <Table
          columns={[
            { key: "label", header: "Canal" },
            { key: "inversion", header: "Inversión", align: "right", render: (r) => fmtMoney(r.inversion) },
            { key: "resultado", header: "Resultado", align: "right", render: (r) => `${r.resultado.toLocaleString("es-MX")} (${r.resultadoLabel})` },
            { key: "costoPorResultado", header: "Costo por resultado", align: "right", render: (r) => fmtMoney(r.costoPorResultado) },
          ]}
          rows={canales}
        />
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16, marginBottom: 20 }}>
        <Card>
          <SectionLabel>Embudo del pipeline (todos los leads)</SectionLabel>
          <SimpleBarChart
            layout="vertical"
            height={220}
            data={[
              { label: "Lead", value: funnelAll.total },
              { label: "Mini-COD", value: funnelAll.miniCod },
              { label: "COD", value: funnelAll.cod },
              { label: "Programa Aceptado", value: funnelAll.cierres },
            ]}
            bars={[{ key: "value", name: "Leads", color: COLORS.navy }]}
          />
        </Card>
        <Card>
          <SectionLabel>Pagados vs orgánicos</SectionLabel>
          <SimpleDonut
            data={[
              { name: "Pagados (Rockin)", value: funnelPaid.total, color: COLORS.navy },
              { name: "Orgánicos", value: funnelAll.total - funnelPaid.total, color: COLORS.crimson },
            ]}
          />
        </Card>
      </div>

      <Card>
        <SectionLabel>Semáforo de salud del pipeline</SectionLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, fontSize: 14.5 }}>
          <div>
            <Badge color={semaforo("noContactado", funnelAll.noContactadosPct)} />
            No contactados: {fmtPct(funnelAll.noContactadosPct)}
          </div>
          <div>
            <Badge color={semaforo("cplPagado", cplPagado)} />
            CPL pagado: {fmtMoney(cplPagado)}
          </div>
          <div>
            <Badge color={semaforo("miniCod", funnelAll.miniCodPct)} />
            Mini-COD: {fmtPct(funnelAll.miniCodPct)}
          </div>
        </div>
      </Card>
      <SourceNote>{SOURCE_BOTH}</SourceNote>
    </div>
  );
}

/* -------------------------------------------------------------------------
   VISTA 2: EVOLUCIÓN (mensual / semanal)
   ------------------------------------------------------------------------- */

function Evolucion({ monthlyAll, monthlyPaid, weeklyAll, weeklyPaid, granularityAuto }) {
  const [periodo, setPeriodo] = useState(granularityAuto);
  const [soloPagadas, setSoloPagadas] = useState(false);

  // El botón manual sigue disponible, pero cada vez que cambia el filtro
  // global de fechas (y por lo tanto la granularidad automática), el toggle
  // se resincroniza a esa recomendación por default.
  useEffect(() => {
    setPeriodo(granularityAuto);
  }, [granularityAuto]);

  const rows =
    periodo === "mes" ? (soloPagadas ? monthlyPaid : monthlyAll) : soloPagadas ? weeklyPaid : weeklyAll;

  const chartData = rows.map((r) => ({
    label: r.label,
    "CPL pagado": r.cplPagado ? Math.round(r.cplPagado) : null,
    "CPL general": r.cplGeneral ? Math.round(r.cplGeneral) : null,
    Leads: r.leadsTotal,
  }));

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <TabButton active={periodo === "mes"} onClick={() => setPeriodo("mes")}>
          Mensual
        </TabButton>
        <TabButton active={periodo === "semana"} onClick={() => setPeriodo("semana")}>
          Semanal
        </TabButton>
        <div style={{ width: 1, background: COLORS.border, margin: "0 6px" }} />
        <TabButton active={!soloPagadas} onClick={() => setSoloPagadas(false)}>
          Todas las fuentes
        </TabButton>
        <TabButton active={soloPagadas} onClick={() => setSoloPagadas(true)}>
          Solo pagadas
        </TabButton>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <Card>
          <SectionLabel>CPL pagado vs CPL general</SectionLabel>
          <div style={{ height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" />
                <XAxis dataKey="label" type="category" stroke={COLORS.muted} tick={{ fontSize: 11 }} />
                <YAxis stroke={COLORS.muted} tick={{ fontSize: 11 }} tickFormatter={(v) => fmtMoney(v)} />
                <Tooltip content={<ChartTooltip isMoney />} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="CPL pagado" stroke={COLORS.navy} strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="CPL general" stroke={COLORS.crimson} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card>
          <SectionLabel>Volumen de leads por período</SectionLabel>
          <SimpleBarChart data={chartData} bars={[{ key: "Leads", color: COLORS.blue }]} height={260} />
        </Card>
      </div>

      <Table
        columns={[
          { key: "label", header: "Período" },
          {
            key: "leadsTotal",
            header: "Leads",
            align: "right",
            render: (r) => (
              <div>
                {r.leadsTotal}
                {r._prev && <KpiDelta current={r.leadsTotal} previous={r._prev.leadsTotal} fmtAbs={(v) => v} />}
              </div>
            ),
          },
          {
            key: "noContactadosPct",
            header: "NC%",
            align: "right",
            render: (r) => (
              <div>
                <Pill color={semaforo("noContactado", r.noContactadosPct)}>{fmtPct(r.noContactadosPct)}</Pill>
                {r._prev && (
                  <KpiDelta current={r.noContactadosPct} previous={r._prev.noContactadosPct} invert fmtAbs={(v) => `${v.toFixed(1)}pts`} />
                )}
              </div>
            ),
          },
          {
            key: "miniCodPct",
            header: "Mini-COD%",
            align: "right",
            render: (r) => (
              <div>
                <Pill color={semaforo("miniCod", r.miniCodPct)}>{fmtPct(r.miniCodPct)}</Pill>
                {r._prev && (
                  <KpiDelta current={r.miniCodPct} previous={r._prev.miniCodPct} fmtAbs={(v) => `${v.toFixed(1)}pts`} />
                )}
              </div>
            ),
          },
          { key: "codPct", header: "COD%", align: "right", render: (r) => fmtPct(r.codPct) },
          { key: "cierres", header: "Ace", align: "right" },
          {
            key: "cplPagado",
            header: "CPL pagado",
            align: "right",
            render: (r) => (
              <div>
                <Pill color={semaforo("cplPagado", r.cplPagado)}>{fmtMoney(r.cplPagado)}</Pill>
                {r._prev && <KpiDelta current={r.cplPagado} previous={r._prev.cplPagado} invert fmtAbs={fmtMoney} />}
              </div>
            ),
          },
          { key: "cplGeneral", header: "CPL general", align: "right", render: (r) => fmtMoney(r.cplGeneral) },
        ]}
        rows={[...rows].reverse().map((r, i, arr) => ({ ...r, _prev: arr[i + 1] || null }))}
      />
      <div style={{ fontSize: 11.5, color: COLORS.muted, marginTop: 6 }}>
        Los deltas (▲▼) comparan cada fila contra el período inmediatamente anterior en esta misma tabla.
      </div>
      <SourceNote>{SOURCE_BOTH}</SourceNote>
    </div>
  );
}

/* -------------------------------------------------------------------------
   VISTA 3: SEMANA VS SEMANA
   ------------------------------------------------------------------------- */

function SemanaVsSemana({ weeklyAll }) {
  const last3 = weeklyAll.slice(-4, -1); // excluye la semana en curso (posiblemente incompleta)
  if (last3.length < 2) {
    return <div style={{ color: COLORS.muted }}>Aún no hay suficientes semanas completas para comparar.</div>;
  }
  const [w1, w2, w3] = [last3[last3.length - 1], last3[last3.length - 2], last3[last3.length - 3]];

  const metrics = [
    { key: "leadsTotal", label: "Leads totales", invert: false, fmt: (v) => v?.toLocaleString("es-MX") ?? "—" },
    { key: "noContactadosPct", label: "% No contactados", invert: true, fmt: fmtPct },
    { key: "miniCodPct", label: "Mini-COD rate", invert: false, fmt: fmtPct },
    { key: "codPct", label: "COD rate", invert: false, fmt: fmtPct },
    { key: "cierres", label: "Cierres", invert: false, fmt: (v) => v ?? 0 },
    { key: "cplPagado", label: "CPL pagado", invert: true, fmt: fmtMoney },
  ];

  return (
    <div>
      <div style={{ color: COLORS.muted, fontSize: 13, marginBottom: 14 }}>
        Comparando {w1?.label} (más reciente) vs {w2?.label} vs {w3?.label}. Se excluye la semana en curso
        por estar incompleta. Esta vista siempre mira las últimas semanas completas del histórico — no se
        acota al filtro de fecha de arriba, para no cortar semanas a la mitad.
      </div>
      <Table
        columns={[
          { key: "label", header: "Métrica" },
          { key: "w1", header: w1?.label || "—", align: "right" },
          { key: "d1", header: "vs anterior", align: "right" },
          { key: "w2", header: w2?.label || "—", align: "right" },
          { key: "d2", header: "vs ante-anterior", align: "right" },
          { key: "w3", header: w3?.label || "—", align: "right" },
        ]}
        rows={metrics.map((m) => ({
          label: m.label,
          w1: m.fmt(w1?.[m.key]),
          d1: <Delta current={w1?.[m.key]} previous={w2?.[m.key]} invert={m.invert} />,
          w2: m.fmt(w2?.[m.key]),
          d2: <Delta current={w2?.[m.key]} previous={w3?.[m.key]} invert={m.invert} />,
          w3: m.fmt(w3?.[m.key]),
        }))}
      />
      <SourceNote>{SOURCE_BOTH}</SourceNote>
    </div>
  );
}

/* -------------------------------------------------------------------------
   VISTA 4: SEGUIMIENTO FINAL
   ------------------------------------------------------------------------- */

function SeguimientoFinal({ leads }) {
  const sfLeads = leads
    .filter((l) => l.seguimientoFinal)
    .map((l) => {
      const dias = l.horaCreacion ? Math.floor((Date.now() - l.horaCreacion.getTime()) / 86400000) : null;
      return { ...l, dias };
    })
    .sort((a, b) => (b.dias ?? 0) - (a.dias ?? 0));

  const urgentes = sfLeads.filter((l) => l.dias !== null && l.dias > THRESHOLDS.diasSF.yellow).length;
  const enRiesgo = sfLeads.filter(
    (l) => l.dias !== null && l.dias > THRESHOLDS.diasSF.green && l.dias <= THRESHOLDS.diasSF.yellow
  ).length;
  const conAdan = sfLeads.filter((l) => l.esAdan).length;
  const enVerde = sfLeads.length - urgentes - enRiesgo;

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 20 }}>
        <KpiCard label="Activos en Seguimiento Final" value={sfLeads.length} />
        <KpiCard label="Urgentes (>65 días)" value={urgentes} color={COLORS.red} highlight={urgentes > 0} />
        <KpiCard label="En riesgo (35-65 días)" value={enRiesgo} color={COLORS.yellow} highlight={enRiesgo > 0} />
        {conAdan > 0 && (
          <KpiCard label="Asignados a Adán Cortés" value={conAdan} color={COLORS.red} sub="Requieren reasignación" highlight />
        )}
      </div>

      {sfLeads.length > 0 && (
        <Card style={{ marginBottom: 20 }}>
          <SectionLabel>Distribución por urgencia</SectionLabel>
          <SimpleDonut
            data={[
              { name: "En tiempo (≤35d)", value: enVerde, color: COLORS.green },
              { name: "En riesgo (35-65d)", value: enRiesgo, color: COLORS.yellow },
              { name: "Urgente (>65d)", value: urgentes, color: COLORS.red },
            ]}
          />
        </Card>
      )}

      <Table
        columns={[
          { key: "nombre", header: "Nombre" },
          { key: "fuente", header: "Fuente" },
          {
            key: "propietario",
            header: "Agente",
            render: (r) => (
              <span style={{ color: r.esAdan ? COLORS.red : COLORS.text, fontWeight: r.esAdan ? 700 : 400 }}>
                {r.propietario} {r.esAdan && "⚠️"}
              </span>
            ),
          },
          {
            key: "dias",
            header: "Días en proceso",
            align: "right",
            render: (r) => <Pill color={semaforo("diasSF", r.dias)}>{r.dias ?? "—"} días</Pill>,
          },
          {
            key: "horaModificacion",
            header: "Última actividad",
            render: (r) => (r.horaModificacion ? r.horaModificacion.toLocaleDateString("es-MX") : "—"),
          },
        ]}
        rows={sfLeads}
        rowStyle={(r) => (r.dias !== null && r.dias === sfLeads[0]?.dias && r.dias > THRESHOLDS.diasSF.yellow ? { background: "#FBE7EB" } : {})}
      />
      <SourceNote>{SOURCE_ZOHO}</SourceNote>
    </div>
  );
}

/* -------------------------------------------------------------------------
   VISTA 5: CAMPAÑAS UTM
   ------------------------------------------------------------------------- */

function CampanasUtm({ leads }) {
  const groups = {};
  for (const l of leads) {
    if (!l.paid) continue;
    const k = l.campania || "Sin UTM";
    if (!groups[k]) groups[k] = [];
    groups[k].push(l);
  }
  const rows = Object.entries(groups)
    .map(([campania, campLeads]) => {
      const f = computeFunnel(campLeads);
      return {
        campania,
        leads: f.total,
        ncPct: f.noContactadosPct,
        miniCodPct: f.miniCodPct,
        codPct: f.codPct,
        rec: campLeads.filter((l) => l.reachedDiagnostico).length,
        cierres: f.cierres,
        convPct: f.total ? (f.cierres / f.total) * 100 : 0,
      };
    })
    .sort((a, b) => b.miniCodPct - a.miniCodPct);

  const top8 = rows.slice(0, 8).map((r) => ({ label: r.campania, "Mini-COD%": Math.round(r.miniCodPct * 10) / 10 }));

  return (
    <div>
      <div style={{ color: COLORS.muted, fontSize: 13, marginBottom: 14 }}>
        Solo fuentes pagadas (Rockin + Facebook Ads + Instagram). Ordenado por Mini-COD rate (mejor arriba).
        Campaña identificada por <code>utm_campaign (Sospechosos convertidos)</code>; leads sin UTM (pre-abril
        2026) se agrupan como "Sin UTM".
      </div>

      {top8.length > 0 && (
        <Card style={{ marginBottom: 20 }}>
          <SectionLabel>Top campañas por Mini-COD%</SectionLabel>
          <SimpleBarChart
            layout="vertical"
            height={Math.max(180, top8.length * 36)}
            data={top8}
            bars={[{ key: "Mini-COD%", color: COLORS.navy }]}
          />
        </Card>
      )}

      <Table
        columns={[
          { key: "campania", header: "Campaña" },
          { key: "leads", header: "Leads", align: "right" },
          { key: "ncPct", header: "NC%", align: "right", render: (r) => fmtPct(r.ncPct) },
          {
            key: "miniCodPct",
            header: "Mini-COD%",
            align: "right",
            render: (r) => <Pill color={semaforo("miniCod", r.miniCodPct)}>{fmtPct(r.miniCodPct)}</Pill>,
          },
          { key: "codPct", header: "COD%", align: "right", render: (r) => fmtPct(r.codPct) },
          { key: "rec", header: "Diagnóstico", align: "right" },
          { key: "convPct", header: "Conv%", align: "right", render: (r) => fmtPct(r.convPct) },
        ]}
        rows={rows}
        rowStyle={(r) => {
          // Solo resalta extremos con volumen mínimo (2+ leads), para no
          // destacar campañas con 1 lead y 100%/0% que no son representativas.
          const relevantes = rows.filter((x) => x.leads >= 2);
          if (!relevantes.length) return {};
          if (r === relevantes[0]) return { background: "#E7F5EC" };
          if (r === relevantes[relevantes.length - 1] && relevantes.length > 1) return { background: "#FBE7EB" };
          return {};
        }}
      />
      <SourceNote>{SOURCE_ZOHO}</SourceNote>
    </div>
  );
}

/* -------------------------------------------------------------------------
   VISTA 6: OPS 6 SEMANAS (cohorte + actividad real)
   ------------------------------------------------------------------------- */

function OpsSeisSemanas({ weeklyAll, leads }) {
  const cohorte = weeklyAll.slice(-6);
  const actividad = buildActividadRealSemanal(leads).slice(-6);

  return (
    <div>
      <div style={{ color: COLORS.muted, fontSize: 12, marginBottom: 10 }}>
        Siempre muestra las últimas 6 semanas del histórico completo — no se acota al filtro de fecha de
        arriba, para no cortar semanas a la mitad.
      </div>
      <SectionLabel>Cohorte — leads que ENTRARON cada semana y su avance</SectionLabel>
      <Card style={{ marginBottom: 16 }}>
        <SimpleBarChart
          data={cohorte}
          bars={[
            { key: "leadsTotal", name: "Leads", color: COLORS.navy },
            { key: "cierres", name: "Cierres", color: COLORS.crimson },
          ]}
        />
      </Card>
      <Table
        columns={[
          { key: "label", header: "Semana" },
          { key: "leadsTotal", header: "Leads", align: "right" },
          {
            key: "noContactadosPct",
            header: "NC%",
            align: "right",
            render: (r) => (
              <span style={{ color: semaforo("noContactado", r.noContactadosPct) }}>
                {fmtPct(r.noContactadosPct)}
              </span>
            ),
          },
          {
            key: "miniCodPct",
            header: "Mini-COD%",
            align: "right",
            render: (r) => (
              <span style={{ color: semaforo("miniCod", r.miniCodPct) }}>{fmtPct(r.miniCodPct)}</span>
            ),
          },
          { key: "codPct", header: "COD%", align: "right", render: (r) => fmtPct(r.codPct) },
          { key: "cierres", header: "Ace", align: "right" },
        ]}
        rows={cohorte}
      />

      <div style={{ marginTop: 28 }}>
        <SectionLabel>Actividad real — llamadas/citas que OCURRIERON cada semana</SectionLabel>
      </div>
      <div style={{ color: COLORS.muted, fontSize: 12, marginBottom: 10 }}>
        Cuenta el evento en la semana en que sucedió, sin importar cuándo entró el lead. Complementa la
        vista de cohorte de arriba, que mide por fecha de entrada.
      </div>
      <Card style={{ marginBottom: 16 }}>
        <SimpleBarChart
          data={actividad}
          bars={[
            { key: "miniCod", name: "Mini-COD", color: COLORS.navy },
            { key: "cod", name: "COD", color: COLORS.blue },
            { key: "diagnostico", name: "Diagnóstico", color: COLORS.crimson },
          ]}
        />
      </Card>
      <Table
        columns={[
          { key: "label", header: "Semana" },
          { key: "miniCod", header: "Mini-COD realizados", align: "right" },
          { key: "cod", header: "COD realizados", align: "right" },
          { key: "diagnostico", header: "Diagnósticos realizados", align: "right" },
        ]}
        rows={actividad}
      />
      <SourceNote>{SOURCE_ZOHO}</SourceNote>
    </div>
  );
}

/* -------------------------------------------------------------------------
   VISTA 7: COSTOS POR ETAPA
   ------------------------------------------------------------------------- */

function CostosPorEtapa({ leads, investmentTotal }) {
  const paidLeads = leads.filter((l) => l.paid);
  const stages = computeCostosPorEtapa(paidLeads, investmentTotal);

  return (
    <div>
      <div style={{ color: COLORS.muted, fontSize: 13, marginBottom: 14 }}>
        Inversión total ({fmtMoney(investmentTotal)}) dividida entre los leads PAGADOS que llegaron a cada
        etapa. Entre más adelante en el embudo, más caro se ve el costo — es normal, porque el mismo peso
        invertido se reparte entre menos leads.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
        <Card>
          <SectionLabel>Leads pagados por etapa</SectionLabel>
          <SimpleBarChart
            data={stages.map((s) => ({ label: s.label, Leads: s.count }))}
            bars={[{ key: "Leads", color: COLORS.navy }]}
          />
        </Card>
        <Card>
          <SectionLabel>Costo por lead en esta etapa</SectionLabel>
          <SimpleBarChart
            data={stages.map((s) => ({ label: s.label, Costo: s.costo ? Math.round(s.costo) : 0 }))}
            bars={[{ key: "Costo", color: COLORS.crimson }]}
            moneyAxis
          />
        </Card>
      </div>

      <Table
        columns={[
          { key: "label", header: "Etapa" },
          { key: "count", header: "Leads pagados en esta etapa", align: "right" },
          {
            key: "costo",
            header: "Costo por lead en esta etapa",
            align: "right",
            render: (r) => fmtMoney(r.costo),
          },
        ]}
        rows={stages}
      />
      <SourceNote>{SOURCE_BOTH}</SourceNote>
    </div>
  );
}

/* -------------------------------------------------------------------------
   VISTA 8: TOTAL VS ROCKIN
   ------------------------------------------------------------------------- */

function TotalVsRockin({ periodAll, periodPaid, periodLabel }) {
  const paidByKey = Object.fromEntries(periodPaid.map((r) => [r.key, r]));
  const rows = periodAll.map((r) => {
    const p = paidByKey[r.key];
    const leadsRockin = p ? p.leadsTotal : 0;
    const cierresRockin = p ? p.cierres : 0;
    return {
      label: r.label,
      leadsTotal: r.leadsTotal,
      leadsRockin,
      pctRockin: r.leadsTotal ? (leadsRockin / r.leadsTotal) * 100 : 0,
      cierresTotal: r.cierres,
      cierresRockin,
    };
  });

  return (
    <div>
      <div style={{ color: COLORS.muted, fontSize: 13, marginBottom: 14 }}>
        Compara el total de leads/cierres del CRM (todas las fuentes) contra los que vienen de fuentes
        pagadas de Rockin (Rockin + Facebook Ads + Instagram). Se agrupa por {periodLabel.toLowerCase()}
        automáticamente según el rango de fechas seleccionado.
      </div>

      <Card style={{ marginBottom: 20 }}>
        <SectionLabel>Leads: total vs. Rockin, por {periodLabel.toLowerCase()}</SectionLabel>
        <SimpleBarChart
          data={rows.map((r) => ({ label: r.label, "Leads total": r.leadsTotal, "Leads Rockin": r.leadsRockin }))}
          bars={[
            { key: "Leads total", color: COLORS.crimson },
            { key: "Leads Rockin", color: COLORS.navy },
          ]}
        />
      </Card>

      <Table
        columns={[
          { key: "label", header: periodLabel },
          { key: "leadsTotal", header: "Leads total", align: "right" },
          { key: "leadsRockin", header: "Leads Rockin", align: "right" },
          { key: "pctRockin", header: "% Rockin", align: "right", render: (r) => fmtPct(r.pctRockin) },
          { key: "cierresTotal", header: "Cierres total", align: "right" },
          { key: "cierresRockin", header: "Cierres Rockin", align: "right" },
        ]}
        rows={[...rows].reverse()}
      />
      <SourceNote>{SOURCE_BOTH}</SourceNote>
    </div>
  );
}

/* -------------------------------------------------------------------------
   VISTA 9: PIPELINE MENSUAL POR FASE
   ------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------
   VISTA 10: META ADS — DESEMPEÑO EN VIVO (vía función serverless)
   ------------------------------------------------------------------------- */

function StatusPill({ label, kind }) {
  const map = {
    active: { bg: "#E7F5EC", fg: "#116B33" },
    paused: { bg: COLORS.bgCardAlt, fg: COLORS.muted },
    other: { bg: "#FEF6E7", fg: "#8A5A07" },
    unknown: { bg: COLORS.bgCardAlt, fg: COLORS.muted },
  };
  const t = map[kind] || map.unknown;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "3px 10px",
        borderRadius: 999,
        background: t.bg,
        color: t.fg,
        fontWeight: 700,
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// Compara un texto de Meta (nombre de adset o de anuncio) contra los campos
// utm de ZOHO usando coincidencia de subcadena normalizada (sin acentos,
// minúsculas). Es una coincidencia APROXIMADA, no un ID exacto — el
// utm_campaign de ZOHO guarda "nombre de campaña + nombre de adset"
// concatenados, y utm_content guarda el nombre del anuncio/creativo.
function normalizeForMatch(s) {
  return normalize(s).replace(/\s+/g, " ").trim();
}
function countZohoMatches(leads, needle, field) {
  const n = normalizeForMatch(needle);
  if (!n) return { leads: 0, cierres: 0 };
  let leadsCount = 0;
  let cierres = 0;
  for (const l of leads) {
    if (!l.paid) continue;
    const hay = normalizeForMatch(field === "campania" ? l.campania : l.utmContent);
    if (hay && hay.includes(n)) {
      leadsCount++;
      if (l.programaAceptado) cierres++;
    }
  }
  return { leads: leadsCount, cierres };
}

function MetaAdsPerformance({ rangeStart, rangeEnd, prevRangeStart, prevRangeEnd, leads }) {
  const [status, setStatus] = useState("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [rows, setRows] = useState([]);
  const [prevRows, setPrevRows] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [campaignFilter, setCampaignFilter] = useState("all");

  useEffect(() => {
    if (!rangeStart || !rangeEnd) return;
    let cancelled = false;
    async function fetchRange(start, end) {
      const url = `/api/meta-ads-performance?date_from=${toInputDate(start)}&date_to=${toInputDate(end)}`;
      const res = await fetch(url);
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
      return json.rows || [];
    }
    async function load() {
      setStatus("loading");
      try {
        const [currentRows, previousRows] = await Promise.all([
          fetchRange(rangeStart, rangeEnd),
          prevRangeStart ? fetchRange(prevRangeStart, prevRangeEnd) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setRows(currentRows);
        setPrevRows(previousRows);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err.message || String(err));
        setStatus("error");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [rangeStart, rangeEnd, prevRangeStart, prevRangeEnd]);

  if (status === "loading") {
    return <div style={{ padding: 40, textAlign: "center", color: COLORS.muted }}>Cargando desde Meta Ads…</div>;
  }

  if (status === "error") {
    return (
      <Card>
        <div style={{ color: "#8A0F2C", fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
          No se pudo cargar el desempeño de Meta Ads.
        </div>
        <div style={{ color: COLORS.muted, fontSize: 13 }}>{errorMsg}</div>
        <div style={{ color: COLORS.muted, fontSize: 12, marginTop: 8 }}>
          Verifica que META_ACCESS_TOKEN y META_AD_ACCOUNT_ID estén configurados en las variables de ambiente de
          Vercel, y que el token del System User tenga permiso ads_read sobre esta cuenta.
        </div>
      </Card>
    );
  }

  const totalInversion = rows.reduce((s, r) => s + r.spend, 0);
  const totalResultados = rows.reduce((s, r) => s + r.resultado, 0);
  const costoPromedio = totalResultados ? totalInversion / totalResultados : null;
  const totalClicks = rows.reduce((s, r) => s + (r.clicks || 0), 0);
  const totalImpressions = rows.reduce((s, r) => s + r.impressions, 0);
  const ctrPromedio = totalImpressions ? (totalClicks / totalImpressions) * 100 : null;

  const prevInversion = prevRows ? prevRows.reduce((s, r) => s + r.spend, 0) : null;
  const prevResultados = prevRows ? prevRows.reduce((s, r) => s + r.resultado, 0) : null;
  const prevCosto = prevRows && prevResultados ? prevInversion / prevResultados : null;
  const prevCtr = prevRows
    ? (() => {
        const c = prevRows.reduce((s, r) => s + (r.clicks || 0), 0);
        const i = prevRows.reduce((s, r) => s + r.impressions, 0);
        return i ? (c / i) * 100 : null;
      })()
    : null;

  const campaignOptions = ["all", ...Array.from(new Set(rows.map((r) => r.campaignName))).sort()];

  const filteredRows = rows.filter((r) => {
    if (statusFilter === "active" && r.statusKind !== "active") return false;
    if (statusFilter === "paused" && r.statusKind !== "paused") return false;
    if (campaignFilter !== "all" && r.campaignName !== campaignFilter) return false;
    return true;
  });

  // Agrupación por Adset, cruzada contra utm_campaign de ZOHO.
  const adsetGroups = {};
  for (const r of filteredRows) {
    const key = r.adsetId || r.adsetName;
    if (!adsetGroups[key]) {
      adsetGroups[key] = { campaignName: r.campaignName, adsetName: r.adsetName, spend: 0, resultado: 0 };
    }
    adsetGroups[key].spend += r.spend;
    adsetGroups[key].resultado += r.resultado;
  }
  const adsetRows = Object.values(adsetGroups)
    .map((g) => {
      const zoho = countZohoMatches(leads, g.adsetName, "campania");
      return {
        ...g,
        costoPorResultado: g.resultado ? g.spend / g.resultado : null,
        leadsZoho: zoho.leads,
        cierresZoho: zoho.cierres,
        cplZoho: zoho.leads ? g.spend / zoho.leads : null,
      };
    })
    .sort((a, b) => b.leadsZoho - a.leadsZoho || b.spend - a.spend);

  // Agrupación por Anuncio, cruzada contra utm_content de ZOHO.
  const adGroups = {};
  for (const r of filteredRows) {
    const key = r.adId || r.adName;
    if (!adGroups[key]) {
      adGroups[key] = { campaignName: r.campaignName, adsetName: r.adsetName, adName: r.adName, spend: 0, resultado: 0 };
    }
    adGroups[key].spend += r.spend;
    adGroups[key].resultado += r.resultado;
  }
  const adRows = Object.values(adGroups)
    .map((g) => {
      const zoho = countZohoMatches(leads, g.adName, "utmContent");
      return {
        ...g,
        costoPorResultado: g.resultado ? g.spend / g.resultado : null,
        leadsZoho: zoho.leads,
        cierresZoho: zoho.cierres,
        cplZoho: zoho.leads ? g.spend / zoho.leads : null,
      };
    })
    .sort((a, b) => b.leadsZoho - a.leadsZoho || b.spend - a.spend);

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 20 }}>
        <KpiCard
          label="Inversión (período)"
          value={fmtMoney(totalInversion)}
          delta={<KpiDelta current={totalInversion} previous={prevInversion} fmtAbs={fmtMoney} />}
        />
        <KpiCard
          label="Resultados"
          value={totalResultados.toLocaleString("es-MX")}
          sub="Leads reportados por Meta"
          delta={<KpiDelta current={totalResultados} previous={prevResultados} fmtAbs={(v) => v.toLocaleString("es-MX")} />}
        />
        <KpiCard
          label="Costo por resultado"
          value={fmtMoney(costoPromedio)}
          delta={<KpiDelta current={costoPromedio} previous={prevCosto} invert fmtAbs={fmtMoney} />}
        />
        <KpiCard
          label="CTR promedio"
          value={ctrPromedio !== null ? `${ctrPromedio.toFixed(2)}%` : "—"}
          sub="Qué tan relevante es el creativo (video vs. estático)"
          delta={<KpiDelta current={ctrPromedio} previous={prevCtr} fmtAbs={(v) => `${v.toFixed(2)}%`} />}
        />
      </div>

      <Card style={{ marginBottom: 20 }}>
        <SectionLabel>Filtrar tabla de anuncios</SectionLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
          <TabButton active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
            Todos
          </TabButton>
          <TabButton active={statusFilter === "active"} onClick={() => setStatusFilter("active")}>
            Activos
          </TabButton>
          <TabButton active={statusFilter === "paused"} onClick={() => setStatusFilter("paused")}>
            Pausados
          </TabButton>
          <select
            value={campaignFilter}
            onChange={(e) => setCampaignFilter(e.target.value)}
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              border: `1px solid ${COLORS.border}`,
              fontFamily: FONT_BODY,
              fontSize: 13.5,
              color: COLORS.navyDeep,
              fontWeight: 600,
              background: "#FFFFFF",
              marginLeft: 4,
            }}
          >
            <option value="all">Todas las campañas</option>
            {campaignOptions
              .filter((c) => c !== "all")
              .map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
          </select>
          <span style={{ color: COLORS.muted, fontSize: 12.5 }}>
            {filteredRows.length} de {rows.length} anuncios
          </span>
        </div>
      </Card>

      <Table
        columns={[
          { key: "campaignName", header: "Campaña" },
          { key: "adsetName", header: "Adset" },
          { key: "adName", header: "Anuncio" },
          {
            key: "statusLabel",
            header: "Estado",
            render: (r) => <StatusPill label={r.statusLabel} kind={r.statusKind} />,
          },
          { key: "spend", header: "Inversión", align: "right", render: (r) => fmtMoney(r.spend) },
          { key: "resultado", header: "Leads", align: "right", render: (r) => r.resultado.toLocaleString("es-MX") },
          { key: "costoPorResultado", header: "CPL", align: "right", render: (r) => fmtMoney(r.costoPorResultado) },
          { key: "reach", header: "Alcance", align: "right", render: (r) => r.reach.toLocaleString("es-MX") },
          {
            key: "impressions",
            header: "Impresiones",
            align: "right",
            render: (r) => r.impressions.toLocaleString("es-MX"),
          },
          { key: "frequency", header: "Frecuencia", align: "right", render: (r) => r.frequency.toFixed(2) },
          { key: "uniqueCtr", header: "CTR único", align: "right", render: (r) => `${r.uniqueCtr.toFixed(2)}%` },
        ]}
        rows={filteredRows}
      />
      <SourceNote>Meta Marketing API (en vivo, vía función serverless de Vercel)</SourceNote>

      <div style={{ marginTop: 32, marginBottom: 10 }}>
        <SectionLabel>Mejores Adsets — cruce con pipeline de ZOHO</SectionLabel>
        <div style={{ color: COLORS.muted, fontSize: 12.5, marginBottom: 14 }}>
          Compara lo que Meta reporta por adset contra los leads que REALMENTE entraron a ZOHO con ese
          adset en su <code>utm_campaign</code>. Es una coincidencia de texto aproximada (ZOHO guarda
          "campaña + adset" concatenados ahí) — úsalo como dirección, no como verdad absoluta al 100%.
        </div>
      </div>
      <Table
        columns={[
          { key: "campaignName", header: "Campaña" },
          { key: "adsetName", header: "Adset (audiencia)" },
          { key: "spend", header: "Inversión", align: "right", render: (r) => fmtMoney(r.spend) },
          { key: "resultado", header: "Resultados Meta", align: "right", render: (r) => r.resultado.toLocaleString("es-MX") },
          { key: "costoPorResultado", header: "Costo/Resultado Meta", align: "right", render: (r) => fmtMoney(r.costoPorResultado) },
          { key: "leadsZoho", header: "Leads en ZOHO", align: "right" },
          { key: "cierresZoho", header: "Cierres ZOHO", align: "right" },
          { key: "cplZoho", header: "CPL real (ZOHO)", align: "right", render: (r) => fmtMoney(r.cplZoho) },
        ]}
        rows={adsetRows}
      />
      <SourceNote>Query-Meta (o API en vivo) + Base ZOHO OPS 2026, cruzados por texto (utm_campaign)</SourceNote>

      <div style={{ marginTop: 32, marginBottom: 10 }}>
        <SectionLabel>Mejores Anuncios — cruce con pipeline de ZOHO</SectionLabel>
        <div style={{ color: COLORS.muted, fontSize: 12.5, marginBottom: 14 }}>
          Mismo cruce, ahora a nivel anuncio/creativo, contra el campo <code>utm_content</code> de ZOHO.
        </div>
      </div>
      <Table
        columns={[
          { key: "campaignName", header: "Campaña" },
          { key: "adName", header: "Anuncio (creativo)" },
          { key: "spend", header: "Inversión", align: "right", render: (r) => fmtMoney(r.spend) },
          { key: "resultado", header: "Resultados Meta", align: "right", render: (r) => r.resultado.toLocaleString("es-MX") },
          { key: "costoPorResultado", header: "Costo/Resultado Meta", align: "right", render: (r) => fmtMoney(r.costoPorResultado) },
          { key: "leadsZoho", header: "Leads en ZOHO", align: "right" },
          { key: "cierresZoho", header: "Cierres ZOHO", align: "right" },
          { key: "cplZoho", header: "CPL real (ZOHO)", align: "right", render: (r) => fmtMoney(r.cplZoho) },
        ]}
        rows={adRows}
      />
      <SourceNote>Query-Meta (o API en vivo) + Base ZOHO OPS 2026, cruzados por texto (utm_content)</SourceNote>
    </div>
  );
}

function PipelineMensualFase({ leads, periodKey }) {
  const { rows, columns } = computePipelinePorFase(leads, periodKey);
  const esMensual = periodKey === "mes";
  const chartData = rows.map((r) => {
    const entry = { label: r.label };
    columns.forEach((c) => (entry[c] = r.fases[c] || 0));
    return entry;
  });

  return (
    <div>
      <div style={{ color: COLORS.muted, fontSize: 13, marginBottom: 14 }}>
        Para cada {esMensual ? "mes" : "semana"} de ENTRADA, muestra en qué Fase están HOY los leads que
        entraron en ese {esMensual ? "mes" : "período"}. Las fases menos frecuentes se agrupan como "Otras".
        Cambia automáticamente entre mes y semana según el rango de fechas que tengas seleccionado arriba.
      </div>

      <Card style={{ marginBottom: 20 }}>
        <SectionLabel>Composición de fase por {esMensual ? "mes" : "semana"} de entrada</SectionLabel>
        <div style={{ height: 300 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" />
              <XAxis dataKey="label" type="category" stroke={COLORS.muted} tick={{ fontSize: 11 }} />
              <YAxis stroke={COLORS.muted} tick={{ fontSize: 11 }} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {columns.map((c, i) => (
                <Bar key={c} dataKey={c} stackId="fase" fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Table
        columns={[
          { key: "label", header: esMensual ? "Mes de entrada" : "Semana de entrada" },
          { key: "total", header: "Total", align: "right" },
          ...columns.map((c) => ({
            key: c,
            header: c,
            align: "right",
            render: (r) => r.fases[c] || 0,
          })),
        ]}
        rows={rows}
      />
      <SourceNote>{SOURCE_ZOHO}</SourceNote>
    </div>
  );
}

/* -------------------------------------------------------------------------
   FILTRO GLOBAL DE FECHAS
   ------------------------------------------------------------------------- */

const DATE_PRESETS = [
  { key: "today", label: "Hoy" },
  { key: "yesterday", label: "Ayer" },
  { key: "7d", label: "Últimos 7 días" },
  { key: "14d", label: "Últimos 14 días" },
  { key: "30d", label: "Últimos 30 días" },
  { key: "lastMonth", label: "Mes pasado" },
  { key: "thisMonth", label: "Mes actual" },
  { key: "all", label: "Todo el histórico" },
  { key: "custom", label: "Personalizado…" },
];

function toInputDate(d) {
  if (!d) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function DateRangeFilter({ preset, onPresetChange, customStart, customEnd, onCustomChange, rangeStart, rangeEnd, granularity }) {
  const [open, setOpen] = useState(false);
  const currentLabel = DATE_PRESETS.find((p) => p.key === preset)?.label || "Seleccionar período";

  return (
    <Card style={{ marginBottom: 20, position: "relative", overflow: "visible" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center" }}>
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setOpen((o) => !o)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 16px",
              borderRadius: 8,
              border: `1px solid ${COLORS.border}`,
              background: "#FFFFFF",
              color: COLORS.navyDeep,
              fontWeight: 700,
              fontSize: 13.5,
              fontFamily: FONT_BODY,
              cursor: "pointer",
              minWidth: 200,
              justifyContent: "space-between",
            }}
          >
            {currentLabel}
            <span style={{ color: COLORS.muted, fontSize: 11 }}>▾</span>
          </button>

          {open && (
            <>
              <div
                onClick={() => setOpen(false)}
                style={{ position: "fixed", inset: 0, zIndex: 15, background: "transparent" }}
              />
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 6px)",
                  left: 0,
                  zIndex: 20,
                  background: "#FFFFFF",
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: 10,
                  boxShadow: "0 10px 30px rgba(33,29,29,0.18)",
                  minWidth: 220,
                  padding: 6,
                }}
              >
                {DATE_PRESETS.map((p) => (
                  <div
                    key={p.key}
                    onClick={() => {
                      onPresetChange(p.key);
                      setOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "9px 12px",
                      borderRadius: 6,
                      cursor: "pointer",
                      background: preset === p.key ? "rgba(36,81,147,0.08)" : "transparent",
                      fontSize: 13.5,
                      color: COLORS.text,
                      fontFamily: FONT_BODY,
                    }}
                    onMouseEnter={(e) => {
                      if (preset !== p.key) e.currentTarget.style.background = COLORS.bgCardAlt;
                    }}
                    onMouseLeave={(e) => {
                      if (preset !== p.key) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <span>{p.label}</span>
                    {preset === p.key && <span style={{ color: COLORS.navy, fontWeight: 700 }}>✓</span>}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {preset === "custom" && (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="date"
              value={customStart}
              onChange={(e) => onCustomChange(e.target.value, customEnd)}
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                border: `1px solid ${COLORS.border}`,
                fontFamily: FONT_BODY,
                fontSize: 13,
                color: COLORS.text,
              }}
            />
            <span style={{ color: COLORS.muted, fontSize: 13 }}>a</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => onCustomChange(customStart, e.target.value)}
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                border: `1px solid ${COLORS.border}`,
                fontFamily: FONT_BODY,
                fontSize: 13,
                color: COLORS.text,
              }}
            />
          </div>
        )}

        <div style={{ marginLeft: "auto", fontSize: 12.5, color: COLORS.muted, textAlign: "right" }}>
          {rangeStart && rangeEnd && (
            <>
              {rangeStart.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })} —{" "}
              {rangeEnd.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })}
              <br />
              Agrupando por <strong style={{ color: COLORS.navy }}>{granularity === "mes" ? "mes" : "semana"}</strong>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------
   MENÚ LATERAL
   ------------------------------------------------------------------------- */

const LOGO_BLANCO_B64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAL4AAABwCAYAAACglspZAAABgWlDQ1BzUkdCIElFQzYxOTY2LTIuMQAAKJF1kb9LQlEUxz9akpRhUENDg0Q1aVhC1NJglAXVoAZZLfr8Ffjj8Z4S0Rq0CgVRS7+G+gtqDZqDoCiCaI7GopaS13kaKJHncu753O+953DvuWANZ5Ss3uyFbK6gBQN+12JkydXyih0bThz4ooquzoWmwjS0z3ssZrz1mLUan/vX2uIJXQGLXXhcUbWC8LTw7FpBNXlHuEtJR+PCZ8JuTS4ofGfqsSq/mJyq8rfJWjg4AdYOYVeqjmN1rKS1rLC8nL5spqj83sd8iSORWwhJ7BXvQSdIAD8uZphkghGGGJN5BA/DDMqKBvneSv48eclVZFZZR2OVFGkKuEUtSvWExKToCRkZ1s3+/+2rnvQNV6s7/GB7Noz3fmjZhnLJML6ODKN8DE1PcJmr5ecPYfRD9FJN6zsA5yacX9W02C5cbEH3oxrVohWpSdyaTMLbKbRHoPMGWperPfvd5+QBwhvyVdewtw8Dct658gNk5Gfl4sWAygAAAAlwSFlzAAALEwAACxMBAJqcGAAAFXxJREFUeJztnXm8HUWVx7+3XkICkWiCASOLAqIoiywGBRSMSAQxhkUWxY+g7AOuo8hnXBAZF9xQNlGUCSKLrCIDyDbiSFhkE1FZMqwBMSG8JKxC8n5v/jjVufXu6+rb9933EoLn+/ncz+3bXV1dt/t09alzTp0Gx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3Ecx3EcxxkOJG0g6QBJWy3vtrzUkLS2pGmSxi/vtjiApG0k3SrpAUn3S/qOpFd3WMcXJT0i6bn4OXWk2rsiImlnSXMlPSXpekkrL+82OYCkIOlnkp6Mn99JanSw/1hJhyWC/5ORbO+KhqTTotAXH38iDgOh6wpCEDA6WbUp8M4O9v8n8N/Jqto3zb8IjyTLLwD3La+GvJzoWvAlvQLYob+//2/J6o90UWVlmyRtLmlqF/WvaBwH7Af8FNgjhLBwObfnZUHXgg/sDKwE/ChZNz3eEEOhXY//ZuBf5nEfQngxhHBxCOHzIYT/Xd7tebkwHII/A5jVaDQuBubFdSsD7xtife0Ev6PBs+OU0ZXgS3oV8F7gvBBCH3BRsnnX4W6TpJWAjw+xXsdZSrc9/geBPuDS+Pu8ZNsOQ7Q7l/b4kiYCvwReD4waQr3OMkJST2b9SpJeEteu20Z8CLgqhPAMQAjhTkn3Am8CxmBq0Jkd1jlA8CW9EfgPYEdglbj6YEmbY1aOJfHTB9waQvhpWaWSVsWeQpti44T1gUXA48ADwKkhhNmZfXuATYDt4uctwL7AXcBh2DhnPWAhMBu4BzghhPB0Use2wBeA1wATgaeB24CfhBBuyxz3DcA2wPbA24GTQgintpQZD0wDtgXeAbwYQtg+bhsFTAcOBTYAngHOBn4UQni+pZ7Xxv8yBRuzjYnfLwBXABeEEO7NtHNl4P2xDdsCEyRtHUJ4UtIGwEFx+2uBxZLuBi4GzgkhzCurM3OcTTDDyQ7YeewBeoHbgWtifUvq1jckJL1W0nxJu7Ws/3Ri0/9NzbrWSuz4v2zZNlHSPpLOlbQgfq6W9BlJh0s6UNJ+kj4cL15Z/etHR9uC6ATaV9Jqkl4h6T2Srozt/U6ZD0LS6pJOiI66wp4+Q9KFkmZKmirpVZK2l3RG3H6TpHXi/p+V9FdJO0laJZ67L8dyCyR9JtPuvSXdLmlh/HynpMy2ki6T9IykZyXNietHSzpL0m2SLpf0dNz+rKSTW+p4v6RHJfVKuljSxpJWjudoN0l/kzRPUqn6Kuk1kr4lc7QV12izeG1ui9dm7Vjn5pI+FY81X9IuOblI6l9V0jmx3vMlbRHrW03SppK+IWm2pD9K2qFdfV0Rhe4hSWNb1q+fCP58SZNr1JUK/lmZMh9OTuo3O2zrJXG/xyWtWbJ9ZUl3xDIfq6jn8ELw+/r6LpQ57kJLmZ54sZ+Kwr6ZpDtlT5zW+r4Vyy2StHbmmJsngv+DirY9GIX6XkmjJJ0p6eSifZL2Sm6ORYoeYEmTJM2Jgjir9f/EMmtK+nu8nntVtOHXxTXq6+vbX9Jjkt6SKXtock22qKjzdZJujMfevaLcGpJuiHL3/ly5gm50/D2BS6MDqllhCPdjKgCY2jKjw3pzVp0XkmXVrUzSxph6AnBFCOGx1jLxsX91/PlNSWtlqntuaSMbjfcCX44OvLSuPuCH8efawLnAianak3BuUR3w0cwx+5Pl0ZkyYKoewPPAEZj16zNF+0II5wGHY2rh3YmqMw0YF5cvaf0/cd/HgMsweTlWUq4di5Plo4GDQwh/y5T9BXYdxwJfKSsgM55cDGwI/CKEcFFZudjGudj/awA/l/T2XFkYouDHu3gTmheulVSvz96lHbYp1UlrCz52YgvuqSj3h/g9DvtvZaRC+McQwj8y5dKbayJQ+hQD/gwUdeybKZN2BFVjskLwxwAHA58PIaSCSAjhDOBtmCWuIPW3PFpR/83xexKmx1fSaDSuCSFcltseQniOphd6O0mrlBT7HrAudu2/0e6YIYQ7sPHIWOCcsqfs0rLtKsuwD3bBbshsv4BmD72lpPU7qHtYe3xsAHk0cA4Dza2tpBaonPMtFfxrKupKy93YOpAsCCH0A0/En6tX1FdQR/DXAeaEEP6aOebswhgROQs4DTiWfEcGNogseGWmTHrtLq+oq6DwQgdsIL2UKDNFp/mXEMKTNeoDuDB+T6DC9N2xVUdmKdgTmBUv3CBCCIsk/Q7YKa46BDiy5iFygp+qVKXHzbSlHzghtz2OUbbGwgIKcj1FetxnKw7blywvaNPE4oYuNQHSeY8PFt5Qi3gTfDG3Paob78M6j4IqlavgqbptyHAAzf+eU5fK+EuyvC+Zaz8Uc+Y7sd5pqqSfYd7aRvwUT5AGkA4id5X0pdZHb4bcU+jFZLmTHn8A8UJujYU9bIWZC6/CzJBTYrGc/yEV/CoPc9q+dp7o4v/WuRZ1dPx+4MoadZUSxzdTaZ4fsKfbBdjYAeq1dcjXKJJqCXd3sF+qfr5R0rgQwqBOaiiCvzs2yLsbe5xMKCmzEha2ULAa8C7gfzJ1pjdETlBSoevopMrs8LsC+2P66RzgfCwA7JYQwvNq2oihXo9fpSam7WunTi7tLCSFksFlpz3+4hZVpi1Rvz4U2A3YCDNOnAt8uzAGSJpGU/DrPJ36MmXqMiZZri34IYSnJD1H0+fzakqezh0JvqQxwAeAr4UQft6mbA/wW6AwVe1BXvDT3rxOWHInVp03Y4/+jbHe4NPA2dH6kpJezDqCX7fHbyf4aT09VP+3nMBBU9CqygxC0vbAKcBkzBE0LYRwa5t25p48aZlOe/xW9TU1SnTaQc/FBsVgxoWHWwt0Orh9D3YnVQ0SrWITrGOTVdOVnz2U9vjDETgHgKR1gWsxoX8K2CmEcGaJ0MPAk5u7sCOp6rS2oWz/OoJf+/xJehvmyZ2MqXrTM0LfSk4Qh7PHT8d0r+tw31cly3PLCnQqZHsAV4cQ2g3YCmZhIQFgZsKcY6HTHr9uD3AMTZXr9BDCoDu/wzpHoscPmeUy6gh+Q/VnwJ1M8/x8L2d9KupNlusMbrvV8dMJN+vU3UkWwlGo3/Noyt8AOukdxmMxKee1K7u0cutZL0hW5bx+dXT8lLqCn3oEr2hTNtUp64wzXqo9fmudpcjCOzZIVuXU0LI6l4WOn87K66TH3y5Zvjxreeygwt0xr99VHewDA2+UqZImDWqENW5pj5WpJx2wZR0TLaQD7yrnDFgQWDvqDm47EcJUiNrd0MMm+AzukavMs2DWr4I6qk4dk3N/ZhnMoXh7XN64Rl0F05Ll7PztTgR/OnBlCOGFtiXTA5jLunCm9GA+gDKKC5ET/PtoPrY2qnn41INaGsCWsHOy3G2PX7cctO9J0/2rrleqLta5rnOxCNGCDXMFJU1goGe5jqpTp8fP3hyxMzwC0/U3kNR2Hnf0yUyPP88PIWQ99bUEX9JqmP2+3eMwx8XJck7dqezx44konjZblMXTSGpI+kISS3J2svmDucZJOlJSb257wkjr+N30+KnDqK1lJ57P1PO+Y1k5Sa/Ees5ra9Q/nKoOIYS7gc9h5/0nkrLe7XjNT8IGtn/ArHf5utsdPDp8foRdlKF6elPVZBNJB5VYeH4bvycrP1/3BCxuYxRwdBosFev7PrBZ4ig7DbgzLu8n6R0tbZso6VjMhHcoZtkA8zuUkT5yx2TKgMWzFIyXzRwbRDy36Xkoi1dJo1vHl52baIdPp2TWCX8A+BRNU98esWdP690CuA4bgx1BM8RgslomlEgax0BrSuVTOaq86XkqVWdCCOcAB2LX5HyVhB3Hm/NszPhyKjYpv2qgXtmwUZIuiqGlRZjxE7LY9TfWrGOGLIb9yZLPbEkbJmXfJOm6GDo7W9JmmTo3jW1YIIu/PkXS6ZLukXRiq5DJ8vYcLYsnXyDpZknfl8XN98YnxNhY9h0xtLWI+V83rp8oi68vYvEXSvqHLDa8NSz5yFhvWvavaokWlMXRP5GUmxv/94FJma/Edi9MPg+l50Y2F+AeWVKuh+L5vietp801WlUWz/6ELKT5bEknycK0/0/S/oozqiTtIumu+P/+EgUOSa+XhUUvaPmckTnmZrG9reWzycRkodE/lM0bmCULu/6NpN9HGb1UHWTfqNQ/ZQ6rNbFHzTPx88/cSDmz/3oVRe5t9VTKrEdrAA9WzaaRZWzbOJYVFph1U0X5Sdjsq8WYPrw47jOvpVwDGNfq/ZQ9UQLwQpt2jcF68RcwL2pp2XicVWO5F6vOaby5RmMe8cWtoeDDgUyd3QozOwdsfHRr65gudiyrY+fhiWT9Wliv3Eg+D+TSocieUqMwlaj4LGknW7Kn/BRMLhvYoPyWTmZywQgkb5J0JCaQzwPXsyymgznO8kbSRpKOkc2YmS/ppOXdJsdppc7gdlNJ0yVtqfzMm2aFFgee2sz3ls2CcpyXDO3S9e0JfA34O7A3cK5sEvN6bQZPu/b39xc29wYWj+84KwayydAHxOXVo9VhVdmE6jtUYnmJo+/5S5Ys+WS0FMyXdHer9cNxlifthPFZLKcLWC6ZJzFPWj/m9Ssza87ARvwzgcLKMglom0bCcV4SyPKrzJblQfmTpK1l3tEDZSkfBoUByOzfZ8TljyaD3NOX/T9wnCEQHRaz42crmVPruL6+vuuXLFkyKCuALAfKfEkz4u9Vo8NhfnQy5CYp545fmnJO5pRabajqk6QxMqdUnZiTYSd2HmNjG9Yo+4/OyJI94bIMaZ/GojJnYtPSHgfObzQapzYaje9KWjOEkGb32g1Tj64ECCE8LemKuL5IKfiLqgbJ3OT7YiHFGwGnA0dJeitwFKY2jcPiRdaVdBNwTLsJFDLv7KHYIH1tLG3g6PjUegBzef+8cKhFB0uRCe5pmg68u0IIp2SOcQjN6Yv9wGkhhLOS7eOx/DkHY+EJvfG/TJB0A/CfIYQ/V/0PZwSJPdJ1kj4Uf39c0n2SNkrKbBifBGsm665Ty6t8ZCn6CnXnUtogS0f3KTVd9GfKXnw2S9KHlCQklbSDLMPXQkl7V9TZI+lamav9ZkmvT7atJsuI1itz1Y9Ktk2SufB74+caVeT9j+ftq/G/fkDJhBBJb5G56Xsl/VRJBrr4pLwmbqubjcIZbmTmytmStoy/e2Q5Fc8qLma8yNcXAidp3XjBp7XU1SOLVSmEP5elrLUN8yQtXLx48blRXSoNfYjjiCJ2Zt1MmU8kwjsoeCoK+MNx+ydbtq0V290riw1qF+bxK1ngW+v638Q6HlSJyhfPX9HG2q9ScoZGOx25H5bOpPoSsCXNFBwBm+hRhPPuEpd/N+AAtu8lyarpdEBPT89OWHbfBzJFisRFY7GJ8GUUyU4fL0u0FGNOfhZ/HpI+VUIIj9JML/gGBs7wGYAs6O69SV3F+gZQmH7vDyEsKmnDg8Af48+Dc8dwhoec4M/BgqeWhvHGCSWfpRnGOhkbIxTJfqYDF2Vy56R5XjpNKTiXioRQWKrvItDtDZkyRdazXOY3sHR+YBNWxrVsm5ksVwnlIcDvS+b2Bprh0VWvMy32a5uizxkhJB0lM2EOyi4ctx8j6Yi4XKg5b82UHS0LYy3Unexsn2SfIhx3Vo2yj8Sy2TGEzLGWe+nEGNlrNQtVY1LL9lFRXeuVhVQPmgMqaUIcb5Q+dWIdq1S0YWwyDnmo8g87XVNlRvsuZjm5VNKPsWy5Y7C8knthYb0/jmWL6YQ7Kx+X04sl8webDVWVwDWlkylsZRM5gKUZf4GlocNbYS+ImIJlf0hfCjGmZd8lMt/EUVgIxgHAV1sO8VEsXeBvKSFGqC6NUo2D5CnYXNZtMAdhEQLsrzwdYdqeYJm5b0dMtQmY6e/6qPsW+ustWAqIPgZPIC5+99Ccq3kfsG2bGPR5WPz5n0II727TxoexRKa3hRBKXwwgi6ffG8sDORW4EVOBbsYmNe9KUzefEtOdp/u/GlOHxmIzkTYqZvnEMcHtWKKq4yrauTZmqt0RmxtwE5aC5YbYju9j5tBnQgi1U2o4ywFJb4vqy6Ztyq0TLRqFupNLxV2UL1Sda6vKxbIPV5WV9BFZvFBvtLqUeZynJ6pO7mUGxydlPpas30UWl1T6Eoyo5hwRVaF5shlga5SUmxnrntPuPzvdMRyBY3thasJdVYVCCI8AxyerctkWWulq0rLsLRonYTO1LgH2CSH8vc1uufm0M5PlwxJ9fX8sh0tp8iIsheHXsafFYSGEf48vMmilUNVc1Rlhun3d52jMG3thzemIqVlzD9Vz1XeTGXk8cGL8uQgTujrtHFu2MoRwJ3BH/PkmYErs5adiHuayNmxH05x6WQjhwrJykcKa5II/wnTb42+PzbOsupjNg5mZr3jD3xoMzGWTo5sef2uaWQz+3GauapoyoyqGZ2ayvBv2xHuQ5htVytpQkJ0THHHBX0Z0K/h7ALdH50td0p7xoBrlu8nBmKa7qMqbCQMFtErwLqKZ1W034BPYoDbXzvSp1u4mLtJ7uOCPMEMW/PiIn8HA3Jh1uIRmBq9tcgPJhG56/HSQmD2OLIwi9/K1AcSXDBRpEVfHHF5V+USvTpazL7yW9D4seM5ZBnTT4x+G9Wa/7uiApm6kwtAu/0ul4MvSXeTSj9+IJUQC2LjMGSfLznVqf39/+v6ndudlZrJ8edmbFBNuw7L2giW1GpRcKt7859D06oZ2MUHOMkbSBtFr+5gsCdJ+sjdw19l3rCxq8dbErPmo7B22E2KZ10g6RJZgaKEsydEOZQPhWPYgNSM5Z0t6twZGRU6URY32Ru/rlrLAubGSdpd0fzQ19ki6JZY7vtV7W3Lsq2PZtuEFkt4qi27tlfSDeLMhabIsodXjkt4uaYrMM9wr6d9y5lGnezruVSR9HVgLi7svPg+FEM6s3NH23QeL6WnQdG4VnytDCGdJ2hp7ZfsrsMFeMeD7XGtyIlmIxOGYLj8ayx+5CPh6CGF+Um4VzGm0E5ZN95U0A+r+q0hEJQtF2Cduvze+HjP3X36FJTV6Vx1LURT2PbFxwTqYUeAW4PfAKUXgWlS7dsVey/nLEELV2xUdpx6SulYjZG9v75WUfZ2k47zskPRtWWBcaxSn47w8kTRe0hxJ2Zgcx1lhkc0wO07SVanJVTYNc55KQpMdZ4Un9uxFQNr5cV2QpaX+wfJun+OMCNG8eX0U/LnxRtg3mh7bvVbIcVZcJG0T/Qy9spdO3KuaL1xwnBUaWZaFH0u6UPYWcMdxHMdxHMdxHMdxHMdxHMdxHMdxHMdxHMdxHMdxHMdxHMdxHMdxHMdxHMdxHMdxHMdxHMdxHMdxHMdZDvw/uZqR05pgYOoAAAAASUVORK5CYII=";

const SIDEBAR_WIDTH = 240;

function Sidebar({ tabs, activeTab, onTabChange, updatedLabel }) {
  return (
    <div
      style={{
        width: SIDEBAR_WIDTH,
        minWidth: SIDEBAR_WIDTH,
        background: COLORS.navyDeep,
        minHeight: "100vh",
        padding: "28px 18px",
        display: "flex",
        flexDirection: "column",
        position: "sticky",
        top: 0,
        alignSelf: "flex-start",
      }}
    >
      <img
        src={LOGO_BLANCO_B64}
        alt="Altamirano & Anaya"
        style={{ width: 170, height: "auto", display: "block" }}
      />
      <div style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", marginTop: 10, marginBottom: 6 }}>
        ActionCoach · Rockin
      </div>
      {updatedLabel && (
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", marginBottom: 24 }}>{updatedLabel}</div>
      )}

      <div
        style={{
          fontSize: 10.5,
          textTransform: "uppercase",
          letterSpacing: 0.8,
          color: "rgba(255,255,255,0.4)",
          fontWeight: 700,
          marginBottom: 10,
          marginTop: updatedLabel ? 0 : 24,
        }}
      >
        Vistas
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {tabs.map((t) => {
          const active = activeTab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onTabChange(t.key)}
              style={{
                textAlign: "left",
                padding: "10px 12px",
                borderRadius: 8,
                border: "none",
                borderLeft: `3px solid ${active ? COLORS.crimson : "transparent"}`,
                background: active ? "rgba(255,255,255,0.10)" : "transparent",
                color: active ? "#FFFFFF" : "rgba(255,255,255,0.72)",
                fontWeight: active ? 700 : 500,
                fontSize: 13.5,
                fontFamily: FONT_BODY,
                cursor: "pointer",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* =========================================================================
   APP PRINCIPAL
   ========================================================================= */

export default function App() {
  const [status, setStatus] = useState("loading"); // loading | error | ready
  const [errorMsg, setErrorMsg] = useState("");
  const [leads, setLeads] = useState([]);
  const [investment, setInvestment] = useState([]);
  const [tab, setTab] = useState("resumen");

  const [datePreset, setDatePreset] = useState("all");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [metaRows, googleRows, zohoRows] = await Promise.all([
          fetchCsv(TABS_SOURCE.meta),
          fetchCsv(TABS_SOURCE.google),
          fetchCsv(TABS_SOURCE.zoho),
        ]);
        if (cancelled) return;
        assertColumns(metaRows, ["Year", "Month", "Date", "Total Cost", "Website leads"], TABS_SOURCE.meta);
        assertColumns(googleRows, ["Date", "Month", "Cost", "Conversions", "Campaign"], TABS_SOURCE.google);
        assertColumns(zohoRows, ["ID de registro", "Fase", "Fuente de Sospechoso"], TABS_SOURCE.zoho);
        const meta = processMetaInvestment(metaRows);
        const google = processGoogleInvestment(googleRows);
        const zoho = processZohoLeads(zohoRows);
        setInvestment([...meta, ...google]);
        setLeads(zoho);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err.message || String(err));
        setStatus("error");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Las pestañas Query-Meta/Query-Google traen historial más largo (desde
  // 2025) que la pestaña de leads (Base ZOHO OPS 2026). El rango de fechas
  // efectivo (para el preset "Todo" y como tope de los presets relativos) se
  // ancla en las fechas de los LEADS, no de la inversión — así nunca se
  // vuelve a sumar inversión de un período sin leads correspondientes.
  const dataExtent = useMemo(() => {
    const dates = leads.map((l) => l.horaCreacion).filter(Boolean);
    if (!dates.length) return null;
    const times = dates.map((d) => d.getTime());
    return { min: new Date(Math.min(...times)), max: new Date(Math.max(...times)) };
  }, [leads]);

  const { rangeStart, rangeEnd, granularityAuto } = useMemo(() => {
    if (!dataExtent) return { rangeStart: null, rangeEnd: null, granularityAuto: "mes" };
    // "Hoy"/"ayer" se anclan al día más reciente que SÍ tiene datos (no al
    // reloj real), para que nunca muestren una ventana vacía si el Sheet
    // todavía no se actualiza con el día calendario actual.
    const anchorDay = new Date(dataExtent.max.getFullYear(), dataExtent.max.getMonth(), dataExtent.max.getDate());
    let end = new Date(anchorDay.getFullYear(), anchorDay.getMonth(), anchorDay.getDate(), 23, 59, 59);
    let start;
    if (datePreset === "today") {
      start = new Date(anchorDay.getFullYear(), anchorDay.getMonth(), anchorDay.getDate(), 0, 0, 0);
    } else if (datePreset === "yesterday") {
      const y = new Date(anchorDay.getTime() - 86400000);
      start = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0);
      end = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59);
    } else if (datePreset === "thisMonth") {
      start = new Date(anchorDay.getFullYear(), anchorDay.getMonth(), 1, 0, 0, 0);
    } else if (datePreset === "lastMonth") {
      const lm = new Date(anchorDay.getFullYear(), anchorDay.getMonth() - 1, 1);
      start = new Date(lm.getFullYear(), lm.getMonth(), 1, 0, 0, 0);
      end = new Date(lm.getFullYear(), lm.getMonth() + 1, 0, 23, 59, 59); // último día de ese mes
    } else if (datePreset === "custom" && customStart && customEnd) {
      start = new Date(customStart + "T00:00:00");
      end = new Date(customEnd + "T23:59:59");
    } else if (datePreset === "all") {
      start = dataExtent.min;
    } else {
      const days = { "7d": 7, "14d": 14, "30d": 30 }[datePreset] || 30;
      start = new Date(end.getTime() - (days - 1) * 86400000);
      if (start < dataExtent.min) start = dataExtent.min;
    }
    const spanDays = Math.max(1, Math.round((end - start) / 86400000) + 1);
    return { rangeStart: start, rangeEnd: end, granularityAuto: spanDays > 30 ? "mes" : "semana" };
  }, [datePreset, customStart, customEnd, dataExtent]);

  // Período anterior: mismo número de días, inmediatamente antes del rango
  // seleccionado. Se usa para calcular los deltas (▲▼) de tarjetas y tablas.
  // "Todo" no tiene período anterior (no hay más historia hacia atrás).
  const { prevRangeStart, prevRangeEnd } = useMemo(() => {
    if (!rangeStart || !rangeEnd || datePreset === "all") return { prevRangeStart: null, prevRangeEnd: null };
    const spanMs = rangeEnd.getTime() - rangeStart.getTime();
    const prevEnd = new Date(rangeStart.getTime() - 1000); // 1 seg antes del inicio actual
    const prevStart = new Date(prevEnd.getTime() - spanMs);
    return { prevRangeStart: prevStart, prevRangeEnd: prevEnd };
  }, [rangeStart, rangeEnd, datePreset]);

  const filteredLeads = useMemo(() => {
    if (!rangeStart) return leads;
    return leads.filter((l) => l.horaCreacion && l.horaCreacion >= rangeStart && l.horaCreacion <= rangeEnd);
  }, [leads, rangeStart, rangeEnd]);

  const filteredInvestment = useMemo(() => {
    if (!rangeStart) return investment;
    return investment.filter((r) => r.date && r.date >= rangeStart && r.date <= rangeEnd);
  }, [investment, rangeStart, rangeEnd]);

  const prevLeads = useMemo(() => {
    if (!prevRangeStart) return [];
    return leads.filter((l) => l.horaCreacion && l.horaCreacion >= prevRangeStart && l.horaCreacion <= prevRangeEnd);
  }, [leads, prevRangeStart, prevRangeEnd]);

  const prevInvestment = useMemo(() => {
    if (!prevRangeStart) return [];
    return investment.filter((r) => r.date && r.date >= prevRangeStart && r.date <= prevRangeEnd);
  }, [investment, prevRangeStart, prevRangeEnd]);

  const investmentTotal = useMemo(() => filteredInvestment.reduce((s, r) => s + r.cost, 0), [filteredInvestment]);
  const prevInvestmentTotal = useMemo(() => prevInvestment.reduce((s, r) => s + r.cost, 0), [prevInvestment]);

  const monthlyAll = useMemo(() => buildPeriodTable(filteredLeads, filteredInvestment, "mes"), [filteredLeads, filteredInvestment]);
  const monthlyPaid = useMemo(
    () => buildPeriodTable(filteredLeads.filter((l) => l.paid), filteredInvestment, "mes"),
    [filteredLeads, filteredInvestment]
  );
  const weeklyAll = useMemo(() => buildPeriodTable(filteredLeads, filteredInvestment, "semana"), [filteredLeads, filteredInvestment]);
  const weeklyPaid = useMemo(
    () => buildPeriodTable(filteredLeads.filter((l) => l.paid), filteredInvestment, "semana"),
    [filteredLeads, filteredInvestment]
  );

  // "Semana vs Semana" y "OPS 6 Semanas" necesitan mirar semanas COMPLETAS
  // hacia atrás para poder comparar — si el filtro global de fecha es corto
  // (Hoy, Ayer, Mes actual a inicios de mes, etc.), recortaría las semanas
  // de los bordes y rompería la comparación. Por eso estas dos vistas usan
  // siempre el histórico completo (leads/investment sin acotar al filtro),
  // en vez de filteredLeads/filteredInvestment.
  const weeklyAllFull = useMemo(() => buildPeriodTable(leads, investment, "semana"), [leads, investment]);

  // Vistas que alternan mes/semana según la granularidad automática.
  const periodAllAuto = granularityAuto === "mes" ? monthlyAll : weeklyAll;
  const periodPaidAuto = granularityAuto === "mes" ? monthlyPaid : weeklyPaid;
  const periodLabelAuto = granularityAuto === "mes" ? "Mes" : "Semana";

  const TABS = [
    { key: "resumen", label: "Resumen Ejecutivo" },
    { key: "evolucion", label: "Evolución" },
    { key: "metaAds", label: "Meta Ads" },
    { key: "pipelineMensual", label: granularityAuto === "mes" ? "Pipeline Mensual" : "Pipeline Semanal" },
    { key: "semana", label: "Semana vs Semana" },
    { key: "ops6", label: "OPS 6 Semanas" },
    { key: "sf", label: "Seguimiento Final" },
    { key: "utm", label: "Campañas UTM" },
    { key: "costos", label: "Costos por Etapa" },
    { key: "totalRockin", label: "Total vs Rockin" },
  ];
  const activeTabLabel = TABS.find((t) => t.key === tab)?.label || "";
  const updatedLabel = dataExtent
    ? `Actualizado: ${dataExtent.max.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" })}`
    : null;

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: COLORS.bg, fontFamily: FONT_BODY }}>
      {status === "ready" && (
        <Sidebar tabs={TABS} activeTab={tab} onTabChange={setTab} updatedLabel={updatedLabel} />
      )}
      <div style={{ flex: 1, minWidth: 0, padding: "28px 32px 60px", color: COLORS.text }}>
        <div style={{ maxWidth: 1100 }}>
          {status === "ready" ? (
            <div style={{ marginBottom: 4 }}>
              <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 26, fontWeight: 700, margin: 0, color: COLORS.navyDeep }}>
                {activeTabLabel}
              </h1>
              <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 2 }}>
                Altamirano &amp; Anaya · ActionCoach · gestionado por Rockin
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: 4 }}>
              <h1 style={{ fontFamily: FONT_DISPLAY, fontSize: 26, fontWeight: 700, margin: 0, color: COLORS.navyDeep }}>
                Dashboard Comercial — Altamirano &amp; Anaya
              </h1>
            </div>
          )}
          <div style={{ fontSize: 12, color: COLORS.muted, marginBottom: 22 }}>
            Datos en vivo desde Google Sheets · Query-Meta · Query-Google · Base ZOHO OPS 2026
          </div>

          {status === "loading" && (
            <div style={{ padding: 60, textAlign: "center", color: COLORS.muted }}>
              Cargando datos desde Google Sheets…
            </div>
          )}

          {status === "error" && (
            <div
              style={{
                background: "#FBE7EB",
                border: `1px solid ${COLORS.crimson}`,
                borderRadius: 10,
                padding: 20,
                color: "#8A0F2C",
                fontSize: 13,
              }}
            >
              <strong>No se pudo cargar el dashboard.</strong>
              <div style={{ marginTop: 8 }}>{errorMsg}</div>
              <div style={{ marginTop: 8, color: COLORS.muted }}>
                Verifica que el Google Sheet siga compartido como "Cualquier persona con el enlace puede ver/editar"
                y que los nombres de las pestañas ("Query-Meta", "Query-Google", "Base ZOHO OPS 2026") no hayan
                cambiado.
              </div>
            </div>
          )}

          {status === "ready" && (
            <>
              <DateRangeFilter
                preset={datePreset}
                onPresetChange={(p) => {
                  if (p === "custom" && !customStart && !customEnd && rangeStart && rangeEnd) {
                    setCustomStart(toInputDate(rangeStart));
                    setCustomEnd(toInputDate(rangeEnd));
                  }
                  setDatePreset(p);
                }}
                customStart={customStart}
                customEnd={customEnd}
                onCustomChange={(s, e) => {
                  setCustomStart(s);
                  setCustomEnd(e);
                }}
                rangeStart={rangeStart}
                rangeEnd={rangeEnd}
                granularity={granularityAuto}
              />

              {tab === "resumen" && (
                <ResumenEjecutivo
                  leads={filteredLeads}
                  investment={filteredInvestment}
                  investmentTotal={investmentTotal}
                  weeklyRows={weeklyAll}
                  prevLeads={prevLeads}
                  prevInvestmentTotal={prevInvestmentTotal}
                  hasPrevPeriod={!!prevRangeStart}
                />
              )}
              {tab === "evolucion" && (
                <Evolucion
                  monthlyAll={monthlyAll}
                  monthlyPaid={monthlyPaid}
                  weeklyAll={weeklyAll}
                  weeklyPaid={weeklyPaid}
                  granularityAuto={granularityAuto}
                />
              )}
              {tab === "metaAds" && (
                <MetaAdsPerformance
                  rangeStart={rangeStart}
                  rangeEnd={rangeEnd}
                  prevRangeStart={prevRangeStart}
                  prevRangeEnd={prevRangeEnd}
                  leads={filteredLeads}
                />
              )}
              {tab === "pipelineMensual" && <PipelineMensualFase leads={filteredLeads} periodKey={granularityAuto} />}
              {tab === "semana" && <SemanaVsSemana weeklyAll={weeklyAllFull} />}
              {tab === "ops6" && <OpsSeisSemanas weeklyAll={weeklyAllFull} leads={leads} />}
              {tab === "sf" && <SeguimientoFinal leads={filteredLeads} />}
              {tab === "utm" && <CampanasUtm leads={filteredLeads} />}
              {tab === "costos" && <CostosPorEtapa leads={filteredLeads} investmentTotal={investmentTotal} />}
              {tab === "totalRockin" && (
                <TotalVsRockin periodAll={periodAllAuto} periodPaid={periodPaidAuto} periodLabel={periodLabelAuto} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
