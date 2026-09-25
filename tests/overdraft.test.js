import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addEntries,
  assertBook,
  emptyBook,
  newEntry,
  parseYuan,
  resolveFunding,
  summarize,
  voidEntry,
} from '../ledger.js';

const yuan = parseYuan;
const add = (book, kind, amount, options = {}) =>
  addEntries(book, [newEntry(kind, yuan(amount), options)]);

function balanced(book) {
  const totals = summarize(book.entries);
  const assets = totals.cashCents + totals.inventoryCents
    + totals.receivableCents.me + totals.receivableCents.partner;
  const claims = totals.capitalCents.me + totals.capitalCents.partner
    + totals.payableCents.me + totals.payableCents.partner
    + totals.supplierPayableCents + totals.profitCents;
  assert.equal(assets, claims, 'cash + stock + receivables = capital + partner debt + supplier debt + profit');
  return totals;
}

test('a treasury purchase can overdraw cash and opens a persistent funding review', () => {
  let book = add(emptyBook(), 'deposit', '20', { person: 'me' });
  book = add(book, 'purchase', '70', { source: 'treasury' });
  const purchase = book.entries.at(-1);
  let totals = balanced(book);

  assert.equal(purchase.fundingReviewCents, yuan('50'));
  assert.equal(totals.cashCents, -yuan('50'));
  assert.equal(totals.inventoryCents, yuan('70'));
  assert.equal(totals.pendingFundingCents, yuan('50'));
  assert.equal(totals.pendingFundingCount, 1);
  assert.equal(totals.profitCents, 0, 'buying stock is not yet a loss');

  book = add(book, 'deposit', '100', { person: 'partner' });
  totals = balanced(book);
  assert.equal(totals.cashCents, yuan('50'));
  assert.equal(totals.pendingFundingCents, yuan('50'), 'a later deposit must not silently classify an older shortfall');
  assert.equal(totals.pendingFundingCount, 1);
});

test('each purchase or expense records only its newly unexplained shortfall', () => {
  let book = add(emptyBook(), 'deposit', '20', { person: 'me' });
  book = add(book, 'purchase', '30', { source: 'treasury' });
  assert.equal(book.entries.at(-1).fundingReviewCents, yuan('10'));
  book = add(book, 'expense', '25', { source: 'treasury' });
  assert.equal(book.entries.at(-1).fundingReviewCents, yuan('25'));
  const totals = balanced(book);
  assert.equal(totals.cashCents, -yuan('35'));
  assert.equal(totals.pendingFundingCents, yuan('35'));
  assert.equal(totals.pendingFundingCount, 2);
  assert.equal(totals.profitCents, -yuan('25'));
});

test('partial personal and supplier corrections leave the original purchase intact', () => {
  let book = add(emptyBook(), 'deposit', '20', { person: 'me' });
  book = add(book, 'purchase', '70', { source: 'treasury' });
  const purchaseId = book.entries.at(-1).id;
  const original = structuredClone(book.entries.at(-1));

  book = resolveFunding(book, purchaseId, 'funding_to_person', yuan('20'), { person: 'partner' });
  let totals = balanced(book);
  assert.equal(totals.cashCents, -yuan('30'));
  assert.equal(totals.payableCents.partner, yuan('20'));
  assert.equal(totals.pendingFundingCents, yuan('30'));
  assert.equal(totals.pendingFundingCount, 1);
  assert.equal(book.entries.find(entry => entry.id === purchaseId)?.voidedAt, null);

  book = resolveFunding(book, purchaseId, 'funding_to_supplier', yuan('30'), { creditor: '进货商' });
  totals = balanced(book);
  assert.equal(totals.cashCents, 0);
  assert.equal(totals.inventoryCents, yuan('70'));
  assert.equal(totals.payableCents.partner, yuan('20'));
  assert.equal(totals.supplierPayableCents, yuan('30'));
  assert.equal(totals.pendingFundingCents, 0);
  assert.equal(totals.pendingFundingCount, 0);
  assert.deepEqual(book.entries.find(entry => entry.id === purchaseId), original,
    'the original purchase remains an auditable source transaction');
  assert.throws(
    () => resolveFunding(book, purchaseId, 'funding_confirmed', yuan('1'), { reason: 'true_overdraft' }),
    /超过|待核|已处理|金额/,
  );
});

test('a confirmed genuine overdraft closes the reminder without fabricating money', () => {
  let book = add(emptyBook(), 'expense', '12', { source: 'treasury' });
  const expenseId = book.entries.at(-1).id;
  book = resolveFunding(book, expenseId, 'funding_confirmed', yuan('12'), { reason: 'true_overdraft' });
  const totals = balanced(book);
  assert.equal(totals.cashCents, -yuan('12'));
  assert.equal(totals.expensesCents, yuan('12'));
  assert.equal(totals.pendingFundingCents, 0);
  assert.equal(totals.pendingFundingCount, 0);
  assert.equal(totals.supplierPayableCents, 0);
});

