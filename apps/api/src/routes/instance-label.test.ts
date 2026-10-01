import { describe, expect, it } from 'vitest';
import { instanceKindOf, instanceLabelOf } from './auth.js';

/**
 * The label is what tells a tab of a scratch instance from production's, so the case that
 * matters most is the one that draws nothing: production sets no label, and a blank one
 * must not turn into an empty prefix in front of every title.
 */
describe('instanceLabelOf', () => {
  it('is absent when unset or blank, which is how production draws no marker', () => {
    expect(instanceLabelOf({})).toBeUndefined();
    expect(instanceLabelOf({ INSTANCE_LABEL: '   ' })).toBeUndefined();
  });

  it('trims the setting and keeps it short enough for a tab', () => {
    expect(instanceLabelOf({ INSTANCE_LABEL: '  PR 222 ' })).toBe('PR 222');
    expect(instanceLabelOf({ INSTANCE_LABEL: 'x'.repeat(60) })).toHaveLength(24);
  });
});

describe('instanceKindOf', () => {
  it('passes the three kinds the page draws, in any case', () => {
    expect(instanceKindOf({ INSTANCE_KIND: 'dev' })).toBe('dev');
    expect(instanceKindOf({ INSTANCE_KIND: ' Preview ' })).toBe('preview');
    expect(instanceKindOf({ INSTANCE_KIND: 'local' })).toBe('local');
  });

  it('reads anything else as unset rather than drawing an unknown kind', () => {
    expect(instanceKindOf({})).toBeUndefined();
    expect(instanceKindOf({ INSTANCE_KIND: 'staging' })).toBeUndefined();
  });
});
