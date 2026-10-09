/**
 * Culture-domain detection (shrimp vs freshwater fish vs mixed) and the
 * fish-farming reference context for Ask Prana prompts.
 *
 * Structured so more species/systems can be added by extending the config
 * arrays below — no species logic lives in the prompt text itself.
 * Reference notes are general guidance, not measured farm data.
 */

export type CultureType = "shrimp" | "fish" | "mixed" | "general";
export type DomainSource = "question" | "conversation" | "pond" | "none";

export type FishSpecies = {
  id: string;
  name: string;
  scientific: string;
  /** Farmer-facing names to use in Telugu/Hindi answers. */
  localNames: { te: string; hi: string };
  /** Latin-script aliases (matched on word boundaries, case-insensitive). */
  aliases: RegExp;
  /** Telugu / Devanagari aliases (substring match; \b does not work for Indic). */
  indicAliases: string[];
  notes: string;
};

export const FISH_SPECIES: readonly FishSpecies[] = [
  {
    id: "rohu",
    name: "Rohu",
    scientific: "Labeo rohita",
    localNames: { te: "రోహు / శీలావతి", hi: "रोहू" },
    aliases: /\b(rohu|rohita|labeo)\b/i,
    indicAliases: ["రోహు", "శీలావతి", "रोहू", "रोहु"],
    notes:
      "Indian major carp; column feeder (plankton, soft plant matter, decaying organic matter). Core species of composite/polyculture with Catla and Mrigal; also grown in semi-intensive ponds on supplementary feed (oil cake + rice bran, or pellets). Commonly harvested after about 8–12 months, with partial harvest of larger fish common. Frequent problems: Argulus (fish lice) and other external parasites, ulcers/EUS, bacterial (Aeromonas) infections, gill problems, and low-DO stress.",
  },
  {
    id: "catla",
    name: "Catla",
    scientific: "Catla catla (Labeo catla)",
    localNames: { te: "బొచ్చె / కట్ల", hi: "कतला" },
    aliases: /\bcatla\b/i,
    indicAliases: ["కట్ల", "బొచ్చె", "कतला", "कतल"],
    notes:
      "Indian major carp; surface/column feeder mainly on zooplankton — depends heavily on pond productivity (fertilization/plankton). Fastest-growing of the Indian major carps; sensitive to low dissolved oxygen, so watch early-morning DO. Stocked as the surface feeder in composite culture. Diseases/problems similar to other carps: external parasites (Argulus, Dactylogyrus), ulcers, bacterial infections, oxygen depletion.",
  },
  {
    id: "mrigal",
    name: "Mrigal",
    scientific: "Cirrhinus mrigala",
    localNames: { te: "మ్రిగాల్ / ఎర్రమోసు", hi: "मृगल (नैनी)" },
    aliases: /\b(mrigal|mrigala|cirrhinus)\b/i,
    indicAliases: ["మ్రిగాల్", "మృగాల్", "ఎర్రమోసు", "मृगल", "मृगाल", "नैनी"],
    notes:
      "Indian major carp; bottom feeder on detritus, benthic organisms and decaying matter. Hardy and tolerant, uses the pond bottom niche in composite culture (competes with Common Carp for the bottom). Harvest and disease profile similar to Rohu.",
  },
  {
    id: "tilapia",
    name: "Tilapia",
    scientific: "Oreochromis niloticus",
    localNames: { te: "తిలాపియా", hi: "तिलापिया" },
    aliases: /\b(tilapia|oreochromis|gift\s*tilapia)\b/i,
    indicAliases: ["తిలాపియా", "తిలపియా", "तिलापिया"],
    notes:
      "Omnivore; grows well on pellet feed and natural food. Breeds early and prolifically, so all-male (monosex) seed is usually used for grow-out to avoid overcrowding and stunting; only use strains and seed permitted by local fisheries rules. Suited to ponds, cages, tanks, biofloc and RAS; stocking density depends strongly on the system and aeration. Common problems: Streptococcus and other bacterial infections (often linked to high temperature/stress), columnaris, TiLV, external parasites.",
  },
  {
    id: "common-carp",
    name: "Common Carp",
    scientific: "Cyprinus carpio",
    localNames: { te: "కామన్ కార్ప్", hi: "कॉमन कार्प (सामान्य कार्प)" },
    aliases: /\b(common\s*carp|cyprinus|carpio)\b/i,
    indicAliases: ["కామన్ కార్ప్", "कॉमन कार्प", "सामान्य कार्प"],
    notes:
      "Omnivorous bottom feeder; digs in pond bottom (raises turbidity, can damage dykes). Hardy, tolerates a wide temperature range; can breed in ponds, which may cause overcrowding. Used as a bottom feeder in six-species composite culture. Problems include Argulus and other parasites, bacterial infections, and viral diseases such as KHV/SVC where present.",
  },
  {
    id: "pangasius",
    name: "Pangasius (Basa)",
    scientific: "Pangasianodon hypophthalmus",
    localNames: { te: "పంగాసియస్ (బాసా)", hi: "पंगेसियस (पंगास / बासा)" },
    aliases: /\b(pangasius|pangas|pangasianodon|basa|striped\s*catfish)\b/i,
    indicAliases: ["పంగాసియస్", "పంగాస్", "बासा", "पंगास", "पंगेसियस"],
    notes:
      "Catfish with air-breathing ability — tolerates low DO better than carps, but intensive feeding makes ammonia, nitrite and sludge the main water-quality risks. Usually grown intensively on floating pellet feed, so feed cost and FCR drive profit; stocking density varies widely by pond depth, aeration and water exchange. Commonly harvested at around 1–1.5 kg. Problems include Edwardsiella (bacillary necrosis), Aeromonas, and parasites; mass mortality often follows poor water quality.",
  },
];

