import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addEntries,
  assertBook,
  assertCurrentRevision,
  emptyBook,
  fundingPlan,
  newEntry,
  normalizeLegacyFundingReviews,
  parseYuan,
  resolveFunding,
  summarize,
  updateSettings,
  voidEntry,
} from '../ledger.js';

const add = (book, kind, yuan, options = {}) => addEntries(book, [newEntry(kind, parseYuan(yuan), options)]);

test('opposite partner deposit is not silently matched', () => {
  let book = add(emptyBook(), 'deposit', '100', { person: 'partner' });
  assert.equal(summarize(book.entries).cashCents, 10000);
  assert.deepEqual(fundingPlan(book).dueCents, { me: 10000, partner: 0 });
  book = add(book, 'deposit', '100', { person: 'me' });
  assert.equal(summarize(book.entries).cashCents, 20000);
  assert.deepEqual(fundingPlan(book).dueCents, { me: 0, partner: 0 });
});

test('purchase spends cash but does not change capital or mean a realized loss', () => {
  let book = add(emptyBook(), 'deposit', '100', { person: 'partner' });
  book = add(book, 'deposit', '100', { person: 'me' });
  book = add(book, 'purchase', '150', { source: 'treasury' });
  const totals = summarize(book.entries);
  assert.equal(totals.cashCents, 5000);
  assert.equal(totals.purchaseCents, 15000);
  assert.deepEqual(totals.capitalCents, { me: 10000, partner: 10000 });
});

test('personally collected sales are not spendable until transferred to treasury', () => {
  let book = add(emptyBook(), 'sale', '80', { source: 'partner' });
  let totals = summarize(book.entries);
  assert.equal(totals.cashCents, 0);
  assert.equal(totals.salesCents, 8000);
  assert.equal(totals.receivableCents.partner, 8000);
  const untransferredPurchase = add(book, 'purchase', '1', { source: 'treasury' });
  assert.equal(summarize(untransferredPurchase.entries).cashCents, -100);
  assert.equal(summarize(untransferredPurchase.entries).pendingFundingCents, 100);
  book = add(book, 'sale_transfer', '50', { person: 'partner' });
  totals = summarize(book.entries);
  assert.equal(totals.cashCents, 5000);
  assert.equal(totals.receivableCents.partner, 3000);
  assert.throws(() => add(book, 'sale_transfer', '31', { person: 'partner' }), /不能超过该人的待转入款/);
});

test('existing v1 sales without a source remain recorded as treasury receipts', () => {
  const book = add(emptyBook(), 'sale', '20');
  assertBook(JSON.parse(JSON.stringify(book)));
  assert.equal(summarize(book.entries).cashCents, 2000);
});

test('an older tab may not overwrite a newer ledger revision', () => {
  const openedInTabB = emptyBook();
  const writtenByTabA = { ...openedInTabB, revision: 1 };
  assert.throws(() => assertCurrentRevision(writtenByTabA, openedInTabB), /另一标签页已更新/);
  assert.doesNotThrow(() => assertCurrentRevision(writtenByTabA, { ...openedInTabB, revision: 1 }));
  assert.doesNotThrow(() => assertCurrentRevision({ ...openedInTabB, revision: undefined }, openedInTabB));
});

test('funding advice asks to transfer collected sales before new contributions', () => {
  let book = add(emptyBook(), 'deposit', '100', { person: 'me' });
  book = add(book, 'deposit', '100', { person: 'partner' });
  book = add(book, 'purchase', '200', { source: 'treasury' });
  book = add(book, 'sale', '100', { source: 'partner' });
  book = updateSettings(book, { plannedPurchaseCents: 8000 });
  const plan = fundingPlan(book);
  assert.equal(plan.cashGapCents, 8000);
  assert.equal(plan.suggestedTransferCents, 8000);
  assert.deepEqual(plan.dueCents, { me: 0, partner: 0 });
  assert.equal(summarize(book.entries).cashCents, 0);
});

test('planned purchase, reserve, payables and 50/50 catch-up are funded separately', () => {
  let book = add(emptyBook(), 'deposit', '100', { person: 'partner' });
  book = updateSettings(book, { plannedPurchaseCents: 20000, reserveCents: 5000 });
  const plan = fundingPlan(book);
  assert.equal(plan.cashGapCents, 15000);
  assert.equal(plan.equalizeCents, 10000);
  assert.deepEqual(plan.dueCents, { me: 12500, partner: 2500 });
  assert.equal(10000 + plan.dueCents.me + plan.dueCents.partner, 25000);
});

