interface ReleaseNotesProps {
  body: string;
  /** Class prefix for the rendered blocks (e.g. "whats-new" produces
   * "whats-new-heading"/"whats-new-list"/"whats-new-paragraph") - lets each
   * caller (the What's New modal, Settings' Update History list) keep its
   * own visual context while sharing this one parser. */
  classPrefix: string;
}

/** A GitHub release body is plain Markdown - this app has no Markdown
 * renderer dependency and a changelog is simple enough (headings, bullets,
 * paragraphs) not to need one. Blank-line-separated blocks become either a
 * bullet list (every line starts with "-"/"*") or a paragraph; a line
 * starting with "#" becomes a small sub-heading instead. Shared by
 * WhatsNewModal and Settings' Update History so both render the exact same
 * release text the same way. */
function ReleaseNotes({ body, classPrefix }: ReleaseNotesProps) {
  const blocks = body.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length === 0) return null;
        if (/^#{1,6}\s/.test(lines[0]) && lines.length === 1) {
          return (
            <p key={i} className={`${classPrefix}-heading`}>
              {lines[0].replace(/^#{1,6}\s*/, "")}
            </p>
          );
        }
        if (lines.every((l) => /^[-*]\s+/.test(l))) {
          return (
            <ul key={i} className={`${classPrefix}-list`}>
              {lines.map((l, j) => (
                <li key={j}>{l.replace(/^[-*]\s+/, "")}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i} className={`${classPrefix}-paragraph`}>
            {lines.join(" ")}
          </p>
        );
      })}
    </>
  );
}

export default ReleaseNotes;