/** Other cultured fish recognised as the fish domain (no dedicated notes). */
const OTHER_FISH =
  /\b(fish(es)?|finfish|fingerlings?|fry|carps?|grass\s*carp|silver\s*carp|bighead|murrel|snakehead|catfish|magur|singhi|koi|pabda|anabas|climbing\s*perch|trout|seabass|milkfish|pompano|cobia|ornamental\s*fish|ras|recirculating(\s+aquaculture)?|aquaponics?|cage\s*culture|raceways?|composite\s*(fish\s*)?culture|fish\s*seed|hatchery)\b/i;
// Stems cover plural/oblique forms (చేప/చేపలు, मछली/मछलियाँ/मछलियों).
const OTHER_FISH_INDIC = ["చేప", "కార్ప్", "मछली", "मछलि", "कार्प", "मत्स्य"];

// "DOC" (days of culture) is shrimp-specific — but not "with doc" / "in doc" /
// "doc file", which ask for a Word document.
const SHRIMP = /\b(shrimps?|prawns?|vannamei|litopenaeus|whiteleg|monodon|black\s*tiger|tiger\s*shrimp|penaeus|scampi|macrobrachium)\b|(?<!\b(in|as|into|to|with|by|via|using|through|on|a|an)\s+(the\s+)?)\bdoc\b(?!\s*(file|format|document))|\bdoc\s*[-:]?\s*\d/i;
const SHRIMP_INDIC = ["రొయ్య", "రొయ్యలు", "వెనామీ", "వన్నామీ", "झींगा", "झींगे", "वनामी"];

/** Intents where shrimp and fish may legitimately be combined. */
const MIXED_INTENT =
  /\b(polyculture|integrated|mixed[\s-]*(species|culture)|shrimp[\s-]*(and|&|\+|-)?[\s-]*fish|fish[\s-]*(and|&|\+|-)?[\s-]*shrimp|compare|comparison|difference|versus|vs\.?)\b/i;

type Signals = { shrimp: boolean; fish: boolean; species: string[]; mixedIntent: boolean };

function analyze(text: string | null | undefined): Signals {
  const value = String(text ?? "");
  const species = FISH_SPECIES.filter(
    (sp) => sp.aliases.test(value) || sp.indicAliases.some((alias) => value.includes(alias)),
  ).map((sp) => sp.id);
  const fish =
    species.length > 0 ||
    OTHER_FISH.test(value) ||
    OTHER_FISH_INDIC.some((alias) => value.includes(alias));
  const shrimp = SHRIMP.test(value) || SHRIMP_INDIC.some((alias) => value.includes(alias));
  return { shrimp, fish, species, mixedIntent: MIXED_INTENT.test(value) };
}

export type AquacultureDomain = {
  cultureType: CultureType;
  fishSpecies: string[];
  source: DomainSource;
  /** The farmer asked what Ask Prana can do / specializes in. */
  capability?: boolean;
};

function fromSignals(signals: Signals, source: DomainSource): AquacultureDomain | null {
  if (signals.shrimp && signals.fish) {
    // Both named: combine only for mixed intents; otherwise both are relevant.
    return { cultureType: "mixed", fishSpecies: signals.species, source };
  }
  if (signals.fish) return { cultureType: "fish", fishSpecies: signals.species, source };
  if (signals.shrimp) return { cultureType: "shrimp", fishSpecies: [], source };
  return null;
}

/**
 * Priority: the current question → the farmer's recent messages (newest
 * first, so the latest topic wins) → the pond/cycle's recorded species.
 */
