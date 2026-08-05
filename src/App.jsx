import React, { useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
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
  meta: "Query-Meta",
  google: "Query-Google",
  zoho: "Base ZOHO OPS 2026",
};
const csvUrl = (sheetName) =>
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;

const ASSUMED_YEAR_GOOGLE = 2026;
const PAID_SOURCES = ["rockin", "facebook ads", "instagram"];
const NO_CONTACTADO_FASE = "identificación de sospechoso";
const SEGUIMIENTO_FINAL_FASE = "seguimiento final";
const PROGRAMA_ACEPTADO_FASE = "programa aceptado";

const COLORS = {
  bg: "#0B1F3A",
  bgCard: "#11284A",
  bgCardAlt: "#152F55",
  border: "#22406B",
  gold: "#C9A84C",
  teal: "#0891B2",
  green: "#16A34A",
  red: "#DC2626",
  yellow: "#EAB308",
  muted: "#64748B",
  text: "#F1F5F9",
};

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

// Encuentra el valor de una fila probando varias claves candidatas (por si
// Papaparse renombra headers duplicados con sufijos _1, _2...)
function pick(row, candidates) {
  for (const c of candidates) {
    if (row[c] !== undefined) return row[c];
  }
  return undefined;
}

async function fetchCsv(sheetName) {
  const res = await fetch(csvUrl(sheetName));
  if (!res.ok) {
    throw new Error(
      `No se pudo leer la pestaña "${sheetName}" (HTTP ${res.status}). Verifica que el Google Sheet siga compartido como "Cualquier persona con el enlace".`
    );
  }
  const text = await res.text();
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  return parsed.data;
}

/* -------------------------------------------------------------------------
   PROCESAMIENTO: INVERSIÓN
   ------------------------------------------------------------------------- */

function processMetaInvestment(rows) {
  // columnas: Year, Month, Date, Week (Starting on Monday), Campaign name, ..., Total Cost
  const out = [];
  for (const r of rows) {
    const year = parseInt(pick(r, ["Year"]), 10);
    const month = parseInt(pick(r, ["Month"]), 10);
    const week = parseInt(pick(r, ["Week (Starting on Monday)", "Week"]), 10);
    const cost = toNumber(pick(r, ["Total Cost"]));
    if (!year || !month) continue;
    out.push({ year, month, week: isNaN(week) ? null : week, cost, canal: "Meta" });
  }
  return out;
}

