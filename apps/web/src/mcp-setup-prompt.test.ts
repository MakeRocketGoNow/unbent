import { describe, expect, it } from 'vitest';
import { mcpSetupPrompt } from './mcp-setup-prompt.js';

describe('mcpSetupPrompt', () => {
  const url = 'https://notes.example.com/api/mcp';
  const prompt = mcpSetupPrompt(url);

  it('names the instance it was built for, never unbent.app', () => {
    expect(prompt).toContain(`claude mcp add --transport http --scope user unbent ${url}`);
    expect(prompt).not.toContain('unbent.app');
  });

  it('writes every JSON snippet with the URL in it', () => {
    expect(prompt).toContain(`"unbent": {"url":"${url}"}`);
    expect(prompt).toContain(`"unbent": {"serverUrl":"${url}"}`);
    expect(prompt).toContain(`code --add-mcp '{"name":"unbent","type":"http","url":"${url}"}'`);
  });

  it('points at the page where the connection can be undone', () => {
    expect(prompt).toContain('https://notes.example.com/settings/connected-apps');
  });

  it('carries no em-dash', () => {
    expect(prompt).not.toContain('—');
  });
});
