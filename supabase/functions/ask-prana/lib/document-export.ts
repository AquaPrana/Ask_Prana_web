/**
 * Ask Prana generated DOCX/PDF/XLSX builders + request detection.
 * Used only when the farmer explicitly asks for a downloadable document.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import JSZip from "jszip";

export type DocumentFormat = "docx" | "pdf" | "xlsx";

export type GeneratedDocumentMeta = {
  fileName: string;
  mimeType: string;
  path: string;
  url: string;
  byteSize: number;
  format: DocumentFormat;
};

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_MIME = "application/pdf";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Telugu / Hindi words for a Word file or document (typed or STT forms). */
const INDIC_WORD_DOCUMENT = /వర్డ్|డాక్యుమెంట్|డాక్యుమెంటు|డాక్ ఫైల్|वर्ड|डॉक्यूमेंट|डॉक्युमेंट|डाक्यूमेंट|दस्तावेज़|दस्तावेज/;

/**
 * "doc" as a file format ("give me in doc", "as a doc", "doc file") — not the
 * shrimp culture-day abbreviation ("DOC 30", "at DOC", "what is the DOC").
 */
export const DOC_FORMAT_REQUEST =
  /\b(in|as|into|to|with|by|via|using|through|on)\s+(a\s+|an\s+|the\s+)?(\.?docx?|word|document)\b(?!\s*[-:]?\s*\d)|\b\.?doc\s+(file|format)\b|\b(give|send|share|make|create|generate|prepare|provide)\b[\s\S]{0,30}\b(a|an)\s+\.?docx?\b(?!\s*\d)/;

export function isDocumentExportQuestion(question: string): boolean {
  const q = question.toLowerCase();
  if (!q.trim()) return false;

  if (DOC_FORMAT_REQUEST.test(q)) return true;
  if (INDIC_WORD_DOCUMENT.test(question)) return true;

  // Telugu / Hindi script mentions of Excel / downloadable sheet (common STT+typed forms)
  if (/ఎక్సెల్|ఎక్సెల్‌|एक्सेल|एक्सल/.test(question)) return true;
  if (
    (/డౌన్?\s*లోడ్|డౌన్లోడ్|डाउनलोड|download/.test(question) ||
      /పంపించ|ఇవ్వగల|ఇవ్వండి|ఇవ్వగలరా|भेज|दो\b/.test(question)) &&
    (/షీట్|షీట్ల|ఫైల్|फ़ाइल|शीट|excel|xlsx|sheet|file|spreadsheet|ఎస్టిమేషన్|estimation/.test(
      question,
    ))
  ) {
    return true;
  }

  // Excel / spreadsheet (must come before generic file checks)
  // Include common misspellings: exel, excle, xlxs
  if (/\b(excel|exel|excle|xlsx|xlxs|xls|spreadsheet)\b/.test(q)) return true;
  if (/\bin\s+excel(\s+format)?\b/.test(q)) return true;
  if (/\bin\s+exel(\s+format)?\b/.test(q)) return true;
  if (/\bas\s+(an?\s+)?(excel|exel|xlsx|spreadsheet)\b/.test(q)) return true;
  if (
    /\b(export|download|give|generate|make|create|provide)\b[\s\S]{0,60}\b(excel|exel|excle|xlsx|xlxs|xls|spreadsheet)\b/
      .test(q)
  ) {
    return true;
  }
  if (
    /\b(excel|exel|xlsx|spreadsheet)\b[\s\S]{0,40}\b(format|file|download|export)\b/
      .test(q)
  ) {
    return true;
  }

  if (/\b(pdf|docx)\b/.test(q) || /పీడీఎఫ్|पीडीएफ/.test(question)) return true;
  if (/\bonly\s+in\s+(pdf|doc|docx|word|excel|xlsx)\b/.test(q)) return true;

  // Generic "document" / Word requests (common farmer phrasing)
  // e.g. "give all this in a document", "as a document", "in document form"
  if (
    /\b(in|as|into|to)\s+(a\s+|an\s+|the\s+)?(word\s+)?document\b/.test(q)
  ) {
    return true;
  }
  if (/\bdocument\s+(form|format|file|download)\b/.test(q)) return true;
  if (/\b(word\s+document|ms\s*word|microsoft\s+word)\b/.test(q)) return true;
  if (
    /\b(give|provide|send|share|export|download|generate|create|make|prepare)\b[\s\S]{0,80}\b(document|docx|word)\b/
      .test(q)
  ) {
    return true;
  }

  if (/\bas\s+a\s+(file|document|pdf|docx|word|excel|xlsx|spreadsheet)\b/.test(q)) {
    return true;
  }
  if (
    /\bin\s+(docx|pdf|xlsx|excel|word\s+format|document\s+format|excel\s+format)\b/
      .test(q)
  ) {
    return true;
  }
  if (
    /\b(ms\s*)?word\b/.test(q) &&
    /\b(file|document|format|download|create|make|give|export|attach|report|checklist)\b/
      .test(q)
  ) {
    return true;
  }
  if (
    /\b(downloadable|download)\b/.test(q) &&
    /\b(file|document|doc|pdf|docx|word|excel|xlsx|spreadsheet|report|checklist)\b/
      .test(q)
  ) {
    return true;
  }
  if (
    /\b(export|generate|create|make)\b/.test(q) &&
    /\b(pdf|docx|excel|xlsx|spreadsheet|document|report|checklist|file)\b/.test(q)
  ) {
    return true;
  }
  if (
    /\b(don'?t|do\s+not|dont)\b[\s\S]{0,40}\b(text|chat)\b/.test(q) &&
    /\b(file|document|docx|pdf|word|excel|xlsx|download)\b/.test(q)
  ) {
    return true;
  }
  if (
    /\bgive\s+(me\s+)?(this|it|all\s+this|the\s+above|everything|the\s+values?|the\s+data|the\s+checklist|the\s+report)\b/
      .test(q) &&
    /\b(file|document|docx|pdf|word|excel|xlsx|downloadable)\b/.test(q)
  ) {
    return true;
  }
  return false;
}

export function resolveRequestedDocumentFormat(question: string): DocumentFormat {
  const q = question.toLowerCase();
  const teluguExcel = /ఎక్సెల్|एक्सेल|एक्सल/.test(question);
  const excelIdx = Math.max(
    teluguExcel ? 0 : -1,
    q.search(/\bexcel\b/),
    q.search(/\bexel\b/),
    q.search(/\bexcle\b/),
    q.search(/\bxlsx\b/),
    q.search(/\bxlxs\b/),
    q.search(/\bxls\b/),
    q.search(/\bspreadsheet\b/),
    /షీట్|शीट/.test(question) && teluguExcel ? 0 : -1,
  );
  const pdfIdx = Math.max(
    q.search(/\bpdf\b/),
    /పీడీఎఫ్|पीडीएफ/.test(question) ? 0 : -1,
  );
  const docxIdx = Math.max(
    q.search(/\bdocx\b/),
    q.search(/\b(ms\s*)?word\b/),
    q.search(/\bdoc\b(?!\w)/),
    // Generic "document" without Excel/PDF → Word (.docx)
    q.search(/\bdocument\b/),
    question.search(INDIC_WORD_DOCUMENT),
  );

  const candidates: Array<{ format: DocumentFormat; idx: number }> = [];
  if (excelIdx >= 0) candidates.push({ format: "xlsx", idx: excelIdx });
  if (pdfIdx >= 0) candidates.push({ format: "pdf", idx: pdfIdx });
  if (docxIdx >= 0) candidates.push({ format: "docx", idx: docxIdx });

  if (candidates.length === 0) {
    // Telugu "sheet/download estimation" without Latin excel → still Excel for estimation values.
    if (/షీట్|ఎస్టిమేషన్|estimation|values?|వ్యాల్యూ/.test(question)) {
      return "xlsx";
    }
    // Default downloadable file for farmers = Word document
    return "docx";
  }

  candidates.sort((a, b) => a.idx - b.idx);
  return candidates[0]!.format;
}

export function mimeForFormat(format: DocumentFormat): string {
  if (format === "pdf") return PDF_MIME;
  if (format === "xlsx") return XLSX_MIME;
  return DOCX_MIME;
}

function sanitizeFileToken(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48) || "Pond";
}

