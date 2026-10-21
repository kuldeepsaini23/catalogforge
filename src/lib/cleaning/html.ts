import sanitizeHtml from "sanitize-html";
import { fixEncoding } from "./encoding";
import { normalizeWhitespace } from "./text";

/** Tags a product description may keep. No attributes are allowed at all. */
export const SAFE_TAGS = [
  "p", "br", "ul", "ol", "li", "strong", "b", "em", "i", "h3", "h4",
  "table", "thead", "tbody", "tr", "th", "td", "blockquote",
];

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: SAFE_TAGS,
  allowedAttributes: {},
  allowedSchemes: [],
  // Drop the *content* of these, not just the tags.
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed", "svg", "math"],
  disallowedTagsMode: "discard",
  transformTags: { b: "strong", i: "em", h1: "h3", h2: "h3" },
  exclusiveFilter: (frame) => ["p", "li", "strong", "em"].includes(frame.tag) && !frame.text.trim(),
};

export interface SanitizedHtml {
  html: string;
  text: string;
  removed: string[];
}

/** Sanitises supplier HTML with sanitize-html and reports what was removed. */
export function sanitizeDescription(raw: string | null | undefined): SanitizedHtml | null {
  const input = fixEncoding(raw ?? "").trim();
  if (!input) return null;
  const removed: string[] = [];
  if (/<script\b/i.test(input)) removed.push("script");
  if (/\son[a-z]+\s*=/i.test(input)) removed.push("event handler");
  if (/<style\b|\sstyle\s*=/i.test(input)) removed.push("style");
  if (/<iframe\b|<object\b|<embed\b/i.test(input)) removed.push("embed");
  if (/javascript:/i.test(input)) removed.push("javascript: url");

  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(input);
  const html = looksLikeHtml
    ? sanitizeHtml(input, OPTIONS).replace(/\n{2,}/g, "\n").trim()
    : input
        .split(/\n{2,}/)
        .map((p) => `<p>${escapeHtml(normalizeWhitespace(p))}</p>`)
        .join("");
  return { html, text: htmlToText(html), removed };
}

/** Plain text for language detection, claim verification and prompts. */
export function htmlToText(html: string): string {
  const text = sanitizeHtml(html.replace(/<\/(p|li|h3|h4|tr|br)>|<br\s*\/?>/gi, "$& "), {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: OPTIONS.nonTextTags,
  });
  return normalizeWhitespace(decodeEntities(text));
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** Sanitises model-produced HTML the same way (models can echo supplier junk). */
export function sanitizeOutputHtml(html: string): string {
  return sanitizeHtml(html, OPTIONS).trim();
}
