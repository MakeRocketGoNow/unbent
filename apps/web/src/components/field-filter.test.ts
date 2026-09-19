import { describe, expect, it } from 'vitest';
import type { FieldDef } from '@unbent/shared';
import { fieldFilterLabel } from './field-filter.js';

const def = (id: string, name: string, type: FieldDef['type']): FieldDef => ({
  id,
  notebookId: 'nb',
  name,
  type,
  options: [],
  scale: null,
  currency: null,
  position: 0,
});
const DEFS = [
  def('cat', 'Category', 'select'),
  def('paid', 'Reimbursed', 'checkbox'),
  def('amt', 'Amount', 'number'),
  def('on', 'Paid on', 'date'),
  def('who', 'Merchant', 'text'),
  { ...def('cost', 'Price', 'number'), currency: 'USD' },
];

describe('fieldFilterLabel', () => {
  it('names each op the way the control that set it did', () => {
    expect(fieldFilterLabel('cat:eq:Food', DEFS)).toBe('Category: Food');
    expect(fieldFilterLabel('amt:gte:20', DEFS)).toBe('Amount ≥ 20');
    expect(fieldFilterLabel('on:lte:2026-01-10', DEFS)).toBe('Paid on ≤ 2026-01-10');
    expect(fieldFilterLabel('who:set', DEFS)).toBe('Merchant is set');
    expect(fieldFilterLabel('who:empty', DEFS)).toBe('Merchant is empty');
  });

  it('draws an amount\'s bound as money', () => {
    const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(20);
    expect(fieldFilterLabel('cost:gte:20', DEFS)).toBe(`Price ≥ ${money}`);
    expect(fieldFilterLabel('cost:set', DEFS)).toBe('Price is set');
  });

  it('reads a checkbox as a statement', () => {
    expect(fieldFilterLabel('paid:eq:true', DEFS)).toBe('Reimbursed');
    expect(fieldFilterLabel('paid:eq:false', DEFS)).toBe('Not reimbursed');
  });

  it('still names a filter whose field it cannot find', () => {
    expect(fieldFilterLabel('gone:eq:Food', DEFS)).toBe('Unknown field: Food');
    expect(fieldFilterLabel('nonsense', DEFS)).toBe('Unreadable field filter');
  });
});
