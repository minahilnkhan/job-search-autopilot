/**
 * Shows the line from the posting behind a verdict. The server wraps the exact
 * matched words in «»; those get the highlighter, the context stays plain.
 */
export function Evidence({ text }: { text?: string }) {
  if (!text) return null;
  const parts = text.split(/«|»/);
  return (
    <p className="evidence">
      {parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}
    </p>
  );
}