test('a later missing receipt needs an explicit link and cannot be reused beyond its value', () => {
  let book = add(emptyBook(), 'purchase', '30', { source: 'treasury' });
  const purchaseId = book.entries.at(-1).id;
  book = add(book, 'expense', '20', { source: 'treasury' });
  const expenseId = book.entries.at(-1).id;
  book = add(book, 'deposit', '40', { person: 'partner' });
  const receiptId = book.entries.at(-1).id;
  assert.equal(balanced(book).pendingFundingCents, yuan('50'));

  book = resolveFunding(book, purchaseId, 'funding_confirmed', yuan('30'), {
    reason: 'receipt_fixed', receiptId,
  });
  let totals = balanced(book);
  assert.equal(totals.cashCents, -yuan('10'));
  assert.equal(totals.pendingFundingCents, yuan('20'));
  assert.throws(() => voidEntry(book, receiptId), /关联|核实|先作废|入账/);
  assert.throws(
    () => resolveFunding(book, expenseId, 'funding_confirmed', yuan('11'), { reason: 'receipt_fixed', receiptId }),
    /超过|重复|金额|入账/,
  );
  book = resolveFunding(book, expenseId, 'funding_confirmed', yuan('10'), {
    reason: 'receipt_fixed', receiptId,
  });
  totals = balanced(book);
  assert.equal(totals.pendingFundingCents, yuan('10'));
  assert.equal(totals.cashCents, -yuan('10'));
});

test('a receipt already counted before the shortfall cannot be used to explain that shortfall', () => {
  let book = add(emptyBook(), 'deposit', '10', { person: 'me' });
  const earlierReceiptId = book.entries.at(-1).id;
  book = add(book, 'purchase', '20', { source: 'treasury' });
  const purchaseId = book.entries.at(-1).id;
  book = add(book, 'deposit', '10', { person: 'partner' });
  assert.throws(
    () => resolveFunding(book, purchaseId, 'funding_confirmed', yuan('10'), {
      reason: 'receipt_fixed', receiptId: earlierReceiptId,
    }),
    /早于|已计入|先于|补录|关联|入账/,
  );
});

test('voiding a funding correction reopens review; an origin with live corrections cannot be voided', () => {
  let book = add(emptyBook(), 'purchase', '20', { source: 'treasury' });
  const purchaseId = book.entries.at(-1).id;
  book = resolveFunding(book, purchaseId, 'funding_to_person', yuan('20'), { person: 'me' });
  const correctionId = book.entries.at(-1).id;
  assert.throws(() => voidEntry(book, purchaseId), /处理|关联|先作废|更正|待核实/);
  book = voidEntry(book, correctionId);
  let totals = balanced(book);
  assert.equal(totals.cashCents, -yuan('20'));
  assert.equal(totals.payableCents.me, 0);
  assert.equal(totals.pendingFundingCents, yuan('20'));
  assert.equal(totals.pendingFundingCount, 1);
  book = voidEntry(book, purchaseId);
  totals = balanced(book);
  assert.equal(totals.pendingFundingCents, 0);
  assert.equal(totals.inventoryCents, 0);
  assert.equal(totals.cashCents, 0);
});

test('direct supplier credit is a liability, not treasury cash or partner capital', () => {
  let book = add(emptyBook(), 'purchase', '60', { source: 'supplier_credit', creditor: '批发商 A' });
  let totals = balanced(book);
  assert.equal(totals.cashCents, 0);
  assert.equal(totals.inventoryCents, yuan('60'));
  assert.equal(totals.supplierPayableCents, yuan('60'));
  assert.equal(totals.pendingFundingCents, 0);
  assert.deepEqual(totals.payableCents, { me: 0, partner: 0 });

  book = add(book, 'expense', '10', { source: 'supplier_credit', creditor: '场地商 B' });
  totals = balanced(book);
  assert.equal(totals.supplierPayableCents, yuan('70'));
  assert.equal(totals.profitCents, -yuan('10'));
});

test('supplier repayment can be split between treasury and a partner without changing profit', () => {
  let book = add(emptyBook(), 'purchase', '50', { source: 'supplier_credit', creditor: '进货商' });
  const creditId = book.entries.at(-1).id;
  book = add(book, 'deposit', '30', { person: 'me' });
  book = add(book, 'supplier_payment', '20', { creditId, source: 'treasury' });
  let totals = balanced(book);
  assert.equal(totals.cashCents, yuan('10'));
  assert.equal(totals.supplierPayableCents, yuan('30'));
  assert.equal(totals.profitCents, 0);

  book = add(book, 'supplier_payment', '30', { creditId, source: 'partner' });
  totals = balanced(book);
  assert.equal(totals.cashCents, yuan('10'));
  assert.equal(totals.supplierPayableCents, 0);
  assert.equal(totals.payableCents.partner, yuan('30'));
  assert.equal(totals.profitCents, 0);
  assert.throws(() => add(book, 'supplier_payment', '1', { creditId, source: 'treasury' }), /超过|应付|赊账|已结清/);
});

