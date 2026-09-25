import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addEntries,
  assertBook,
  emptyBook,
  newEntry,
  parseYuan,
  summarize,
  voidEntry,
} from '../ledger.js';

const yuan = parseYuan;
const add = (book, kind, amount, options = {}) =>
  addEntries(book, [newEntry(kind, yuan(amount), options)]);

function balanced(totals) {
  const assets = totals.cashCents + totals.inventoryCents
    + totals.receivableCents.me + totals.receivableCents.partner;
  const claims = totals.capitalCents.me + totals.capitalCents.partner
    + totals.payableCents.me + totals.payableCents.partner + totals.profitCents;
  assert.equal(assets, claims, 'cash + stock + collected sales must equal capital + advances + profit');
}

test('deposits and each partner’s personal purchase show separate capital and advances', () => {
  let book = add(emptyBook(), 'deposit', '100', { person: 'me' });
  book = add(book, 'deposit', '80', { person: 'partner' });
  book = add(book, 'purchase', '50', { source: 'treasury' });
  book = add(book, 'purchase', '30', { source: 'me' });
  book = add(book, 'purchase', '40', { source: 'partner' });
  const totals = summarize(book.entries);

  assert.equal(totals.cashCents, yuan('130'));
  assert.equal(totals.inventoryCents, yuan('120'));
  assert.deepEqual(totals.capitalCents, { me: yuan('100'), partner: yuan('80') });
  assert.deepEqual(totals.personalAdvanceCents, { me: yuan('30'), partner: yuan('40') });
  assert.deepEqual(totals.payableCents, { me: yuan('30'), partner: yuan('40') });
  assert.equal(totals.profitCents, 0);
  balanced(totals);
});

test('a sale records cash and profit only after subtracting sold stock cost', () => {
  let book = add(emptyBook(), 'deposit', '100', { person: 'me' });
  book = add(book, 'purchase', '60', { source: 'treasury' });
  book = add(book, 'sale', '50', { source: 'treasury', costCents: yuan('20') });
  const totals = summarize(book.entries);

  assert.equal(totals.cashCents, yuan('90'));
  assert.equal(totals.inventoryCents, yuan('40'));
  assert.equal(totals.salesCents, yuan('50'));
  assert.equal(totals.soldCostCents, yuan('20'));
  assert.equal(totals.profitCents, yuan('30'));
  assert.equal(totals.recoveryCents, -yuan('10'), 'the remaining stock has not yet been covered by sales');
  assert.equal(totals.pendingCostCount, 0);
  balanced(totals);
});

test('all-purchase recovery excludes partner deposits and counts stock refunds without double counting stock loss', () => {
  let book = add(emptyBook(), 'deposit', '100', { person: 'me' });
  assert.equal(summarize(book.entries).recoveryCents, 0);
  book = add(book, 'purchase', '60', { source: 'treasury' });
  assert.equal(summarize(book.entries).recoveryCents, -yuan('60'));
  book = add(book, 'sale', '50', { source: 'partner', costCents: yuan('20') });
  book = add(book, 'stock_loss', '5');
  let totals = summarize(book.entries);
  assert.equal(totals.profitCents, yuan('25'));
  assert.equal(totals.inventoryCents, yuan('35'));
  assert.equal(totals.recoveryCents, -yuan('10'));
  assert.equal(totals.cashCents, yuan('40'), 'a partner-collected sale has not entered the treasury');

  book = add(book, 'purchase_refund', '10', { source: 'treasury' });
  book = add(book, 'expense', '5', { source: 'me' });
  book = add(book, 'other_income', '5');
  totals = summarize(book.entries);
  assert.equal(totals.recoveryCents, 0);
  assert.equal(totals.profitCents, yuan('25'));
  assert.equal(totals.inventoryCents, yuan('25'));
  assert.equal(totals.recoveryCents, totals.profitCents - totals.inventoryCents);
  balanced(totals);

  book = add(book, 'sale', '10', { source: 'treasury', costCents: yuan('5') });
  totals = summarize(book.entries);
  assert.equal(totals.recoveryCents, yuan('10'), 'additional sales move the whole-stall recovery above zero');
  assert.equal(totals.recoveryCents, totals.profitCents - totals.inventoryCents);
  balanced(totals);
});

