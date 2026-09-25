import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addEntries,
  assertBook,
  assertCurrentRevision,
  emptyBook,
  fundingPlan,
  newEntry,
  parseYuan,
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
  assert.throws(() => add(book, 'purchase', '1', { source: 'treasury' }), /余额不能小于零/);
  book = add(book, 'sale_transfer', '50', { person: 'partner' });
  totals = summarize(book.entries);
  assert.equal(totals.cashCents, 5000);
  assert.equal(totals.receivableCents.partner, 3000);
  assert.throws(() => add(book, 'sale_transfer', '31', { person: 'partner' }), /不能超过该人的待转入销售款/);
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

test('cannot over-reimburse, over-return capital, or spend unrecorded cash', () => {
  assert.throws(() => add(emptyBook(), 'purchase', '1', { source: 'treasury' }), /余额不能小于零/);
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
  assert.throws(() => voidEntry(book, depositId), /余额不能小于零/);
  book = voidEntry(book, book.entries[1].id);
  assert.equal(book.entries.length, 2);
  assert.ok(book.entries[1].voidedAt);
  assert.equal(summarize(book.entries).cashCents, 10000);
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