/** "What can you do / what are you specialized in / main responsibility…" */
const CAPABILITY_QUESTION =
  /\b(what\s+(can|could)\s+you\s+(do|help)|what\s+are\s+you\s+(good\s+at|capable\s+of|special(ist|ized|ised)?)|special(ist|ized|ised|ize|ise|ity)|expertise|your\s+(main\s+)?(responsibilit(y|ies)|role|purpose|capabilit(y|ies))|who\s+are\s+you|what\s+(type|kind)s?\s+of\s+(farming|aquaculture)|(do\s+)?you\s+support|are\s+you\s+only|can\s+you\s+help(\s+me)?\s+with|types?\s+of\s+aquaculture)\b|ఏమి\s*చేయగల|నువ్వు\s*ఏమి|మీరు\s*ఏమి\s*చేయ|నైపుణ్య|ప్రత్యేకత|బాధ్యత|आप\s*क्या\s*कर\s*सकते|तुम\s*क्या\s*कर\s*सकते|विशेषज्ञ|विशेषता|जिम्मेदारी|ज़िम्मेदारी/i;

export function isCapabilityQuestion(question: string) {
  return CAPABILITY_QUESTION.test(question);
}

export function detectAquacultureDomain(input: {
  question: string;
  recentUserTurns?: string[];
  pondSpecies?: string | null;
}): AquacultureDomain {
  const fromQuestion = fromSignals(analyze(input.question), "question");
  if (fromQuestion) return { ...fromQuestion, capability: isCapabilityQuestion(input.question) };
  // Capability/introduction questions cover all of aquaculture — never inherit
  // a shrimp or fish topic from earlier messages or the pond.
  if (isCapabilityQuestion(input.question)) {
    return { cultureType: "general", fishSpecies: [], source: "none", capability: true };
  }

  const turns = input.recentUserTurns ?? [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const fromTurn = fromSignals(analyze(turns[index]), "conversation");
    if (fromTurn) return fromTurn;
  }

  const fromPond = fromSignals(analyze(input.pondSpecies), "pond");
  if (fromPond) return fromPond;

  return { cultureType: "general", fishSpecies: [], source: "none" };
}

export function isMixedCultureIntent(question: string) {
  return MIXED_INTENT.test(question);
}

export const FISH_CULTURE_SYSTEMS = [
  "composite fish culture / polyculture (Indian major carps ± exotic carps)",
  "monoculture",
  "extensive, semi-intensive and intensive pond culture",
  "biofloc",
  "recirculating aquaculture systems (RAS)",
  "cage culture",
  "tank and raceway culture",
  "integrated fish farming (with livestock, poultry, paddy)",
  "aquaponics",
  "nursery / fry-to-fingerling rearing and grow-out",
  "hatchery, induced breeding and seed production",
] as const;

const FISH_WATER_QUALITY = `
Freshwater fish water-quality reference (general warm-water pond guidance; say that suitable ranges vary by species, life stage, culture system and local conditions):
- Dissolved oxygen: aim for about 5 mg/L or more; below about 3 mg/L causes stress and surface gasping, lowest before sunrise. Pangasius (air-breathing) tolerates low DO better than carps; Catla is sensitive.
- pH: roughly 6.5–8.5; wide day–night swings suggest a heavy plankton bloom.
- Temperature: warm-water carps and tilapia grow best around 25–32 °C; feeding drops outside that range.
- Ammonia: the toxic un-ionised form rises with pH and temperature, so interpret total ammonia together with pH/temperature. Main causes: overfeeding, dead algae, sludge.
- Nitrite: freshwater fish are sensitive (brown blood); keep it low.
- Alkalinity and hardness: commonly about 50–200 mg/L as CaCO3; low alkalinity causes unstable pH.
- Transparency (Secchi): about 30–45 cm in fertilised carp ponds indicates good plankton; clearer = poor natural food, much lower = excess bloom/turbidity.
- Salinity: freshwater species; relevant only for inland saline/brackish sites (tilapia tolerates more than carps).
- Tools: aeration, water exchange, reduced feeding, liming, and pond fertilisation where appropriate.
Do NOT apply shrimp limits, salinity targets, minerals (Ca/Mg/K ratios) or shrimp check-tray rules to freshwater fish.`;

const FISH_FEEDING = `
Fish feeding guidance:
- Carps use natural food (plankton/detritus) plus supplementary feed; Tilapia and Pangasius are usually fed formulated pellets.
- Feed as a % of biomass per day, decreasing as fish grow: small fingerlings much higher (often 5–10%), grow-out fish typically about 1–3% for carps/tilapia; use the feed maker's chart when available.
- Split into 2 or more meals; feed at fixed times and places (feed bags/trays for carps, floating pellets let the farmer watch consumption).
- Reduce or stop feeding when DO is low, water is very cold/hot, fish are sick, or feed is left uneaten.
- FCR = total feed given ÷ total weight gained (or harvest biomass − stocked biomass).`;

