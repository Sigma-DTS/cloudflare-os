// Small helpers the Word writer and editor share: the WordprocessingML namespaces a written part
// declares, and timestamps as Word writes them.

/** WordprocessingML (Transitional), the namespace every part Word writes uses. */
export const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
/** Office relationships, the namespace of `r:id` attributes. */
export const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** The prefix of every Transitional relationship type URI. */
export const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** An ISO 8601 timestamp to the second, as revision marks and core properties use. */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The XML declaration every part starts with. */
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