test('a reclassified supplier shortfall links repayment to the correction record', () => {
  let book = add(emptyBook(), 'purchase', '50', { source: 'treasury' });
  const purchaseId = book.entries.at(-1).id;
  book = resolveFunding(book, purchaseId, 'funding_to_supplier', yuan('50'), { creditor: '批发商' });
  const creditId = book.entries.at(-1).id;
  book = add(book, 'deposit', '50', { person: 'partner' });
  book = add(book, 'supplier_payment', '50', { creditId, source: 'treasury' });
  const totals = balanced(book);
  assert.equal(totals.cashCents, 0);
  assert.equal(totals.supplierPayableCents, 0);
  assert.equal(totals.pendingFundingCents, 0);
  assert.throws(() => voidEntry(book, creditId), /结清|付款|关联|先作废/);
});

test('a supplier payment from an empty treasury also opens a review instead of losing the shortfall', () => {
  let book = add(emptyBook(), 'purchase', '30', { source: 'supplier_credit', creditor: '批发商' });
  const creditId = book.entries.at(-1).id;
  book = add(book, 'supplier_payment', '30', { creditId, source: 'treasury' });
  const paymentId = book.entries.at(-1).id;
  let totals = balanced(book);
  assert.equal(book.entries.at(-1).fundingReviewCents, yuan('30'));
  assert.equal(totals.cashCents, -yuan('30'));
  assert.equal(totals.supplierPayableCents, 0);
  assert.equal(totals.pendingFundingCents, yuan('30'));

  book = resolveFunding(book, paymentId, 'funding_to_person', yuan('30'), { person: 'me' });
  totals = balanced(book);
  assert.equal(totals.cashCents, 0);
  assert.equal(totals.pendingFundingCents, 0);
  assert.equal(totals.payableCents.me, yuan('30'));
});

test('import rejects invented, overpaid, or orphan supplier and funding records', () => {
  let book = add(emptyBook(), 'purchase', '20', { source: 'treasury' });
  const purchaseId = book.entries.at(-1).id;
  assert.throws(
    () => resolveFunding(book, 'missing', 'funding_to_person', yuan('5'), { person: 'me' }),
    /原始|进货|支出|对应|找不到|待核实/,
  );
  assert.throws(
    () => resolveFunding(book, purchaseId, 'funding_to_person', yuan('21'), { person: 'me' }),
    /超过|待核|金额/,
  );

  const orphan = structuredClone(book);
  orphan.entries.push(newEntry('supplier_payment', yuan('1'), { creditId: 'missing', source: 'me' }));
  assert.throws(() => assertBook(orphan), /对应|赊账|付款|找不到/);

  let supplierBook = add(emptyBook(), 'purchase', '20', { source: 'supplier_credit', creditor: 'A' });
  const creditId = supplierBook.entries.at(-1).id;
  supplierBook = add(supplierBook, 'supplier_payment', '10', { creditId, source: 'me' });
  const overpaid = structuredClone(supplierBook);
  overpaid.entries.push(newEntry('supplier_payment', yuan('11'), { creditId, source: 'partner' }));
  assert.throws(() => assertBook(overpaid), /超过|应付|赊账|付款/);
});

test('import cannot hide a historical shortfall by removing or shrinking its review marker', () => {
  let book = add(emptyBook(), 'purchase', '50', { source: 'treasury' });
  book = add(book, 'deposit', '50', { person: 'me' });
  assert.equal(balanced(book).cashCents, 0);
  assert.equal(balanced(book).pendingFundingCents, yuan('50'));

  const omitted = structuredClone(book);
  delete omitted.entries[0].fundingReviewCents;
  assert.throws(() => assertBook(omitted), /待核实|透支|金额|缺口/);

  const understated = structuredClone(book);
  understated.entries[0].fundingReviewCents = yuan('1');
  assert.throws(() => assertBook(understated), /待核实|透支|金额|缺口/);
});

test('outflows unrelated to purchasing still require real available treasury money', () => {
  let book = add(emptyBook(), 'purchase', '20', { source: 'me' });
  assert.throws(() => add(book, 'reimbursement', '20', { person: 'me' }), /余额|金库|透支/);
  book = add(book, 'deposit', '5', { person: 'me' });
  assert.throws(() => add(book, 'return_capital', '6', { person: 'me' }), /余额|金库|透支|出资/);
  assert.equal(balanced(book).cashCents, yuan('5'));
});