export function buildExportFileName(
  question: string,
  format: DocumentFormat,
  pondName?: string | null,
): string {
  const pond = sanitizeFileToken(pondName?.trim() || "Generic");
  const q = question.toLowerCase();
  let topic = "Ask_Prana_Document";
  if (/pre[-\s]?harvest/.test(q) && /checklist/.test(q)) {
    topic = "Pre_Harvest_Checklist";
  } else if (/pre[-\s]?harvest/.test(q)) {
    topic = "Pre_Harvest";
  } else if (/harvest/.test(q) && /report/.test(q)) {
    topic = "Harvest_Report";
  } else if (
    /estimat/.test(q) &&
    (/vannamei|vannami|litopenaeus/.test(q) || /shrimp/.test(q))
  ) {
    topic = /vannamei|vannami|litopenaeus/.test(q)
      ? "Vannamei_Estimation"
      : "Shrimp_Estimation";
  } else if (/estimat/.test(q)) {
    topic = "Estimation";
  } else if (/checklist/.test(q)) {
    topic = "Checklist";
  } else if (/prepar/.test(q) && /pond/.test(q)) {
    topic = "Pond_Preparation";
  } else if (/culture|stocking|checkpoint/.test(q)) {
    topic = "Culture_Plan";
  } else if (/report/.test(q)) {
    topic = "Report";
  } else if (/summary|discussed|conversation|above/.test(q)) {
    topic = "Conversation_Summary";
  }

  if (format === "xlsx") {
    return `Pond_${pond}_${topic}.xlsx`;
  }
  return `Pond_${pond}_${topic}.${format}`;
}

