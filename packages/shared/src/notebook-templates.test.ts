import { describe, expect, it } from 'vitest';
import { FIELD_TYPES } from './fields.js';
import { notebookDefinitionSchema } from './notebook-file.js';
import { NOTEBOOK_TEMPLATES } from './notebook-templates.js';

describe('the notebook templates', () => {
  it('are each a definition the import endpoint accepts as written', () => {
    for (const { id: _id, description: _description, ...definition } of NOTEBOOK_TEMPLATES) {
      // Equal after parsing, not merely parseable: a value the schema would trim or
      // rewrite is one the chooser would show differently from what gets made.
      expect(notebookDefinitionSchema.parse(definition)).toEqual(definition);
    }
  });

  it('use every field type at least once, so the chooser shows what fields can do', () => {
    const used = new Set(NOTEBOOK_TEMPLATES.flatMap((t) => t.fields.map((f) => f.type)));
    expect([...FIELD_TYPES].filter((type) => !used.has(type))).toEqual([]);
  });

  it('have distinct ids and names, and no field named twice within one', () => {
    const ids = NOTEBOOK_TEMPLATES.map((t) => t.id);
    const names = NOTEBOOK_TEMPLATES.map((t) => t.name.toLowerCase());
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    for (const t of NOTEBOOK_TEMPLATES) {
      const fields = t.fields.map((f) => f.name.toLowerCase());
      expect(new Set(fields).size, t.name).toBe(fields.length);
    }
  });
});
