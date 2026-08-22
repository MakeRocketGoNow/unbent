import { useMemo } from 'react';
import { renderMarkdown } from '@unbent/shared';

interface PreviewProps {
  markdown: string;
  noteId: string;
}

/**
 * Rendered markdown. The HTML is produced by the shared pipeline, which runs
 * rehype-sanitize — dangerouslySetInnerHTML is safe here only because of that, so the two
 * must never be separated.
 */
export function Preview({ markdown, noteId }: PreviewProps) {
  const html = useMemo(() => renderMarkdown(markdown, { noteId }), [markdown, noteId]);
  return <div className="preview" dangerouslySetInnerHTML={{ __html: html }} />;
}