/** Strip chat fluff the model may still emit; keep real document body. */
export function cleanDocumentBody(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const filtered = lines.filter((line) => {
    const t = line.trim().toLowerCase();
    if (!t) return true;
    if (t.startsWith("suggested filename")) return false;
    if (/^file\s*name\s*:/.test(t)) return false;
    if (
      /^here is (the|your) (document|docx|pdf|word|excel|xlsx|spreadsheet)/.test(t)
    ) {
      return false;
    }
    if (/^(i('ve| have) (created|prepared|generated))/.test(t) && t.length < 80) {
      return false;
    }
    return true;
  });
  return filtered.join("\n").trim();
}

function sanitizePdfText(text: string): string {
  return text
    .replace(/\u20B9/g, "Rs. ")
    .replace(/\u00A0/g, " ")
    .replace(/[^\u0009\u000A\u000D\u0020-\u007E\u00A0-\u00FF\u2022]/g, "?");
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrapLine(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function isLikelyHeading(line: string, index: number): boolean {
  const t = line.trim();
  if (!t) return false;
  if (index === 0) return true;
  if (t === t.toUpperCase() && t.length > 3 && t.length < 90) return true;
  if (/^\d+[\.\)]\s+\S/.test(t) && t.length < 80) return true;
  return false;
}

export async function buildPdfBytes(documentBody: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 48;
  const lineHeight = 14;

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const ensureSpace = (needed: number) => {
    if (y - needed >= margin) return;
    page = doc.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  };

  const sourceLines = documentBody.split("\n");
  sourceLines.forEach((rawLine, index) => {
    const line = rawLine.replace(/\t/g, "  ");
    if (!line.trim()) {
      y -= lineHeight * 0.6;
      return;
    }
    const trimmed = line.trim();
    const markdownHeading = trimmed.match(/^#{1,3}\s+(.+)$/);
    const markdownList = trimmed.match(/^[-*+]\s+(.+)$/);
    const symbolList = trimmed.match(/^(?:\u2610|\u2611|\u2612|\u25a1|\u25a0|\u25aa|\u2705|\u2714)\s+(.+)$/u);
    const bareTask = /^\[[ xX]\]\s+.+$/.test(trimmed);
    const isUnorderedList = Boolean(markdownList || symbolList || bareTask);
    const normalized = isUnorderedList
      ? normalizeUnorderedListText(markdownList ? markdownList[1] : trimmed)
      : { text: trimmed, completed: false };
    const displayLine = markdownHeading
      ? inlinePlainText(markdownHeading[1])
      : isUnorderedList
      ? `\u2022 ${normalized.completed ? `Completed: ${inlinePlainText(normalized.text)}` : inlinePlainText(normalized.text)}`
      : inlinePlainText(trimmed);
    const heading = Boolean(markdownHeading) || isLikelyHeading(displayLine, index);
    const size = heading ? (index === 0 ? 16 : 12) : 10;
    const useFont = heading ? fontBold : font;
    const wrapped = wrapLine(sanitizePdfText(displayLine), heading ? 70 : 92);
    for (const part of wrapped) {
      ensureSpace(size + 4);
      page.drawText(part, {
        x: margin,
        y,
        size,
        font: useFont,
        color: rgb(0.08, 0.12, 0.18),
      });
      y -= size + 4;
    }
    if (heading) y -= 4;
  });

  return await doc.save();
}

/** Context shown in the compact first-page report header. */
export type WordDocumentContext = {
  pondName?: string | null;
  species?: string | null;
  stockingDate?: string | null;
  readingsDate?: string | null;
};

type InlineRun = { text: string; bold?: boolean; italic?: boolean; url?: string };

function parseInlineMarkdown(source: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const token = /(\*\*|__)(.+?)\1|(\*|_)(.+?)\3|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let at = 0;
  for (let match; (match = token.exec(source));) {
    if (match.index > at) runs.push({ text: source.slice(at, match.index) });
    if (match[2] != null) runs.push({ text: match[2], bold: true });
    else if (match[4] != null) runs.push({ text: match[4], italic: true });
    else runs.push({ text: match[5]!, url: match[6] });
    at = token.lastIndex;
  }
  if (at < source.length) runs.push({ text: source.slice(at) });
  return runs.length ? runs : [{ text: source }];
}

function inlinePlainText(source: string): string {
  return parseInlineMarkdown(source).map((run) => run.text).join("")
    .replace(/`([^`]+)`/g, "$1");
}

function wordRun(run: InlineRun, extra = ""): string {
  const rPr = `<w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:eastAsia="Nirmala UI" w:cs="Nirmala UI"/>${run.bold ? "<w:b/>" : ""}${run.italic ? "<w:i/>" : ""}${run.url ? '<w:color w:val="056B75"/><w:u w:val="single"/>' : ""}${extra}</w:rPr>`;
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(run.text || " ")}</w:t></w:r>`;
}

function isPipeTableLine(line: string): boolean {
  return line.includes("|") && line.replace(/^\s*\|?|\|?\s*$/g, "").split("|").length > 1;
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

/** Remove only a leading task/symbol marker; document content is untouched. */
function normalizeUnorderedListText(text: string): { text: string; completed: boolean } {
  const task = text.match(/^\s*(?:[-*+]\s+)?\[([ xX])\]\s+(.+)$/);
  if (task) {
    return { text: task[2], completed: /x/i.test(task[1]) };
  }
  const unicodeSymbol = text.match(/^\s*(\u2610|\u2611|\u2612|\u25a1|\u25a0|\u25aa|\u2b1c|\u2705|\u2714)\s+(.+)$/u);
  if (unicodeSymbol) {
    return {
      text: unicodeSymbol[2],
      completed: /^(?:\u2611|\u2612|\u2705|\u2714)$/u.test(unicodeSymbol[1]),
    };
  }
  return { text: text.trim(), completed: false };
}

/**
 * The shared visual language for every Ask Prana Word export. Values are OOXML
 * units (twips/half-points) where appropriate, so exports don't inherit a
 * viewer's default Word template.
 */
export const ASK_PRANA_DOCUMENT_THEME = {
  fonts: { heading: "Aptos Display", body: "Aptos", fallback: "Calibri", complex: "Nirmala UI" },
  colors: {
    primary: "075C62", secondary: "0B7A75", accent: "DCEFED", ink: "173638",
    muted: "5D6D6F", border: "B9D9D5", surface: "F4FAF9", warning: "FFF5DD",
    critical: "FCE9E7", recommendation: "EAF5EF",
  },
  page: { width: 11906, height: 16838, margin: 1134, headerFooter: 709, contentWidth: 9638 },
  table: { indent: 120, cellTopBottom: 100, cellStartEnd: 140 },
  list: { marker: 360, text: 720, levelStep: 360 },
} as const;

type ListOptions = { num?: number; level?: number };

function docxTableCell(content: string, width: number, fill?: string, borders = ""): string {
  const theme = ASK_PRANA_DOCUMENT_THEME;
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${fill ? `<w:shd w:fill="${fill}"/>` : ""}<w:tcMar><w:top w:w="${theme.table.cellTopBottom}" w:type="dxa"/><w:bottom w:w="${theme.table.cellTopBottom}" w:type="dxa"/><w:start w:w="${theme.table.cellStartEnd}" w:type="dxa"/><w:end w:w="${theme.table.cellStartEnd}" w:type="dxa"/></w:tcMar>${borders}</w:tcPr>${content}</w:tc>`;
}

function docxTable(rows: string, columns: number[], options: { borders?: string; keepRows?: boolean } = {}): string {
  const theme = ASK_PRANA_DOCUMENT_THEME;
  const borderColor = theme.colors.border;
  const borders = options.borders ?? `<w:top w:val="single" w:sz="4" w:color="${borderColor}"/><w:left w:val="single" w:sz="4" w:color="${borderColor}"/><w:bottom w:val="single" w:sz="4" w:color="${borderColor}"/><w:right w:val="single" w:sz="4" w:color="${borderColor}"/><w:insideH w:val="single" w:sz="2" w:color="${borderColor}"/><w:insideV w:val="single" w:sz="2" w:color="${borderColor}"/>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="${theme.page.contentWidth}" w:type="dxa"/><w:tblInd w:w="${theme.table.indent}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="${theme.table.cellTopBottom}" w:type="dxa"/><w:bottom w:w="${theme.table.cellTopBottom}" w:type="dxa"/><w:start w:w="${theme.table.cellStartEnd}" w:type="dxa"/><w:end w:w="${theme.table.cellStartEnd}" w:type="dxa"/></w:tblCellMar><w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid>${columns.map((width) => `<w:gridCol w:w="${width}"/>`).join("")}</w:tblGrid>${rows}</w:tbl>`;
}

function calloutKind(text: string): { label: string; fill: string } | null {
  const match = text.match(/^\s*(IMPORTANT|WARNING|ACTION REQUIRED|RECOMMENDATION|NOTE|CRITICAL)\s*[:\-–—]\s*(.+)$/i);
  if (!match) return null;
  const label = match[1].toUpperCase();
  const colors = ASK_PRANA_DOCUMENT_THEME.colors;
  return { label, fill: label === "CRITICAL" ? colors.critical : label === "WARNING" || label === "ACTION REQUIRED" ? colors.warning : label === "RECOMMENDATION" ? colors.recommendation : colors.accent };
}

function isExplicitHeading(line: string): boolean {
  return /^#{1,3}\s+/.test(line) || /^\d+(?:\.\d+){1,2}[.)]\s+/.test(line) || (line === line.toUpperCase() && line.length > 3 && line.length < 90 && !/[|]/.test(line));
}

/** Distinguish a section label ("1. Pond Preparation") from procedural steps. */
function isNumberedSectionHeading(lines: string[], index: number): boolean {
  const current = lines[index]?.trim() ?? "";
  const match = current.match(/^(\d+(?:\.\d+)*)[.)]\s+(.+)$/);
  if (!match || current.length >= 110) return false;
  if (match[1].includes(".")) return true;
  if (/[.!?]$/.test(match[2])) return false;
  const nextMeaningful = lines.slice(index + 1).find((line) => line.trim());
  return !nextMeaningful || !/^\s*\d+[.)]\s+/.test(nextMeaningful);
}

/** Build a styled Word document from ordinary Markdown emitted by Ask Prana. */
export async function buildDocxBytes(documentBody: string, context: WordDocumentContext = {}): Promise<Uint8Array> {
  const lines = documentBody.replace(/\r\n/g, "\n").split("\n");
  const firstMeaningful = lines.findIndex((line) => line.trim().length > 0);
  const titleSource = firstMeaningful >= 0 ? lines[firstMeaningful].replace(/^\s*#+\s+/, "").trim() : "Ask Prana Report";
  const title = inlinePlainText(titleSource) || "Ask Prana Report";
  const body: string[] = [];
  const hyperlinkTargets: string[] = [];
  const addRuns = (text: string) => parseInlineMarkdown(text).map((run) => {
    if (!run.url) return wordRun(run);
    let index = hyperlinkTargets.indexOf(run.url);
    if (index < 0) { hyperlinkTargets.push(run.url); index = hyperlinkTargets.length - 1; }
    return `<w:hyperlink r:id="rId${5 + index}">${wordRun(run)}</w:hyperlink>`;
  }).join("");
  const paragraph = (text: string, style = "Normal", options: ListOptions = {}) => {
    const pPr = `<w:pPr><w:pStyle w:val="${style}"/>${options.num != null ? `<w:numPr><w:ilvl w:val="${options.level ?? 0}"/><w:numId w:val="${options.num}"/></w:numPr>` : ""}${style.startsWith("Heading") ? '<w:keepNext/>' : ""}<w:widowControl/></w:pPr>`;
    return `<w:p>${pPr}${addRuns(text)}</w:p>`;
  };
  const metadata = [
    ["POND", context.pondName], ["SPECIES", context.species], ["STOCKING DATE", context.stockingDate], ["POND READINGS", context.readingsDate],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()));
  body.push(paragraph("AquaPrana", "Brand"));
  body.push(paragraph("ASK PRANA", "Kicker"));
  body.push(paragraph(title, "Title"));
  body.push(paragraph(`Generated: ${new Date().toISOString().slice(0, 10)}`, "Subtitle"));
  if (metadata.length) {
    const labelWidth = 2500; const valueWidth = ASK_PRANA_DOCUMENT_THEME.page.contentWidth - labelWidth;
    const metaRows = metadata.map(([label, value]) => `<w:tr>${docxTableCell(paragraph(label, "MetaLabel"), labelWidth, ASK_PRANA_DOCUMENT_THEME.colors.accent)}${docxTableCell(paragraph(value, "MetaValue"), valueWidth)}</w:tr>`).join("");
    body.push(docxTable(metaRows, [labelWidth, valueWidth]));
  }
  const majorSectionCount = lines.slice(firstMeaningful + 1).filter((line) => isExplicitHeading(line.trim())).length;
  if (majorSectionCount >= 4 || lines.length > 90) {
    body.push(paragraph("Contents", "Heading1"));
    body.push(`<w:p><w:pPr><w:pStyle w:val="TOC"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o &quot;1-3&quot; \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Update fields to display the contents.</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`);
  }
  let i = firstMeaningful + 1;
  while (i < lines.length) {
    const raw = lines[i]!; const trimmed = raw.trim();
    if (!trimmed) { i++; continue; }
    if (isPipeTableLine(trimmed)) {
      const rows: string[][] = [];
      while (i < lines.length && isPipeTableLine(lines[i]!.trim())) { if (!isTableDivider(lines[i]!)) rows.push(tableCells(lines[i]!)); i++; }
      if (rows.length) {
        const cols = Math.max(...rows.map((row) => row.length)); const width = Math.floor(ASK_PRANA_DOCUMENT_THEME.page.contentWidth / cols);
        const rowXml = rows.map((row, rowIndex) => `<w:tr><w:trPr>${rowIndex === 0 ? "<w:tblHeader/>" : ""}<w:cantSplit/></w:trPr>${Array.from({ length: cols }, (_, col) => docxTableCell(paragraph(row[col] ?? "", rowIndex === 0 ? "TableHeader" : "TableText"), width, rowIndex === 0 ? ASK_PRANA_DOCUMENT_THEME.colors.secondary : rowIndex % 2 ? ASK_PRANA_DOCUMENT_THEME.colors.surface : undefined)).join("")}</w:tr>`).join("");
        body.push(docxTable(rowXml, Array.from({ length: cols }, () => width)));
      }
      continue;
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    const numberedHeading = trimmed.match(/^(\d+(?:\.\d+)*)[.)]\s+(.+)$/);
    if (heading || isNumberedSectionHeading(lines, i)) {
      // The first Markdown H1 is promoted to the Word Title; remaining H2/H3
      // therefore start at Word Heading 1 rather than leaving a navigation gap.
      const level = heading ? Math.max(1, heading[1].length - 1) : 1;
      const numberedLevels = numberedHeading?.[1].split(".").length ?? 1;
      body.push(paragraph(inlinePlainText(heading ? heading[2] : numberedHeading![2]), `Heading${Math.min(heading ? level : numberedLevels, 3)}`)); i++; continue;
    }
    const checklist = raw.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/);
    if (checklist) {
      const normalized = normalizeUnorderedListText(trimmed);
      body.push(paragraph(normalized.text, "Checklist", {
        num: 1,
        level: Math.min(2, Math.floor(checklist[1].length / 2)),
      }));
      i++;
      continue;
    }
    const list = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.+)$/);
    if (list) {
      const ordered = /^\d/.test(list[2]);
      const normalized = ordered ? { text: list[3], completed: false } : normalizeUnorderedListText(list[3]);
      body.push(paragraph(
        normalized.text,
        "Normal",
        { num: ordered ? 2 : 1, level: Math.min(2, Math.floor(list[1].length / 2)) },
      ));
      i++;
      continue;
    }
    const unicodeSymbolList = raw.match(/^(\s*)(?:\u2610|\u2611|\u2612|\u25a1|\u25a0|\u25aa|\u2b1c|\u2705|\u2714)\s+(.+)$/u);
    if (unicodeSymbolList) {
      const normalized = normalizeUnorderedListText(trimmed);
      body.push(paragraph(normalized.text, "Normal", {
        num: 1,
        level: Math.min(2, Math.floor(unicodeSymbolList[1].length / 2)),
      }));
      i++;
      continue;
    }
    if (/^\s*\[[ xX]\]\s+.+$/.test(raw)) {
      const normalized = normalizeUnorderedListText(trimmed);
      body.push(paragraph(normalized.text, "Normal", { num: 1, level: 0 }));
      i++;
      continue;
    }
    const callout = calloutKind(trimmed);
    if (callout) {
      body.push(docxTable(`<w:tr>${docxTableCell(paragraph(callout.label, "CalloutLabel"), 1850, callout.fill)}${docxTableCell(paragraph(calloutKind(trimmed) ? trimmed.replace(/^\s*(IMPORTANT|WARNING|ACTION REQUIRED|RECOMMENDATION|NOTE|CRITICAL)\s*[:\-–—]\s*/i, "") : trimmed, "CalloutText"), ASK_PRANA_DOCUMENT_THEME.page.contentWidth - 1850, callout.fill)}</w:tr>`, [1850, ASK_PRANA_DOCUMENT_THEME.page.contentWidth - 1850]));
    } else body.push(paragraph(trimmed, "Normal"));
    i++;
  }
  if (!body.length) body.push(paragraph("No document content was generated.", "Normal"));
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Nirmala UI" w:cs="Nirmala UI"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="100" w:line="276" w:lineRule="auto"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="180"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val="075C62"/><w:sz w:val="46"/></w:rPr></w:style>${[1,2,3].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${level - 1}"/><w:spacing w:before="${level === 1 ? 240 : 160}" w:after="80"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val="075C62"/><w:sz w:val="${level === 1 ? 32 : level === 2 ? 27 : 24}"/></w:rPr></w:style>`).join("")}<w:style w:type="paragraph" w:styleId="Checklist"><w:name w:val="Checklist"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="70" w:line="276"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="MetaLabel"><w:name w:val="Meta Label"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="075C62"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="MetaValue"><w:name w:val="Meta Value"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableHeader"><w:name w:val="Table Header"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="103638"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="20"/></w:rPr></w:style></w:styles>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>${[0,1,2].map((level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="${720 + level * 360}"/></w:tabs><w:ind w:left="${720 + level * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join("")}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>${[0,1,2].map((level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${level + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + level * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join("")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
  // Retain the legacy style string temporarily for a safe source-level migration;
  // all new output is written with documentStyles below.
  void styles;
  // Word Online can fall back to a square glyph if a bullet level does not
  // declare its font. Every unordered level therefore uses U+2022 in Arial.
  const roundBulletNumbering = numbering.replace(
    /<w:numFmt w:val="bullet"\/><w:lvlText w:val="[^"]*"\/><w:lvlJc w:val="left"\/>/g,
    '<w:numFmt w:val="bullet"/><w:lvlText w:val="&#x2022;"/><w:lvlJc w:val="left"/><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/></w:rPr>',
  );
  const theme = ASK_PRANA_DOCUMENT_THEME;
  const bodyFont = `<w:rFonts w:ascii="${theme.fonts.body}" w:hAnsi="${theme.fonts.body}" w:eastAsia="${theme.fonts.complex}" w:cs="${theme.fonts.complex}"/>`;
  const documentStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${bodyFont}<w:color w:val="${theme.colors.ink}"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/><w:widowControl/></w:pPr><w:rPr>${bodyFont}</w:rPr></w:style><w:style w:type="paragraph" w:styleId="Brand"><w:name w:val="AquaPrana Brand"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="20"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val="${theme.colors.primary}"/><w:sz w:val="23"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Kicker"><w:name w:val="Ask Prana Kicker"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="100"/><w:keepNext/></w:pPr><w:rPr><w:b/><w:color w:val="${theme.colors.secondary}"/><w:sz w:val="18"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="100"/><w:keepNext/><w:keepLines/></w:pPr><w:rPr><w:rFonts w:ascii="${theme.fonts.heading}" w:hAnsi="${theme.fonts.heading}"/><w:b/><w:color w:val="${theme.colors.primary}"/><w:sz w:val="46"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="220"/><w:keepNext/></w:pPr><w:rPr><w:color w:val="${theme.colors.muted}"/><w:sz w:val="21"/></w:rPr></w:style>${[1,2,3].map((level) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${level - 1}"/><w:spacing w:before="${level === 1 ? 280 : level === 2 ? 200 : 160}" w:after="${level === 1 ? 120 : 80}"/><w:keepNext/><w:keepLines/></w:pPr><w:rPr><w:rFonts w:ascii="${theme.fonts.heading}" w:hAnsi="${theme.fonts.heading}"/><w:b/><w:color w:val="${level === 1 ? theme.colors.primary : theme.colors.secondary}"/><w:sz w:val="${level === 1 ? 32 : level === 2 ? 27 : 24}"/></w:rPr></w:style>`).join("")}<w:style w:type="paragraph" w:styleId="Checklist"><w:name w:val="Checklist"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="100" w:line="276"/></w:pPr></w:style>${[["MetaLabel",true,18],["MetaValue",false,20],["TableHeader",true,19],["TableText",false,19],["CalloutLabel",true,18],["CalloutText",false,20]].map(([id,bold,size]) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/><w:keepLines/></w:pPr><w:rPr>${bold ? "<w:b/>" : ""}<w:color w:val="${id === "TableHeader" ? "FFFFFF" : theme.colors.ink}"/><w:sz w:val="${size}"/></w:rPr></w:style>`).join("")}<w:style w:type="paragraph" w:styleId="TOC"><w:name w:val="TOC"/><w:basedOn w:val="Normal"/></w:style></w:styles>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/><w:headerReference w:type="default" r:id="rId1"/><w:footerReference w:type="default" r:id="rId2"/></w:sectPr></w:body></w:document>`;
  const header = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr>${bodyFont}<w:b/><w:color w:val="${theme.colors.primary}"/><w:sz w:val="18"/></w:rPr><w:t>AquaPrana | Ask Prana</w:t></w:r></w:p></w:hdr>`;
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="${theme.page.contentWidth}"/></w:tabs></w:pPr><w:r><w:rPr>${bodyFont}<w:color w:val="${theme.colors.muted}"/><w:sz w:val="17"/></w:rPr><w:t>AquaPrana • Ask Prana</w:t><w:tab/><w:t>Page </w:t><w:fldChar w:fldCharType="begin"/><w:instrText> PAGE </w:instrText><w:fldChar w:fldCharType="separate"/><w:t>1</w:t><w:fldChar w:fldCharType="end"/><w:t> of </w:t><w:fldChar w:fldCharType="begin"/><w:instrText> NUMPAGES </w:instrText><w:fldChar w:fldCharType="separate"/><w:t>1</w:t><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
  zip.folder("_rels")?.file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const word = zip.folder("word"); word?.file("document.xml", documentXml); word?.file("styles.xml", documentStyles); word?.file("numbering.xml", roundBulletNumbering); word?.file("header1.xml", header); word?.file("footer1.xml", footer);
  word?.folder("_rels")?.file("document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${hyperlinkTargets.map((url, index) => `<Relationship Id="rId${5 + index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escapeXml(url)}" TargetMode="External"/>`).join("")}</Relationships>`);
  return await zip.generateAsync({ type: "uint8array" });
}