test('personal purchase makes a payable without changing cash or equity', () => {
  let book = add(emptyBook(), 'deposit', '100', { person: 'partner' });
  book = add(book, 'deposit', '100', { person: 'me' });
  book = add(book, 'purchase', '120', { source: 'partner' });
  const totals = summarize(book.entries);
  assert.equal(totals.cashCents, 20000);
  assert.deepEqual(totals.capitalCents, { me: 10000, partner: 10000 });
  assert.deepEqual(totals.payableCents, { me: 0, partner: 12000 });
  assert.equal(fundingPlan(book).targetCents, 12000);
});

test('supplier credit appears in the future funding target without inflating partner deposits', () => {
  const book = add(emptyBook(), 'purchase', '40', { source: 'supplier_credit', creditor: '挂件供货商' });
  const plan = fundingPlan(book);
  assert.equal(plan.supplierPayableCents, 4000);
  assert.equal(plan.targetCents, 4000);
  assert.equal(plan.cashGapCents, 4000);
  assert.deepEqual(summarize(book.entries).capitalCents, { me: 0, partner: 0 });
});

test('a returned supplier-credit purchase refunds cash after repayment or offsets unpaid debt', () => {
  let book = add(emptyBook(), 'purchase', '100', { source: 'supplier_credit', creditor: '挂件供货商' });
  const creditId = book.entries.at(-1).id;
  book = add(book, 'deposit', '60', { person: 'me' });
  book = add(book, 'supplier_payment', '60', { source: 'treasury', creditId });
  book = add(book, 'purchase_refund', '20', { source: 'treasury', creditId });
  book = add(book, 'purchase_refund', '10', { source: 'supplier_credit', creditId });
  const totals = summarize(book.entries);
  assert.equal(totals.cashCents, 2000);
  assert.equal(totals.inventoryCents, 7000);
  assert.equal(totals.supplierPayableCents, 3000);
  assert.equal(totals.profitCents, 0);
  assert.throws(() => add(book, 'purchase_refund', '41', { source: 'treasury', creditId }), /超过|退货|已偿还/);
  assert.throws(() => add(book, 'purchase_refund', '31', { source: 'supplier_credit', creditId }), /超过|剩余欠款/);
});

test('a supplier refund received by a reimbursed partner becomes money due back to treasury', () => {
  let book = add(emptyBook(), 'purchase', '100', { source: 'supplier_credit', creditor: '供货商' });
  const creditId = book.entries.at(-1).id;
  book = add(book, 'supplier_payment', '100', { source: 'me', creditId });
  book = add(book, 'deposit', '100', { person: 'partner' });
  book = add(book, 'reimbursement', '100', { person: 'me' });
  book = add(book, 'purchase_refund', '30', { source: 'me', creditId, refundDisposition: 'person_receivable' });
  let totals = summarize(book.entries);
  assert.equal(totals.payableCents.me, 0);
  assert.equal(totals.receivableCents.me, 3000);
  assert.equal(totals.inventoryCents, 7000);
  book = add(book, 'sale_transfer', '30', { person: 'me' });
  totals = summarize(book.entries);
  assert.equal(totals.cashCents, 3000);
  assert.equal(totals.receivableCents.me, 0);
  assert.equal(totals.profitCents, 0);
});

test('a personal refund explicitly chooses between offsetting an advance and money to transfer', () => {
  let book = add(emptyBook(), 'purchase', '100', { source: 'me' });
  book = add(book, 'purchase_refund', '20', { source: 'me', refundDisposition: 'advance_offset' });
  assert.equal(summarize(book.entries).payableCents.me, 8000);
  assert.equal(summarize(book.entries).receivableCents.me, 0);
  book = add(book, 'purchase_refund', '10', { source: 'me', refundDisposition: 'person_receivable' });
  assert.equal(summarize(book.entries).payableCents.me, 8000);
  assert.equal(summarize(book.entries).receivableCents.me, 1000);
});

test('partial reimbursement only uses available treasury cash', () => {
  let book = add(emptyBook(), 'deposit', '50', { person: 'me' });
  book = add(book, 'purchase', '120', { source: 'partner' });
  assert.throws(() => add(book, 'reimbursement', '120', { person: 'partner' }), /余额不能小于零/);
  book = add(book, 'reimbursement', '50', { person: 'partner' });
  assert.equal(summarize(book.entries).cashCents, 0);
  assert.equal(summarize(book.entries).payableCents.partner, 7000);
  assert.throws(() => add(book, 'reimbursement', '1', { person: 'partner' }), /余额不能小于零/);
});

