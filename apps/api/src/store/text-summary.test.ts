import { describe, expect, it } from 'vitest';
import { textSummary } from './text-summary.js';
import { summarize } from './attachments.js';

/**
 * The shapes a text layer's summary has to survive (MAK-177), each invented: what a
 * parser sees on a warehouse-club receipt, a printed web page and a statement, never
 * a real one.
 */
describe('a text layer’s summary', () => {
  it('names a receipt’s total and date, wherever they are', () => {
    const receipt = [
      '#12 SPRINGFIELD',
      '1234 MAIN ST. SPRINGFIELD, ST 00000',
      'MEMBER #000000000001',
      ...Array.from({ length: 30 }, (_, i) => `ITEM ${i} WIDGET ${i + 1}.99`),
      'SUBTOTAL $112.40',
      'TAX $8.99',
      'TOTAL SAVINGS $3.00',
      '**** TOTAL $121.39',
      'VISA $121.39',
      '03/02/2026 14:22',
    ].join('\n');
    const summary = textSummary(receipt);
    expect(summary).toMatch(/^#?12 SPRINGFIELD 1234 MAIN ST/);
    // The subtotal, the tax and the savings are amounts too, and not the one paid.
    expect(summary).toMatch(/… · Total: \$121\.39 · Date: 2026-03-02$/);
    // The member number is a long run of digits: never an amount, never repeated.
    expect(summary).not.toContain('000000000001 ·');
  });

  it('names what a statement says is owed, not a fee line or the minimum payment', () => {
    const statement = [
      'Acme Card Statement',
      'New Balance $1,234.56',
      'Minimum Payment Due $35.00',
      'Minimum Amount Due $35.00',
      'Payment Due Date 04/02/2026',
      'Total fees charged this period $0.00',
      'Total interest charged this period $0.00',
    ].join('\n');
    expect(textSummary(statement)).toMatch(/ · Total: \$1,234\.56 · Date: 2026-04-02$/);
    // A labelled "due" beats a bare "Total" printed after it.
    expect(textSummary('Acme\nTotal amount due $90.00\nTotal $12.00')).toMatch(/ · Total: \$90\.00$/);
  });

  it('takes a total that mentions tax or a tip, and not the tax’s own total', () => {
    expect(textSummary('Acme Diner\nTax total $0.41\nTotal (incl. tax) $4.95')).toMatch(/ · Total: \$4\.95$/);
    expect(textSummary('Acme Diner\nTotal with tip $48.00')).toMatch(/ · Total: \$48\.00$/);
    expect(textSummary('Acme Diner\nTotal tax included $4.95')).toMatch(/ · Total: \$4\.95$/);
    expect(textSummary('Acme Diner\nTotal $40.00\nTotal tax $3.20\nTotal number of items sold 4')).toMatch(/ · Total: \$40\.00$/);
  });

  it('drops a printed page’s address header and keeps its words', () => {
    const page = '2/9/2014 Transaction Receipt [https://orders.example.com/pay;jsessionid=AB12](<https://orders.example.com/pay;jsessionid=AB12>)\n\nAcme Tickets\nOrder Number: AT-55120\nAmount paid: $45.00';
    expect(textSummary(page)).toBe(
      '2/9/2014 Transaction Receipt Acme Tickets Order Number: AT-55120 Amount paid: $45.00 · Total: $45.00 · Date: 2014-02-09 · Order #AT-55120',
    );
  });

  it('takes a total’s figure from the line below its label', () => {
    expect(textSummary('Acme Hardware\n| Amount due |\n| $17.27 |\nInvoice #4471')).toBe(
      'Acme Hardware Amount due Invoice #4471 · Total: $17.27 · Invoice #4471',
    );
  });

  it('lists the amounts when nothing is labelled the total, and dates in the order written', () => {
    // A plain "3" earlier hides nothing: a receipt's "ITEM 3" once took the value 3 and
    // the "$3.00" further down with it.
    expect(textSummary('Acme\nITEM 3 WIDGET 8.99\nRefund $8.99\nCredit $3.00')).toBe('Acme ITEM 3 WIDGET 8.99 Refund $8.99 Credit $3.00 · Amounts: $8.99, $3.00');
    expect(textSummary('Globex Savings Plan\nPeriod 2026-01-01 to 2026-03-31\nContributions $1,200.00\nBalance $14,350.10')).toBe(
      'Globex Savings Plan Period 2026-01-01 to 2026-03-31 Contributions $1,200.00 Balance $14,350.10 · Dates: 2026-01-01, 2026-03-31 · Amounts: $1,200.00, $14,350.10',
    );
  });

  it('finds an order or invoice number, and does not take a label for one', () => {
    expect(textSummary('Contoso Auto Repair - Invoice 2026-0117')).toBe('Contoso Auto Repair - Invoice 2026-0117 · Invoice #2026-0117');
    expect(textSummary('Litware\nOrder 55821')).toMatch(/ · Order #55821$/);
    // "Order total" and "Invoice date" name no number, a date is not an order number, and
    // "Order 12 items" is a count.
    expect(textSummary('Order total: $9.00\nInvoice date: 2026-03-02\nOrder 12 items')).not.toMatch(/Order #|Invoice #/);
  });

  it('cuts the opening at a word', () => {
    const opening = textSummary(`${'Acme '.repeat(50)}\nTotal $5.00`).split(' · ')[0]!;
    expect(opening.length).toBeLessThanOrEqual(150);
    expect(opening).toMatch(/Acme…$/);
  });

  it('is the folded text, cut, when it finds nothing to name', () => {
    expect(textSummary('—— 1 ——')).toBe('');
    expect(summarize('application/pdf', '—— 1\n——', null)).toEqual({ read: 'text', summary: '—— 1 ——' });
    expect(summarize('application/pdf', `Acme\n${'Total $5.00\n'.repeat(5)}`, null).summary).toBe('Acme Total $5.00 Total $5.00 Total $5.00 Total $5.00 Total $5.00 · Total: $5.00');
  });
});
