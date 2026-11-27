/** Open questions in a brief: a leaf module, so the plan's rules can read them without the dashboard's graph. */

const NONE = /^[-*>\s]*(?:none|no|nothing|n\/a|немає|нема|нет|—|–|-)?[.!\s]*$/i;
/** "## Open questions", "Open questions:", "**Open questions:** …", also in Ukrainian or Russian; groups: heading mark, colon (either side of the bold), the rest. */
const QUESTIONS = /^\s*(#{1,6}\s+)?(?:\*\*)?(?:open questions|відкриті питання|открытые вопросы)\s*(:)?\s*(?:\*\*)?\s*(:)?\s*(.*)$/i;
const ANY_HEADING = /^\s*#{1,6}\s/;
/** A line that starts another labeled part: "Notes:", "**Notes:**"; one that ends in "?" is a question, not a label. */
const LABEL = /^\s*(?:\*\*[^*]+\*\*|[\p{L}' ]{1,40}:)(?:\s|$)/u;
/** A checklist item ticked as answered. */
const CLOSED = /^\s*[-*]\s*\[[xX]\]/;

/**
 * The first open question a brief lists under an "Open questions" heading or labeled line (also in
 * Ukrainian or Russian), "" when it lists none, only "none", or only ticked items. Prose that merely
 * mentions open questions is no heading. Under a heading the list ends at a blank line after it, at
 * the next heading or at another labeled line. A question left open is the person's to answer before
 * an agent runs on the brief.
 */
export function openQuestion(brief: string): string {
  const lines = brief.split("\n");
  const open = (line: string) => line.trim() !== "" && !NONE.test(line.trim()) && !CLOSED.test(line);
  const said = (line: string) => line.trim().replace(/^[-*>\s]+(?:\[ \]\s*)?/, "").replace(/\*\*/g, "").slice(0, 160);
  for (let i = 0; i < lines.length; i += 1) {
    const m = QUESTIONS.exec(lines[i]!);
    if (!m) continue;
    const rest = m[4] ?? "";
    // "Open questions are tracked elsewhere": a sentence, not a heading.
    if (!m[1] && !m[2] && !m[3] && rest) continue;
    if (rest) {
      if (open(rest)) return said(rest);
      continue;
    }
    let listed = false;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]!;
      if (ANY_HEADING.test(line) || (LABEL.test(line) && !line.trim().endsWith("?")) || QUESTIONS.test(line)) break;
      if (!line.trim()) {
        if (listed) break;
        continue;
      }
      listed = true;
      if (open(line)) return said(line);
    }
  }
  return "";
}
