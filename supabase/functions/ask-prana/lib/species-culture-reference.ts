/**
 * Compact Vannamei + Tiger culture reference for Ask Prana prompts.
 * Prefer farm/pond measured data when present. These tables are REFERENCE ONLY
 * (helpful for no-records joins and culture-programme questions).
 */

export type SpeciesCultureKind = "vannamei" | "tiger" | null;

export function detectSpeciesCultureKind(
  question: string,
  pondSpecies?: string | null,
): SpeciesCultureKind {
  const q = `${question} ${pondSpecies ?? ""}`.toLowerCase();
  if (
    /\bvannamei\b/.test(q) ||
    /\blitopenaeus\b/.test(q) ||
    /\bwhiteleg\b/.test(q)
  ) {
    return "vannamei";
  }
  if (/\btiger\b/.test(q) || /\bmonodon\b/.test(q) || /\bblack\s*tiger\b/.test(q)) {
    return "tiger";
  }
  return null;
}

export function isSpeciesCultureQuestion(question: string): boolean {
  const q = question.toLowerCase();
  if (detectSpeciesCultureKind(q)) return true;
  return (
    /\b(feed(ing)?\s+programme|feeding\s+program|culture\s+details?|reference\s+(feed|chart|programme)|blind\s+feed|feed\s+rate|water\s+quality\s+target|mineral\s+profile|check\s*tray\s+(time|quantity)|how\s+much\s+(to\s+)?feed)\b/
      .test(q) ||
    /\b(recommend|suggestion|guidance).{0,40}\b(feed|culture|stocking|water)\b/
      .test(q)
  );
}

function vannameiReferenceBlock(): string {
  return `
VANNAMEI (P. vannamei) CULTURE REFERENCE (not measured farm data)
Basis: ~100,000 stocked shrimp (1 lakh), density guide 30–60 pcs/m².

Early feed checkpoints (kg/day per lakh, printed chart):
- Day 1: 2.0 kg (code 7701)
- Day 10: ~5–7 kg
- Day 15: 6.6–9.4 kg (code 7702)
- Day 20: ~9–12 kg
- Day 27: 13.8–16.7 kg
- Day 30: 15.9–18.8 kg
Operational Day 1–15 blind-feed mid values used in-app: 2.0, 2.4, 2.8 … up to 8.1 kg/lakh on Day 15 (scale by stocked_PL/100000).

Growth-stage checkpoints (printed):
- DOC 30: MBW 3–4 g; feed rate ~5.0–5.8%/day; tray 2%; check 2.5 h; code 7702P; feed ~18–20 kg/lakh
- DOC 60: MBW 9–12 g; feed rate ~3.5–3.9%/day; tray 3%; check 2 h; code 7703S; feed ~35–42 kg/lakh
- DOC 90: MBW 20–22 g; feed rate ~2.4–2.6%/day; tray 5%; check 2 h; code 7703P; feed ~52–53 kg/lakh
- DOC 120: MBW 30–33 g; feed rate ~1.8%/day; tray 5%; check 2 h; code 7704; feed ~59 kg/lakh

In-app DOC band model (join-existing no-records / VANNAMEI_120_DAY_REFERENCE) also provides ABW + feed-rate + kg/lakh ranges by DOC 1–120. Prefer join_snapshot.vannameiReference when present.

Water quality targets:
- pH 7.5–8.3 (AM 7.5–8.0, PM 8.0–8.3)
- DO AM >4.0 ppm; DO PM >6.0 ppm
- Alkalinity 80–200 ppm; NH3 <0.5 ppm
- Carbonates >20 ppm; Bicarbonates >80 ppm; Hardness >1500 ppm
- Secchi: month1 50–60 cm; month2 40–50 cm; month3 30–40 cm
- Vibrio yellow max 10³ CFU/mL; green max 10² CFU/mL

Minerals: Ca min 150 / opt 300 / max 600 ppm. Ca:Mg:K by salinity — <10 ppt 1:1:1; 10–20 ppt 1:2:1; >20 ppt 1:3:1.
Test: daily AM/PM pH+DO; weekly alkalinity, ammonia, carbonates/bicarbonates, hardness, Ca/Mg/K, plankton, Vibrio.
`.trim();
}