test('a legacy sale with missing cost is visibly pending until one supplemental cost is entered', () => {
  let book = add(emptyBook(), 'deposit', '50', { person: 'me' });
  book = add(book, 'purchase', '50', { source: 'treasury' });
  book = add(book, 'sale', '80');
  const saleId = book.entries.at(-1).id;
  let totals = summarize(book.entries);
  assert.equal(totals.pendingCostCount, 1);
  assert.equal(totals.inventoryCents, yuan('50'));
  assert.equal(totals.profitCents, yuan('80'));
  assert.equal(totals.recoveryCents, yuan('30'), 'revenue coverage remains knowable before sold cost is supplied');
  balanced(totals);

  book = add(book, 'sale_cost', '30', { saleId });
  totals = summarize(book.entries);
  assert.equal(totals.pendingCostCount, 0);
  assert.equal(totals.inventoryCents, yuan('20'));
  assert.equal(totals.profitCents, yuan('50'));
  assert.equal(totals.recoveryCents, yuan('30'), 'adding sold cost reallocates stock to profit but not total purchase recovery');
  balanced(totals);
});

test('an explicitly zero-cost sale can be marked complete instead of staying pending', () => {
  let book = add(emptyBook(), 'sale', '10', { source: 'treasury' });
  const saleId = book.entries[0].id;
  assert.equal(summarize(book.entries).pendingCostCount, 1);
  book = addEntries(book, [newEntry('sale_cost', 0, { saleId })]);
  const totals = summarize(book.entries);
  assert.equal(totals.pendingCostCount, 0);
  assert.equal(totals.profitCents, yuan('10'));
  balanced(totals);
});

test('sale cost cannot be supplemented twice, and voiding the supplement reopens it', () => {
  let book = add(emptyBook(), 'deposit', '50', { person: 'me' });
  book = add(book, 'purchase', '50', { source: 'treasury' });
  book = add(book, 'sale', '80', { source: 'treasury' });
  const saleId = book.entries.at(-1).id;
  book = add(book, 'sale_cost', '30', { saleId });
  const firstCostId = book.entries.at(-1).id;
  assert.throws(() => add(book, 'sale_cost', '10', { saleId }), /只能补录一次/);

  book = voidEntry(book, firstCostId);
  assert.equal(summarize(book.entries).pendingCostCount, 1);
  assert.equal(summarize(book.entries).inventoryCents, yuan('50'));
  book = add(book, 'sale_cost', '25', { saleId });
  assert.equal(summarize(book.entries).pendingCostCount, 0);
  assert.equal(summarize(book.entries).profitCents, yuan('55'));
  balanced(summarize(book.entries));

  book = voidEntry(book, saleId);
  assert.ok(book.entries.at(-1).voidedAt, 'voiding a sale must void its active supplemental cost');
  assert.equal(summarize(book.entries).pendingCostCount, 0);
  assert.equal(summarize(book.entries).inventoryCents, yuan('50'));
  assert.equal(summarize(book.entries).profitCents, 0);
  balanced(summarize(book.entries));
});

test('stock refund reverses inventory and the original funding source, without changing profit', () => {
  let book = add(emptyBook(), 'deposit', '100', { person: 'me' });
  book = add(book, 'purchase', '60', { source: 'treasury' });
  book = add(book, 'purchase_refund', '20', { source: 'treasury' });
  book = add(book, 'purchase', '40', { source: 'partner' });
  book = add(book, 'purchase_refund', '10', { source: 'partner' });
  const totals = summarize(book.entries);

  assert.equal(totals.cashCents, yuan('60'));
  assert.equal(totals.inventoryCents, yuan('70'));
  assert.equal(totals.payableCents.partner, yuan('30'));
  assert.equal(totals.profitCents, 0);
  balanced(totals);
  assert.throws(() => add(book, 'purchase_refund', '31', { source: 'partner' }), /进货|退货|待报销金额/);
});