function processGoogleInvestment(rows) {
  // primer bloque: Date, Week (Starting on Monday), Month, Campaign, ..., Cost, ...
  const out = [];
  for (const r of rows) {
    const month = parseInt(pick(r, ["Month"]), 10);
    const week = parseInt(pick(r, ["Week (Starting on Monday)", "Week"]), 10);
    const cost = toNumber(pick(r, ["Cost"]));
    if (!month) continue;
    out.push({ year: ASSUMED_YEAR_GOOGLE, month, week: isNaN(week) ? null : week, cost, canal: "Google" });
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

    const anioCreacion = parseInt(pick(r, ["AÑO CREACIÓN"]), 10) || (horaCreacion ? horaCreacion.getFullYear() : null);
    const mesCreacion = parseInt(pick(r, ["MES CREACIÓN"]), 10) || (horaCreacion ? horaCreacion.getMonth() + 1 : null);
    const semanaCreacion = parseInt(pick(r, ["SEMANA CREACIÓN LEAD"]), 10) || null;

    const fechaMiniCod = pick(r, ["Fecha/hora de MiniCOD"]);
    const fechaCodLuisa = pick(r, ["Fecha/hora COD Luisa"]);
    const fechaCodVictor = pick(r, ["Fecha/hora COD Víctor", "Fecha/hora COD Victor"]);
    const fechaDiagnostico = pick(r, ["Fecha/hora cita de diagnóstico", "Fecha/hora cita de diagnostico"]);

    const reachedMiniCod = isFilled(fechaMiniCod);
    const reachedCod = isFilled(fechaCodLuisa) || isFilled(fechaCodVictor);
    const reachedDiagnostico = isFilled(fechaDiagnostico);

    const propietario = pick(r, ["Propietario de Oportunidad"]) || "";
    const esAdan = normalize(propietario).includes("adan cortes");

    const campania =
      pick(r, ["utm_campaign (Sospechosos convertidos)", "utm_campaign"]) || "Sin UTM";
    const campaniaFinal = isFilled(campania) ? campania : "Sin UTM";

    out.push({
      id: idRegistro,
      nombre: pick(r, ["Nombre completo"]) || "",
      fuente,
      paid,
      fase,
      faseNorm,
      noContactado: faseNorm === NO_CONTACTADO_FASE,
      seguimientoFinal: faseNorm === SEGUIMIENTO_FINAL_FASE,
      programaAceptado: faseNorm === PROGRAMA_ACEPTADO_FASE,
      horaCreacion,
      horaModificacion,
      anioCreacion,
      mesCreacion,
      semanaCreacion,
      reachedMiniCod,
      reachedCod,
      reachedDiagnostico,
      propietario,
      esAdan,
      campania: campaniaFinal,
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

function KpiCard({ label, value, sub, color }) {
  return (
    <div
      style={{
        background: COLORS.bgCard,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 12,
        padding: "18px 20px",
        flex: "1 1 180px",
        minWidth: 160,
      }}
    >
      <div style={{ fontSize: 12, color: COLORS.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: color || COLORS.text, marginTop: 6 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 12, color: COLORS.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Delta({ current, previous, invert = false }) {
  if (previous === null || previous === undefined || previous === 0 || current === null) {
    return <span style={{ color: COLORS.muted }}>—</span>;
  }
  const diff = current - previous;
  const pct = (diff / Math.abs(previous)) * 100;
  const isGood = invert ? diff < 0 : diff > 0;
  const color = diff === 0 ? COLORS.muted : isGood ? COLORS.green : COLORS.red;
  const arrow = diff === 0 ? "▬" : diff > 0 ? "▲" : "▼";
  return (
    <span style={{ color, fontWeight: 600, fontSize: 12 }}>
      {arrow} {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "10px 16px",
        borderRadius: 8,
        border: `1px solid ${active ? COLORS.gold : COLORS.border}`,
        background: active ? "rgba(201,168,76,0.12)" : "transparent",
        color: active ? COLORS.gold : COLORS.text,
        fontWeight: active ? 700 : 500,
        cursor: "pointer",
        fontSize: 13,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function Table({ columns, rows }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                style={{
                  textAlign: c.align || "left",
                  padding: "10px 12px",
                  color: COLORS.gold,
                  borderBottom: `1px solid ${COLORS.border}`,
                  whiteSpace: "nowrap",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                }}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)" }}>
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

function ResumenEjecutivo({ leads, investmentTotal, weeklyRows }) {
  const paidLeads = leads.filter((l) => l.paid);
  const funnelAll = computeFunnel(leads);
  const funnelPaid = computeFunnel(paidLeads);
  const cplPagado = funnelPaid.total ? investmentTotal / funnelPaid.total : null;
  const cplGeneral = funnelAll.total ? investmentTotal / funnelAll.total : null;

  const last2 = weeklyRows.slice(-2);
  const alertaNC =
    last2.length === 2 && last2.every((w) => w.noContactadosPct > THRESHOLDS.noContactado.yellow);

  return (
    <div>
      {alertaNC && (
        <div
          style={{
            background: "rgba(220,38,38,0.15)",
            border: `1px solid ${COLORS.red}`,
            borderRadius: 10,
            padding: "12px 16px",
            marginBottom: 18,
            color: "#FCA5A5",
            fontSize: 13,
          }}
        >
          ⚠️ Alerta: % de no contactados por arriba de {THRESHOLDS.noContactado.yellow}% en las últimas 2
          semanas completas. Este ha sido históricamente el mayor cuello de botella del embudo.
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 24 }}>
        <KpiCard label="Leads pagados (histórico)" value={funnelPaid.total.toLocaleString("es-MX")} />
        <KpiCard label="Inversión total" value={fmtMoney(investmentTotal)} />
        <KpiCard
          label="CPL pagado"
          value={fmtMoney(cplPagado)}
          color={semaforo("cplPagado", cplPagado)}
          sub="Inversión / leads de fuentes pagadas"
        />
        <KpiCard label="CPL general" value={fmtMoney(cplGeneral)} sub="Inversión / todos los leads" />
        <KpiCard
          label="Mini-COD rate"
          value={fmtPct(funnelAll.miniCodPct)}
          color={semaforo("miniCod", funnelAll.miniCodPct)}
        />
        <KpiCard label="Cierres (Programa Aceptado)" value={funnelAll.cierres.toLocaleString("es-MX")} />
      </div>

      <div
        style={{
          background: COLORS.bgCard,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 12,
          padding: 20,
        }}
      >
        <div style={{ color: COLORS.gold, fontSize: 13, fontWeight: 700, marginBottom: 10 }}>
          Semáforo de salud del pipeline
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, fontSize: 13 }}>
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
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
   VISTA 2: EVOLUCIÓN (mensual / semanal)
   ------------------------------------------------------------------------- */

function Evolucion({ monthlyAll, monthlyPaid, weeklyAll, weeklyPaid }) {
  const [periodo, setPeriodo] = useState("mes");
  const [soloPagadas, setSoloPagadas] = useState(false);

  const rows =
    periodo === "mes" ? (soloPagadas ? monthlyPaid : monthlyAll) : soloPagadas ? weeklyPaid : weeklyAll;

  const chartData = rows.map((r) => ({
    label: r.label,
    "CPL pagado": r.cplPagado ? Math.round(r.cplPagado) : null,
    "CPL general": r.cplGeneral ? Math.round(r.cplGeneral) : null,
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

      <div
        style={{
          background: COLORS.bgCard,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 12,
          padding: 16,
          marginBottom: 20,
          height: 300,
        }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" />
            <XAxis dataKey="label" stroke={COLORS.muted} tick={{ fontSize: 11 }} />
            <YAxis stroke={COLORS.muted} tick={{ fontSize: 11 }} />
            <Tooltip contentStyle={{ background: COLORS.bg, border: `1px solid ${COLORS.border}` }} />
            <Legend />
            <Line type="monotone" dataKey="CPL pagado" stroke={COLORS.gold} strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="CPL general" stroke={COLORS.teal} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <Table
        columns={[
          { key: "label", header: "Período" },
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
          {
            key: "cplPagado",
            header: "CPL pagado",
            align: "right",
            render: (r) => (
              <span style={{ color: semaforo("cplPagado", r.cplPagado) }}>{fmtMoney(r.cplPagado)}</span>
            ),
          },
          { key: "cplGeneral", header: "CPL general", align: "right", render: (r) => fmtMoney(r.cplGeneral) },
        ]}
        rows={[...rows].reverse()}
      />
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
        por estar incompleta.
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

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 20 }}>
        <KpiCard label="Activos en Seguimiento Final" value={sfLeads.length} />
        <KpiCard label="Urgentes (>65 días)" value={urgentes} color={COLORS.red} />
        <KpiCard label="En riesgo (35-65 días)" value={enRiesgo} color={COLORS.yellow} />
        {conAdan > 0 && (
          <KpiCard label="Asignados a Adán Cortés" value={conAdan} color={COLORS.red} sub="Requieren reasignación" />
        )}
      </div>
      <Table
        columns={[
          { key: "nombre", header: "Nombre" },
          { key: "fuente", header: "Fuente" },
          {
            key: "propietario",
            header: "Agente",
            render: (r) => (
              <span style={{ color: r.esAdan ? COLORS.red : COLORS.text }}>
                {r.propietario} {r.esAdan && "⚠️"}
              </span>
            ),
          },
          {
            key: "dias",
            header: "Días en proceso",
            align: "right",
            render: (r) => (
              <span style={{ color: semaforo("diasSF", r.dias) }}>
                <Badge color={semaforo("diasSF", r.dias)} />
                {r.dias ?? "—"}
              </span>
            ),
          },
          {
            key: "horaModificacion",
            header: "Última actividad",
            render: (r) => (r.horaModificacion ? r.horaModificacion.toLocaleDateString("es-MX") : "—"),
          },
        ]}
        rows={sfLeads}
      />
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

  return (
    <div>
      <div style={{ color: COLORS.muted, fontSize: 13, marginBottom: 14 }}>
        Solo fuentes pagadas (Rockin + Facebook Ads + Instagram). Ordenado por Mini-COD rate (mejor arriba).
        Campaña identificada por <code>utm_campaign (Sospechosos convertidos)</code>; leads sin UTM (pre-abril
        2026) se agrupan como "Sin UTM".
      </div>
      <Table
        columns={[
          { key: "campania", header: "Campaña" },
          { key: "leads", header: "Leads", align: "right" },
          { key: "ncPct", header: "NC%", align: "right", render: (r) => fmtPct(r.ncPct) },
          {
            key: "miniCodPct",
            header: "Mini-COD%",
            align: "right",
            render: (r) => (
              <span style={{ color: semaforo("miniCod", r.miniCodPct) }}>{fmtPct(r.miniCodPct)}</span>
            ),
          },
          { key: "codPct", header: "COD%", align: "right", render: (r) => fmtPct(r.codPct) },
          { key: "rec", header: "Diagnóstico", align: "right" },
          { key: "convPct", header: "Conv%", align: "right", render: (r) => fmtPct(r.convPct) },
        ]}
        rows={rows}
      />
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

  const investmentTotal = useMemo(() => investment.reduce((s, r) => s + r.cost, 0), [investment]);

  const monthlyAll = useMemo(() => buildPeriodTable(leads, investment, "mes"), [leads, investment]);
  const monthlyPaid = useMemo(
    () => buildPeriodTable(leads.filter((l) => l.paid), investment, "mes"),
    [leads, investment]
  );
  const weeklyAll = useMemo(() => buildPeriodTable(leads, investment, "semana"), [leads, investment]);
  const weeklyPaid = useMemo(
    () => buildPeriodTable(leads.filter((l) => l.paid), investment, "semana"),
    [leads, investment]
  );

  const TABS = [
    { key: "resumen", label: "Resumen Ejecutivo" },
    { key: "evolucion", label: "Evolución" },
    { key: "semana", label: "Semana vs Semana" },
    { key: "sf", label: "Seguimiento Final" },
    { key: "utm", label: "Campañas UTM" },
  ];

  return (
    <div
      style={{
        minHeight: "100vh",
        background: COLORS.bg,
        color: COLORS.text,
        fontFamily: "'Inter', 'DM Sans', system-ui, sans-serif",
        padding: "28px 24px 60px",
      }}
    >
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: COLORS.gold }}>
            Dashboard Comercial — Altamirano &amp; Anaya
          </h1>
          <span style={{ fontSize: 12, color: COLORS.muted }}>ActionCoach · gestionado por Rockin</span>
        </div>
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
              background: "rgba(220,38,38,0.12)",
              border: `1px solid ${COLORS.red}`,
              borderRadius: 10,
              padding: 20,
              color: "#FCA5A5",
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
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 24 }}>
              {TABS.map((t) => (
                <TabButton key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
                  {t.label}
                </TabButton>
              ))}
            </div>

            {tab === "resumen" && (
              <ResumenEjecutivo leads={leads} investmentTotal={investmentTotal} weeklyRows={weeklyAll} />
            )}
            {tab === "evolucion" && (
              <Evolucion monthlyAll={monthlyAll} monthlyPaid={monthlyPaid} weeklyAll={weeklyAll} weeklyPaid={weeklyPaid} />
            )}
            {tab === "semana" && <SemanaVsSemana weeklyAll={weeklyAll} />}
            {tab === "sf" && <SeguimientoFinal leads={leads} />}
            {tab === "utm" && <CampanasUtm leads={leads} />}
          </>
        )}
      </div>
    </div>
  );
}