type SheetData = {
  name: string;
  rows: string[][];
};

function splitRowCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.includes("|") && (trimmed.match(/\|/g) ?? []).length >= 1) {
    return trimmed
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  if (trimmed.includes("\t")) {
    return trimmed.split("\t").map((cell) => cell.trim());
  }

  if (
    /,(?=(?:[^"]*"[^"]*")*[^"]*$)/.test(trimmed) &&
    (trimmed.match(/,/g) ?? []).length >= 1
  ) {
    return trimmed.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
  }

  return [trimmed];
}

function isMarkdownSeparator(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  return /^[\|\s:\-]+$/.test(t) && /-/.test(t);
}

function sanitizeSheetName(name: string, index: number): string {
  const cleaned = name
    .replace(/[\\/*?:\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
}

/** Parse LLM body into one or more spreadsheet sheets. */
export function parseSpreadsheetSheets(documentBody: string): SheetData[] {
  const body = cleanDocumentBody(documentBody);
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const sheets: SheetData[] = [];
  let currentName = "Shrimp Estimation";
  let currentRows: string[][] = [];

  const flush = () => {
    if (currentRows.length === 0) return;
    sheets.push({
      name: sanitizeSheetName(currentName, sheets.length),
      rows: currentRows,
    });
    currentRows = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const sheetMatch = line.match(/^\s*(?:SHEET|TAB)\s*[:\-]\s*(.+)\s*$/i);
    if (sheetMatch) {
      flush();
      currentName = sheetMatch[1].trim();
      continue;
    }
    if (isMarkdownSeparator(line)) {
      continue;
    }
    const cells = splitRowCells(line);
    if (cells.length === 0) {
      continue;
    }
    currentRows.push(cells);
  }
  flush();

  if (sheets.length === 0) {
    const fallbackRows = lines
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !isMarkdownSeparator(line))
      .map((line) => splitRowCells(line));
    sheets.push({
      name: "Shrimp Estimation",
      rows: fallbackRows.length
        ? fallbackRows
        : [["Status", "No spreadsheet content was generated."]],
    });
  }

  return sheets;
}

function colName(index: number): string {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function buildSheetXml(rows: string[][], sharedIndex: Map<string, number>): string {
  const maxCols = Math.max(1, ...rows.map((row) => row.length));
  const sheetRows = rows
    .map((row, rowIdx) => {
      const cells = [];
      for (let c = 0; c < Math.max(row.length, maxCols); c += 1) {
        const value = row[c] ?? "";
        let idx = sharedIndex.get(value);
        if (idx == null) {
          idx = sharedIndex.size;
          sharedIndex.set(value, idx);
        }
        const ref = `${colName(c)}${rowIdx + 1}`;
        cells.push(`<c r="${ref}" t="s"><v>${idx}</v></c>`);
      }
      return `<row r="${rowIdx + 1}">${cells.join("")}</row>`;
    })
    .join("");

  const lastCol = colName(Math.max(0, maxCols - 1));
  const lastRow = Math.max(1, rows.length);
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${lastCol}${lastRow}"/>` +
    `<sheetData>${sheetRows}</sheetData>` +
    `</worksheet>`
  );
}

export async function buildXlsxBytes(documentBody: string): Promise<Uint8Array> {
  const sheets = parseSpreadsheetSheets(documentBody);
  const sharedIndex = new Map<string, number>();
  const sheetXmls = sheets.map((sheet) => buildSheetXml(sheet.rows, sharedIndex));

  const sharedOrdered = Array.from(sharedIndex.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([value]) => value);

  const sharedStringsXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedOrdered.length}" uniqueCount="${sharedOrdered.length}">` +
    sharedOrdered
      .map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`)
      .join("") +
    `</sst>`;

  const workbookSheets = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${workbookSheets}</sheets>` +
    `</workbook>`;

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets
      .map(
        (_sheet, index) =>
          `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    sheets
      .map(
        (_sheet, index) =>
          `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;

  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf/></cellStyleXfs>` +
    `<cellXfs count="1"><xf/></cellXfs>` +
    `</styleSheet>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.folder("_rels")?.file(".rels", rootRels);
  const xl = zip.folder("xl");
  xl?.file("workbook.xml", workbookXml);
  xl?.file("sharedStrings.xml", sharedStringsXml);
  xl?.file("styles.xml", stylesXml);
  xl?.folder("_rels")?.file("workbook.xml.rels", workbookRels);
  const worksheets = xl?.folder("worksheets");
  sheetXmls.forEach((xml, index) => {
    worksheets?.file(`sheet${index + 1}.xml`, xml);
  });

  return await zip.generateAsync({ type: "uint8array" });
}

export async function buildDocumentBytes(
  documentBody: string,
  format: DocumentFormat,
  wordContext?: WordDocumentContext,
): Promise<Uint8Array> {
  const body = cleanDocumentBody(documentBody);
  if (!body.trim()) {
    throw new Error("Document body was empty after cleaning.");
  }
  if (format === "pdf") {
    return await buildPdfBytes(body);
  }
  if (format === "xlsx") {
    return await buildXlsxBytes(body);
  }
  return await buildDocxBytes(body, wordContext);
}

export function chatCaptionForGeneratedFile(
  format: DocumentFormat,
  language?: string | null,
): string {
  const lang = String(language ?? "").toLowerCase();
  const isTelugu = lang.includes("telugu") || lang === "te";
  const isHindi = lang.includes("hindi") || lang === "hi";

  if (format === "xlsx") {
    if (isTelugu) {
      return "మీ Excel స్ప్రెడ్‌షీట్ (.xlsx) సిద్ధం. డౌన్‌లోడ్ Excel నొక్కి ఫైల్ తెరవండి.";
    }
    if (isHindi) {
      return "आपकी Excel स्प्रेडशीट (.xlsx) तैयार है। Download Excel दबाकर फ़ाइल खोलें।";
    }
    return "Your Excel spreadsheet (.xlsx) is ready. Tap Download Excel to open the file.";
  }
  if (format === "pdf") {
    if (isTelugu) {
      return "మీ PDF సిద్ధం. డౌన్‌లోడ్ నొక్కి ఫైల్ తెరవండి.";
    }
    if (isHindi) {
      return "आपका PDF तैयार है। Download दबाकर फ़ाइल खोलें।";
    }
    return "Your PDF is ready. Tap Download to open the file.";
  }
  if (isTelugu) {
    return "మీ Word డాక్యుమెంట్ (.docx) సిద్ధం. డౌన్‌లోడ్ నొక్కి ఫైల్ తెరవండి.";
  }
  if (isHindi) {
    return "आपका Word दस्तावेज़ (.docx) तैयार है। Download दबाकर फ़ाइल खोलें।";
  }
  return "Your Word document (.docx) is ready. Tap Download to open the file.";
}

/** True when the model failed to produce usable export content. */
export function isUnusableDocumentAnswer(answer: string): boolean {
  const t = answer.trim().toLowerCase();
  if (!t) return true;
  if (t === "no response received.") return true;
  if (t === "no response received") return true;
  if (t.includes("no response received")) return true;
  return false;
}

/** Fallback TSV when the model returns empty — full pond-health pack. */
export function buildFallbackEstimationDocumentBody(): string {
  return [
    "SHEET: Pond Summary",
    "Parameter\tValue\tUnit\tStatus",
    "Pond Name\tNot available\t\tRequired",
    "Species\tNot available\t\tRequired",
    "Stocking Date\tNot available\t\tRequired",
    "Stocking Count\tNot available\tcount\tRequired",
    "Survival %\tNot available\t%\tRequired",
    "Latest ABW\tNot available\tg\tRequired",
    "Estimated Biomass\tNot available\tkg\tRequired",
    "Mortality (latest)\tNot available\tcount\tRequired",
    "Data Age (latest log)\tNot available\tdays/hours\tRequired",
    "Overall Condition Note\tNot available\t\tRequired",
    "SHEET: Latest Water Quality",
    "Parameter\tValue\tUnit\tStatus\tNote",
    "Dissolved Oxygen (DO)\tNot available\tmg/L\tRequired\t",
    "pH\tNot available\t\tRequired\t",
    "Temperature\tNot available\t°C\tRequired\t",
    "Salinity\tNot available\tppt\tRequired\t",
    "Ammonia\tNot available\tmg/L\tRequired\t",
    "Nitrite\tNot available\tmg/L\tRequired\t",
    "Alkalinity\tNot available\tmg/L\tRequired\t",
    "Calcium\tNot available\tmg/L\tRequired\t",
    "Magnesium\tNot available\tmg/L\tRequired\t",
    "Potassium\tNot available\tmg/L\tRequired\t",
    "Observed At\tNot available\t\tRequired\t",
    "SHEET: Recent Changes (7-day)",
    "Parameter\tPrevious\tLatest\tChange\tStatus",
    "DO\tNot available\tNot available\tNot available\tRequired",
    "pH\tNot available\tNot available\tNot available\tRequired",
    "Temperature\tNot available\tNot available\tNot available\tRequired",
    "Salinity\tNot available\tNot available\tNot available\tRequired",
    "Ammonia\tNot available\tNot available\tNot available\tRequired",
    "Nitrite\tNot available\tNot available\tNot available\tRequired",
    "Mortality\tNot available\tNot available\tNot available\tRequired",
    "Feed Quantity\tNot available\tNot available\tNot available\tRequired",
    "SHEET: Feed and Check Tray",
    "Parameter\tValue\tUnit\tStatus",
    "Latest Feed Quantity\tNot available\tkg\tRequired",
    "Feed Frequency / Schedule\tNot available\t\tRequired",
    "Check Tray Left %\tNot available\t%\tRequired",
    "FCR\tNot available\t\tRequired",
    "Cumulative Feed Used\tNot available\tkg\tRequired",
    "SHEET: Shrimp Estimation",
    "Parameter\tValue\tUnit\tStatus",
    "Species\tNot available\t\tRequired",
    "Initial Stock Count\tNot available\tcount\tRequired",
    "Survival Percentage\tNot available\t%\tRequired",
    "Latest ABW\tNot available\tg\tRequired",
    "Estimated Surviving Shrimp\tNot available\tcount\tRequired",
    "Estimated Harvest Biomass\tNot available\tkg\tRequired",
    "Feed Used\tNot available\tkg\tRequired",
    "FCR\tNot available\t\tRequired",
    "Estimated Feed Required\tNot available\tkg\tRequired",
    "SHEET: Health and Action Summary",
    "Parameter\tValue\tStatus",
    "Visible / Reported Signs\tNot available\tRequired",
    "Mortality Concern\tNot available\tRequired",
    "Water Quality Concern\tNot available\tRequired",
    "Feed Concern\tNot available\tRequired",
    "Priority Actions (1)\tRe-ask after selecting the pond with latest logs\tRequired",
    "Priority Actions (2)\tNot available\tRequired",
    "Priority Actions (3)\tNot available\tRequired",
    "Tests Recommended\tNot available\tRequired",
    "What Farmer Should Confirm\tNot available\tRequired",
    "SHEET: Data Required for Reliable Estimation",
    "Parameter\tStatus\tValue",
    "Correct species\tRequired\tNot available",
    "Initial stock count\tRequired\tNot available",
    "Latest ABW\tRequired\tNot available",
    "Current survival percentage\tRequired\tNot available",
    "Current biomass\tRequired\tNot available",
    "Latest DO, pH, temperature, salinity\tRequired\tNot available",
    "Ammonia and nitrite\tRequired\tNot available",
    "Alkalinity / Ca / Mg / K if relevant\tRequired\tNot available",
    "Feed used and FCR\tRequired\tNot available",
    "Recent mortality\tRequired\tNot available",
  ].join("\n");
}

/** Fallback TSV for disease→precautions Excel when the model returns empty. */
export function buildFallbackDiseasePrecautionsDocumentBody(): string {
  return [
    "SHEET: Pond Risk Context",
    "Parameter\tValue\tUnit\tStatus\tRisk Note",
    "Pond Name\tNot available\t\tRequired\t",
    "Species\tNot available\t\tRequired\t",
    "Dissolved Oxygen (DO)\tNot available\tmg/L\tRequired\t",
    "pH\tNot available\t\tRequired\t",
    "Temperature\tNot available\t°C\tRequired\t",
    "Salinity\tNot available\tppt\tRequired\t",
    "Ammonia\tNot available\tmg/L\tRequired\t",
    "Nitrite\tNot available\tmg/L\tRequired\t",
    "Alkalinity\tNot available\tmg/L\tRequired\t",
    "Mortality (latest)\tNot available\tcount\tRequired\t",
    "Check Tray Left %\tNot available\t%\tRequired\t",
    "Latest Feed Quantity\tNot available\tkg\tRequired\t",
    "Data Age (latest log)\tNot available\t\tRequired\t",
    "Overall Risk Note\tRe-open Ask Prana with this pond selected so live log values can fill this sheet.\t\tRequired\t",
    "SHEET: Disease Risks and Precautions",
    "Possible Disease / Risk\tLikelihood\tLinked Pond Evidence\tPrecautions\tTests / Confirm",
    "General stress / infection risk (unspecified)\tLow\tPond parameters were not available for this export\tKeep aeration stable; avoid sudden water/salinity changes; remove dead shrimp promptly; maintain hygiene at water source and equipment\tRetake DO, pH, temperature, salinity, ammonia, nitrite; consult local aqua-lab if mortality rises",
    "SHEET: Immediate Precautions Checklist",
    "Priority\tAction\tBased On",
    "1\tSelect the pond in Ask Prana and re-ask for disease precautions Excel\tMissing Application Context values",
    "2\tUpdate latest daily log (DO, pH, temperature, salinity, ammonia, nitrite, mortality, feed)\tRequired for risk-linked precautions",
    "3\tMonitor shrimp behavior and report unusual signs (swimming, color, empty gut, white feces)\tEarly detection without inventing a diagnosis",
  ].join("\n");
}

export function buildEmptyModelAnswerFallback(
  language: string,
  options?: {
    documentExport?: boolean;
    format?: DocumentFormat | null;
    diseasePrecautions?: boolean;
  },
): string {
  const lang = String(language ?? "English").toLowerCase();
  if (options?.documentExport) {
    if (options.diseasePrecautions) {
      return buildFallbackDiseasePrecautionsDocumentBody();
    }
    // Body for packaging — English TSV is fine; chat caption is localized separately.
    return buildFallbackEstimationDocumentBody();
  }
  if (lang.includes("telugu")) {
    return "క్షమించండి, ఈ సారి సమాధానం పూర్తిగా రాలేదు. దయచేసి మళ్లీ అడగండి — నేను మీ ప్రశ్నకు సహాయం చేస్తాను.";
  }
  if (lang.includes("hindi")) {
    return "क्षमा करें, इस बार पूरा उत्तर नहीं बन पाया। कृपया फिर से पूछें — मैं आपकी मदद करूँगा।";
  }
  return "Sorry — I could not finish that answer just now. Please ask again and I will help with your question.";
}

// ---------------------------------------------------------------------------
// "Give me this in Word" — convert the previous answer, and file naming
// ---------------------------------------------------------------------------

const REFERS_TO_PREVIOUS =
  /\b(this|that|it|above|previous|last|same|everything|all\s+(of\s+)?(this|that|the\s+above|details)|(the|your)\s+(answer|response|reply))\b/i;
const REFERS_TO_PREVIOUS_INDIC = ["ఇది", "ఇదే", "దీన్ని", "దీనిని", "పైది", "పై సమాధానం", "ముందు", "इसे", "इसको", "यह", "यही", "ऊपर", "पिछल"];
/** A new subject in the request means the model must write a new document. */
const NEW_TOPIC = /\b(about|on|for|regarding|explain|what|why|how|which|when|list|guide\s+to)\b|గురించి|ఏమిటి|ఎలా|ఎందుకు|के\s+बारे\s+में|क्या|कैसे|क्यों/i;

/**
 * True for short follow-ups such as "Give me this in Word", "ఇది నాకు వర్డ్
 * డాక్యుమెంట్‌లో ఇవ్వండి" or "इसे Word document में दें" that only ask to
 * package the previous answer.
 */
export function isConvertPreviousAnswerRequest(question: string): boolean {
  const q = question.trim();
  if (!q || q.length > 140) return false;
  const refersBack =
    REFERS_TO_PREVIOUS.test(q) || REFERS_TO_PREVIOUS_INDIC.some((word) => q.includes(word));
  return refersBack && !NEW_TOPIC.test(q);
}

const GENERATED_FILE_MARKER = /^\s*\[Generated downloadable file:/;

/**
 * The most recent substantial assistant answer (verbatim) when the farmer asks
 * to package it; null when a new document must be written instead.
 */
export function findPreviousAnswerForExport(
  question: string,
  conversationHistory: unknown,
  format: DocumentFormat | null,
): string | null {
  // Excel needs SHEET/TSV structure, so the model builds it; Word/PDF reuse prose.
  if (format === "xlsx" || !isConvertPreviousAnswerRequest(question)) return null;
  if (!Array.isArray(conversationHistory)) return null;
  for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
    const turn = conversationHistory[index] as { role?: unknown; text?: unknown } | null;
    if (turn?.role !== "assistant" || typeof turn.text !== "string") continue;
    const text = turn.text.trim();
    // A previous file caption holds no content to convert — let the model write it.
    if (GENERATED_FILE_MARKER.test(text)) return null;
    return text.length >= 80 ? text : null;
  }
  return null;
}

const SMALL_TITLE_WORDS = new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with"]);

function toTitleCase(title: string): string {
  const allCaps = title === title.toUpperCase();
  return title
    .split(/\s+/)
    .map((word, index) => {
      // Keep acronyms / units (DO, FCR, pH, RAS) unless the whole title is shouted.
      if (!allCaps && /[A-Z]/.test(word.slice(1))) return word;
      const lower = word.toLowerCase();
      if (index > 0 && SMALL_TITLE_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/** Safe on Windows, Android, iOS and web: no reserved characters, bounded length. */
function sanitizeDisplayFileName(name: string): string {
  return name
    .replace(/[<>:"/\|?*\u0000-\u001F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 80)
    .trim();
}

/** The document's own title line, when it is a usable Latin-script title. */
function titleFromDocumentBody(body: string): string | null {
  for (const rawLine of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.replace(/^#{1,6}\s*/, "").replace(/\*\*|__/g, "").replace(/^title\s*:\s*/i, "").trim();
    if (!line) continue;
    if (/^SHEET:/i.test(line) || line.includes("\t") || line.startsWith("|")) return null;
    const letters = (line.match(/[A-Za-z]/g) || []).length;
    const indic = (line.match(/[ऀ-ॿఀ-౿]/g) || []).length;
    const looksLikeTitle =
      line.length >= 6 && line.length <= 90 && letters >= 6 && indic === 0 && !/[.!?,;]$/.test(line);
    return looksLikeTitle ? line : null;
  }
  return null;
}

/** Topic keywords (English/Telugu/Hindi) for bodies without a Latin title. */
const TOPIC_FILE_NAMES: Array<[RegExp, string]> = [
  [/disease|వ్యాధి|రోగ|रोग|बीमारी/i, "Diseases and Precautions"],
  [/water\s*quality|నీటి\s*నాణ్యత|पानी\s*की\s*गुणवत्ता/i, "Water Quality Management"],
  [/feed|మేత|దాణా|चारा|फ़ीड|फीड/i, "Feeding Management"],
  [/harvest|పట్టుబడి|హార్వెస్ట్|हार्वेस्ट|कटाई/i, "Harvest Guide"],
  [/stocking|సీడ్|బీజ|स्टॉकिंग/i, "Stocking Guide"],
  [/prepar|తయారీ|तैयारी/i, "Pond Preparation"],
];

const SPECIES_FILE_NAMES: Array<[RegExp, string]> = [
  [/rohu|రోహు|रोहू/i, "Rohu"],
  [/catla|కట్ల|कतला/i, "Catla"],
  [/mrigal|మ్రిగాల్|मृगल/i, "Mrigal"],
  [/tilapia|తిలాపియా|तिलापिया/i, "Tilapia"],
  [/common\s*carp|कॉमन\s*कार्प/i, "Common Carp"],
  [/pangasius|basa|పంగాసియస్|पंगास/i, "Pangasius"],
  [/vannamei|వెనామీ|वनामी/i, "Vannamei"],
  [/shrimp|prawn|రొయ్య|झींगा/i, "Shrimp"],
  [/fish|చేప|मछली/i, "Fish"],
];

/**
 * Meaningful download name, e.g. "Fish Culture Diseases and Precautions.docx".
 * Order: the document's own title → species + topic from the request/body →
 * the existing pond/topic naming.
 */
export function buildDocumentFileName(
  documentBody: string,
  question: string,
  format: DocumentFormat,
  pondName?: string | null,
): string {
  const title = format === "xlsx" ? null : titleFromDocumentBody(documentBody);
  let base = title ? sanitizeDisplayFileName(toTitleCase(title)) : "";
  if (!base) {
    const haystack = `${question}\n${documentBody.slice(0, 600)}`;
    const species = SPECIES_FILE_NAMES.find(([re]) => re.test(haystack))?.[1];
    const topic = TOPIC_FILE_NAMES.find(([re]) => re.test(haystack))?.[1];
    if (species || topic) {
      base = sanitizeDisplayFileName(
        [species, topic ?? (species ? "Farming Guide" : "")].filter(Boolean).join(" "),
      );
    }
  }
  return base ? `${base}.${format}` : buildExportFileName(question, format, pondName);
}