test('a stock refund cannot borrow a partner’s unrelated expense advance', () => {
  let book = add(emptyBook(), 'deposit', '100', { person: 'me' });
  book = add(book, 'purchase', '50', { source: 'treasury' });
  book = add(book, 'expense', '20', { source: 'partner' });
  assert.throws(
    () => add(book, 'purchase_refund', '10', { source: 'partner' }),
    /进货|退货/,
    'the partner never personally bought stock, so this refund source is impossible',
  );
  book = add(book, 'purchase', '10', { source: 'partner' });
  assert.throws(
    () => add(book, 'purchase_refund', '11', { source: 'partner' }),
    /进货|退货/,
    'a refund must not exceed that person’s purchase, even if other advances remain payable',
  );
});

test('stock loss reduces stock and profit; overselling or over-refunding stock is rejected', () => {
  let book = add(emptyBook(), 'deposit', '100', { person: 'me' });
  book = add(book, 'purchase', '30', { source: 'treasury' });
  book = add(book, 'stock_loss', '5');
  let totals = summarize(book.entries);
  assert.equal(totals.inventoryCents, yuan('25'));
  assert.equal(totals.profitCents, -yuan('5'));
  balanced(totals);

  assert.throws(() => add(book, 'sale', '50', { source: 'treasury', costCents: yuan('26') }), /成本不能超过/);
  assert.throws(() => add(book, 'purchase_refund', '26', { source: 'treasury' }), /成本不能超过/);
  book = add(book, 'sale', '40', { source: 'partner' });
  const saleId = book.entries.at(-1).id;
  assert.throws(() => add(book, 'sale_cost', '26', { saleId }), /成本不能超过/);
  book = add(book, 'sale_cost', '20', { saleId });
  totals = summarize(book.entries);
  assert.equal(totals.receivableCents.partner, yuan('40'));
  assert.equal(totals.inventoryCents, yuan('5'));
  assert.equal(totals.profitCents, yuan('15'));
  balanced(totals);
});

test('reimbursement and advance-to-capital conversion settle claims without creating profit', () => {
  let book = add(emptyBook(), 'deposit', '100', { person: 'me' });
  book = add(book, 'purchase', '60', { source: 'partner' });
  book = add(book, 'reimbursement', '20', { person: 'partner' });
  book = add(book, 'convert_advance', '40', { person: 'partner' });
  const totals = summarize(book.entries);

  assert.equal(totals.cashCents, yuan('80'));
  assert.equal(totals.inventoryCents, yuan('60'));
  assert.deepEqual(totals.capitalCents, { me: yuan('100'), partner: yuan('40') });
  assert.equal(totals.payableCents.partner, 0);
  assert.equal(totals.reimbursedCents.partner, yuan('20'));
  assert.equal(totals.convertedAdvanceCents.partner, yuan('40'));
  assert.equal(totals.profitCents, 0);
  balanced(totals);
});

test('import validation catches an orphan or second cost record', () => {
  let book = add(emptyBook(), 'deposit', '50', { person: 'me' });
  book = add(book, 'purchase', '50', { source: 'treasury' });
  book = add(book, 'sale', '80', { source: 'treasury' });
  const saleId = book.entries.at(-1).id;
  assert.throws(() => add(book, 'sale_cost', '10', { saleId: 'missing' }), /对应一笔/);
  book = add(book, 'sale_cost', '10', { saleId });
  const corrupt = structuredClone(book);
  corrupt.entries.push(newEntry('sale_cost', yuan('5'), { saleId }));
  assert.throws(() => assertBook(corrupt), /只能补录一次/);
});