const FISH_HEALTH = `
Fish health reasoning:
- Consider signs such as surface gasping, abnormal swimming, loss of appetite, skin lesions/ulcers, fin damage, white/cotton growth, parasites (e.g. Argulus), and sudden mortality.
- Check water quality first (DO, ammonia, nitrite, pH, temperature) — most fish mortality starts with water-quality stress.
- Never confirm a disease from symptoms alone; list possible causes and recommend a fisheries officer, aquatic-animal-health lab or veterinarian for confirmation (scrapings, bacteriology, PCR where relevant).
- Do not recommend antibiotics or chemicals blindly or invent doses; follow local regulations and professional advice.
- Shrimp disease names (WSSV, EHP, AHPND, IMNV, white feces, shell disease) do NOT apply to fish.`;

const FISH_CALCULATIONS = `
Fish farming calculations (show the formula and the numbers, state assumptions and units):
- Biomass (kg) = number of fish × average body weight (kg). Example: 10,000 × 0.1 kg = 1,000 kg.
- Survival % = current count ÷ stocked count × 100; mortality % = 100 − survival %.
- Daily feed (kg) = biomass (kg) × feeding rate (% per day) ÷ 100.
- FCR = feed used ÷ weight gain. Growth: ADG = (final − initial weight) ÷ days; SGR % = (ln final − ln initial) ÷ days × 100.
- Stocking density = number stocked ÷ water area (per m², per acre or per hectare as the farmer uses).
- Production/harvest biomass, revenue = harvest kg × price per kg, feed cost = feed kg × price per kg, profit = revenue − total costs. Never invent prices; ask for them.`;

/** Fish-specific prompt block; null for shrimp/general so shrimp behaviour is unchanged. */
export function buildAquacultureDomainContext(domain: AquacultureDomain): string | null {
  if (domain.cultureType !== "fish" && domain.cultureType !== "mixed") return null;
  const species = FISH_SPECIES.filter((sp) => domain.fishSpecies.includes(sp.id));
  const speciesLines = (species.length ? species : FISH_SPECIES).map(
    (sp) =>
      `- ${sp.name} (${sp.scientific}) — Telugu: ${sp.localNames.te}; Hindi: ${sp.localNames.hi}. ${sp.notes}`,
  );

  const header =
    domain.cultureType === "fish"
      ? `CULTURE CONTEXT: FRESHWATER FISH FARMING (detected from the ${domain.source === "question" ? "current question" : domain.source === "conversation" ? "recent conversation" : "pond's recorded species"}).
Answer as a freshwater fish-farming advisor${species.length ? ` for ${species.map((sp) => sp.name).join(", ")}` : ""}. Do NOT give shrimp recommendations, shrimp feed charts, DOC, check-tray rules, shrimp water-quality limits, or shrimp disease names. Where later instructions say "shrimp" (e.g. shrimp-health image, Shrimp Estimation), apply the equivalent for fish.`
      : `CULTURE CONTEXT: SHRIMP AND FISH BOTH MENTIONED.
Keep shrimp and fish advice separate and clearly labelled. Combine them into one plan only for polyculture, integrated/mixed-species culture or comparison questions. Never apply one group's water-quality limits, feed charts or disease list to the other.`;

  const capabilityNote = domain.capability
    ? "This is a capability question: confirm this support clearly, and also mention that Ask Prana supports both shrimp farming and fish farming."
    : null;

  return [
    header,
    ...(capabilityNote ? [capabilityNote] : []),
    `Species reference (general guidance, not measured farm data; do not invent species-specific numbers beyond this — say when a value depends on system/local conditions):\n${speciesLines.join("\n")}`,
    `Culture systems you can advise on: ${FISH_CULTURE_SYSTEMS.join("; ")}.`,
    FISH_WATER_QUALITY.trim(),
    FISH_FEEDING.trim(),
    FISH_HEALTH.trim(),
    FISH_CALCULATIONS.trim(),
    `Answer shape for problems: what is likely happening → possible causes → what to check → what to do now → precautions → when to get lab/professional confirmation. Keep simple questions short.
Species names: use the commonly recognised name with the scientific name when useful (e.g. Rohu (Labeo rohita), రోహు (Labeo rohita), रोहू (Labeo rohita)); do not literally translate species names.
If the farmer gives fish count, average weight, biomass, feed %, temperature or species, use those values in the calculation.`,
  ].join("\n\n");
}

/** Shrimp-only prompt context (reference charts) must stay out of fish answers. */
export function allowsShrimpReference(domain: AquacultureDomain, isGenericMode: boolean) {
  if (domain.cultureType === "fish") return false;
  // Generic mode with no species anywhere: don't assume shrimp.
  if (isGenericMode && domain.cultureType === "general") return false;
  return true;
}