function tigerReferenceBlock(): string {
  return `
BLACK TIGER / TIGER PRAWN (P. monodon) CULTURE REFERENCE (not measured farm data)
Basis: 100,000 stocked shrimp example; assumed survival for biomass tables often 85% (adjust from farm sampling).

Early feeding estimate (kg/day per lakh):
- Day 1 food: 2.0 kg
- Increase +0.2 kg/day on days 2–10
- Increase +0.3 kg/day on days 11–20
- Increase +0.4 kg/day on days 21–30
- Increase +0.5 kg/day on days 31–60
Examples at 1 lakh: Day 10 ≈ 3.8 kg/day (cum ≈ 29 kg); Day 20 ≈ 6.8 (cum ≈ 87.6); Day 30 ≈ 10.8 (cum ≈ 184.8); Day 60 ≈ 27.8 (cum ≈ 1113.8).
Scale: kg/day = table_kg × (stocked_count / 100000).

Biomass-based feed (% of live biomass / day), ~4 feedings/day, tray check ~2 h:
- 3–5 g: 6.5% → 5.8%
- 5–7 g: 5.8% → 5.2%
- 7–9 g: 5.2% → 4.8%
- 9–10 g: 4.8% → 4.5%
- 10–12 g: 4.5% → 4.2%
- 12–14 g: 4.2% → 3.9%
- 14–16 g: 3.9% → 3.6%
- 16–18 g: 3.6% → 3.3%
- 18–20 g: 3.3% → 3.0%
- 20–22 g: 3.0% → 2.7%
- 22–24 g: 2.7% → 2.5%
- 24–26 g: 2.5% → 2.4%
- 26–28 g: 2.4% → 2.3%
- 28–30 g: 2.3% → 2.2%
- 30–32 g: 2.2% → 2.2%
Food kg/day ≈ live_biomass_kg × feed_rate_percent / 100; per meal ≈ daily_food / feedings_per_day.

Water quality:
- Temperature 28–32 °C
- Salinity 10–25 ppt (avoid sudden changes)
- pH 7.5–8.5
- DO ≥ 5.5 mg/l (critical if night DO < 4 mg/l)
- Ammonia: keep as low as practical (TAN vs NH3 not interchangeable)
- Alkalinity ≥ 120 mg/l as CaCO3
- Transparency / plankton often ~30–40 cm
- Ca/Mg/K: aim toward seawater mineral balance

Notes: survival is not constant; tray response and pond health override the table.
`.trim();
}

export function buildSpeciesCultureReferenceContext(input: {
  question: string;
  pondSpecies?: string | null;
  noRecordsJoin?: boolean;
  /** When true, farm growth/feed values are missing — reference charts help. */
  thinFarmData?: boolean;
}): string | null {
  const kindFromQuestion = detectSpeciesCultureKind(input.question);
  const kindFromPond = detectSpeciesCultureKind("", input.pondSpecies);
  const cultureQ = isSpeciesCultureQuestion(input.question);
  const noRecords = Boolean(input.noRecordsJoin);
  const thin = Boolean(input.thinFarmData);

  // Only inject when the farmer is asking culture/feed guidance, named a species,
  // has a no-records join, or the pond lacks measured growth/feed data.
  if (!cultureQ && !noRecords && !kindFromQuestion && !(thin && kindFromPond)) {
    return null;
  }

  const header = [
    "SPECIES CULTURE REFERENCE DATA (AquaPrana built-in charts)",
    "Rules: Prefer actual pond/cycle measurements when available. If values are unavailable / no historical records, use this reference and clearly say it is reference guidance, not measured farm data. Do not invent pond-specific numbers.",
  ].join("\n");

  // Explicit species in the question wins.
  if (kindFromQuestion === "vannamei") {
    return `${header}\n\n${vannameiReferenceBlock()}`;
  }
  if (kindFromQuestion === "tiger") {
    return `${header}\n\n${tigerReferenceBlock()}`;
  }

  // No-records joins in-app are Vannamei-oriented today.
  if (noRecords) {
    return `${header}\n\n${vannameiReferenceBlock()}`;
  }

  // Thin farm data or culture question — use pond species when known.
  if (kindFromPond === "vannamei") {
    return `${header}\n\n${vannameiReferenceBlock()}`;
  }
  if (kindFromPond === "tiger") {
    return `${header}\n\n${tigerReferenceBlock()}`;
  }

  // Generic assistant asking about culture without naming a species.
  if (cultureQ) {
    return `${header}\n\n${vannameiReferenceBlock()}\n\n${tigerReferenceBlock()}`;
  }

  return null;
}