test('conversion uses payable once and cannot also be reimbursed', () => {
  let book = add(emptyBook(), 'deposit', '10', { person: 'me' });
  book = add(book, 'purchase', '120', { source: 'partner' });
  book = add(book, 'convert_advance', '120', { person: 'partner' });
  assert.equal(summarize(book.entries).cashCents, 1000);
  assert.equal(summarize(book.entries).capitalCents.partner, 12000);
  assert.equal(summarize(book.entries).payableCents.partner, 0);
  assert.throws(() => add(book, 'reimbursement', '1', { person: 'partner' }), /不能超过该人的待报销金额/);
});

test('unrecorded treasury purchase becomes a review, while reimbursement and capital returns still need cash', () => {
  const unrecordedPurchase = add(emptyBook(), 'purchase', '1', { source: 'treasury' });
  assert.equal(summarize(unrecordedPurchase.entries).cashCents, -100);
  assert.equal(summarize(unrecordedPurchase.entries).pendingFundingCents, 100);
  assert.throws(() => add(emptyBook(), 'return_capital', '1', { person: 'me' }), /余额不能小于零/);
  let book = add(emptyBook(), 'deposit', '100', { person: 'me' });
  assert.throws(() => add(book, 'return_capital', '101', { person: 'me' }), /余额不能小于零/);
  book = add(book, 'deposit', '100', { person: 'partner' });
  assert.throws(() => add(book, 'return_capital', '101', { person: 'me' }), /不能超过该人累计净出资/);
});

test('voided entries stay visible in history and cannot destroy book balance', () => {
  let book = add(emptyBook(), 'deposit', '100', { person: 'me' });
  const depositId = book.entries[0].id;
  book = add(book, 'purchase', '30', { source: 'treasury' });
  assert.throws(() => voidEntry(book, depositId), /余额不能小于零|新的缺口/);
  book = voidEntry(book, book.entries[1].id);
  assert.equal(book.entries.length, 2);
  assert.ok(book.entries[1].voidedAt);
  assert.equal(summarize(book.entries).cashCents, 10000);
});

test('a voided receipt is excluded from a later purchase even within the same millisecond', () => {
  let book = add(emptyBook(), 'deposit', '10', { person: 'me' });
  book = voidEntry(book, book.entries[0].id);
  const purchase = newEntry('purchase', parseYuan('15'), { source: 'treasury' });
  purchase.createdAt = book.entries[0].voidedAt;
  book = addEntries(book, [purchase]);
  assert.equal(book.entries.at(-1).fundingReviewCents, 1500);
  assert.equal(summarize(book.entries).cashCents, -1500);
});

test('older valid books with a later balancing deposit gain a visible review on import', () => {
  const oldBook = emptyBook();
  oldBook.entries.push(newEntry('purchase', 10000, { source: 'treasury' }));
  oldBook.entries.push(newEntry('deposit', 10000, { person: 'me' }));
  assert.throws(() => assertBook(oldBook), /金库透支明细/);
  const normalized = normalizeLegacyFundingReviews(oldBook);
  assert.equal(normalized.changed, true);
  assert.equal(normalized.book.entries[0].fundingReviewCents, 10000);
  assert.equal(summarize(normalized.book.entries).pendingFundingCents, 10000);
  assert.equal(summarize(normalized.book.entries).cashCents, 0);
  assert.equal(normalizeLegacyFundingReviews(normalized.book).changed, false);
});

test('voiding an earlier deposit cannot hide a new shortfall behind an old confirmed overdraft', () => {
  let book = add(emptyBook(), 'purchase', '100', { source: 'treasury' });
  book = resolveFunding(book, book.entries[0].id, 'funding_confirmed', 10000, { reason: 'true_overdraft' });
  book = add(book, 'deposit', '100', { person: 'me' });
  const firstDepositId = book.entries.at(-1).id;
  book = add(book, 'deposit', '100', { person: 'partner' });
  book = add(book, 'purchase', '100', { source: 'treasury' });
  assert.equal(book.entries.at(-1).fundingReviewCents, undefined);
  assert.throws(() => voidEntry(book, firstDepositId), /新的缺口/);
});

test('import validation rejects damaged and duplicated records', () => {
  const book = add(emptyBook(), 'deposit', '10', { person: 'me' });
  assert.throws(() => assertBook({ ...book, version: 99 }), /版本不匹配/);
  assert.throws(() => assertBook({ ...book, entries: [...book.entries, book.entries[0]] }), /重复记录/);
  const damaged = structuredClone(book);
  damaged.entries[0].amountCents = 10.5;
  assert.throws(() => assertBook(damaged), /金额或日期错误/);
});

test('money parser stores exact integer cents', () => {
  assert.equal(parseYuan('10.01'), 1001);
  assert.equal(parseYuan('0.5'), 50);
  assert.throws(() => parseYuan('0'), /大于 0/);
  assert.throws(() => parseYuan('10.001'), /最多两位小数/);
});
