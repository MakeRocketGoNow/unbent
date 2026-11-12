import { useState } from 'react';
import { CopyIcon } from './icons.js';

/** This instance's MCP server, from the origin the page was loaded from. */
export function mcpUrl(): string {
  return `${window.location.origin}/api/mcp`;
}

/**
 * The MCP server URL for this instance, with a button that copies it.
 *
 * The URL is built from the current origin rather than hardcoded, because the same page
 * serves unbent.app and every self-hosted instance, and a self-hosted user pasting a
 * production URL into Claude would get someone else's consent screen.
 *
 * Shared by the AI assistants settings page and the help page, so both hand over the
 * address the same way: with a copy button, since on a phone selecting a long `<code>`
 * run by hand is the hard part.
 */
export function McpUrl() {
  const [copied, setCopied] = useState(false);
  const url = mcpUrl();

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can fail in older browsers or non-https contexts; the URL is
      // still visible to select and copy by hand, so this is not worth an error message.
    }
  }

  return (
    <span className="mcp-url-wrap">
      <code className="mcp-url">{url}</code>
      <button
        type="button"
        className="mcp-copy"
        onClick={() => void copy()}
        aria-label="Copy URL"
        data-tip={copied ? 'Copied' : 'Copy'}
      >
        {copied ? '✓' : <CopyIcon />}
      </button>
    </span>
  );
}
