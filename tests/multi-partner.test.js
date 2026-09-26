import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BOOK_VERSION, STORAGE_KEY, addEntries, assertBook, emptyBook, fundingPlan,
  getPeople, newEntry, normalizeLegacyFundingReviews, personHasHistory,
  resolveFunding, summarize, updateSettings, voidEntry,
} from '../ledger.js';

const roster = count => Object.fromEntries(Array.from({ length: count }, (_, index) => [
  ['me', 'partner'][index] ?? `person_${index + 1}`, `合伙人${index + 1}`,
]));
const bookWith = count => updateSettings(emptyBook(), { names: roster(count) });
const add = (book, kind, cents, options = {}) => addEntries(book, [newEntry(kind, cents, options)]);
const totalsFor = book => summarize(book.entries, getPeople(book));
const sum = values => Object.values(values).reduce((total, value) => total + value, 0);
const checkBalance = book => {
  assertBook(book);
  const totals = totalsFor(book);
  assert.equal(totals.cashCents + totals.inventoryCents + sum(totals.receivableCents),
    sum(totals.capitalCents) + sum(totals.payableCents) + totals.supplierPayableCents + totals.profitCents);
  return totals;
};

test('multi-partner books use isolated storage and an incompatible format version', () => {
  assert.equal(STORAGE_KEY, 'erjie-vault-multi-ledger-v2');
  assert.notEqual(STORAGE_KEY, 'erjie-vault-ledger-v1');
  assert.equal(BOOK_VERSION, 2);
  assert.equal(emptyBook().version, 2);
  assert.deepEqual(getPeople(emptyBook()), ['me', 'partner']);
});

test('one, three, four and many partners each have independent accounting buckets', () => {
  for (const count of [1, 3, 4, 15]) {
    let book = bookWith(count);
    for (const [index, person] of getPeople(book).entries()) {
      book = add(book, 'deposit', (index + 1) * 100, { person });
      book = add(book, 'expense', index + 1, { source: person });
    }
    const totals = checkBalance(book);
    assert.equal(Object.keys(totals.capitalCents).length, count);
    assert.equal(totals.cashCents, count * (count + 1) / 2 * 100);
    assert.equal(sum(totals.payableCents), count * (count + 1) / 2);
    assert.equal(totals.profitCents, -sum(totals.payableCents));
  }
});

test('new members start at zero and funding catches each person up to the highest capital', () => {
  let book = add(bookWith(3), 'deposit', 10000, { person: 'me' });
  book = add(book, 'deposit', 5000, { person: 'partner' });
  book = updateSettings(book, { plannedPurchaseCents: 40000 });
  const plan = fundingPlan(book);
  assert.deepEqual(plan.equalizeByPersonCents, { me: 0, partner: 5000, person_3: 10000 });
  assert.equal(plan.equalizeCents, 15000);
  assert.equal(plan.lower, null);
  assert.equal(plan.sharedTopUpCents, 3334);
  assert.deepEqual(plan.dueCents, { me: 3334, partner: 8334, person_3: 13334 });
  for (const person of getPeople(book)) book = add(book, 'deposit', plan.dueCents[person], { person });
  const totals = checkBalance(book);
  assert.deepEqual(totals.capitalCents, { me: 13334, partner: 13334, person_3: 13334 });
  assert.equal(totals.cashCents, 40002);
  assert.equal(sum(fundingPlan(book).dueCents), 0);

  book = updateSettings(book, { names: roster(4) });
  assert.equal(totalsFor(book).capitalCents.person_4, 0);
  assert.equal(fundingPlan(book).dueCents.person_4, 13334);
});

test('one-cent funding gaps round equally, exceeding the target by at most headcount minus one cents', () => {
  for (const count of [1, 3, 4, 15]) {
    const book = updateSettings(bookWith(count), { plannedPurchaseCents: 1 });
    const plan = fundingPlan(book);
    assert.equal(plan.sharedTopUpCents, 1);
    assert.equal(sum(plan.dueCents), count);
    assert.equal(sum(plan.dueCents) - plan.cashGapCents, count - 1);
  }
});

test('multi-partner funding includes reimbursements and supplier debts after transferring collected receipts', () => {
  let book = add(bookWith(4), 'purchase', 8000, { source: 'person_3' });
  book = add(book, 'purchase', 4000, { source: 'supplier_credit', creditor: '批发商' });
  book = add(book, 'sale', 6000, { source: 'person_4', costCents: 3000 });
  book = updateSettings(book, { plannedPurchaseCents: 7000, reserveCents: 1000 });
  const plan = fundingPlan(book);
  assert.equal(plan.payableTotalCents, 8000);
  assert.equal(plan.supplierPayableCents, 4000);
  assert.equal(plan.receivableTotalCents, 6000);
  assert.equal(plan.targetCents, 20000);
  assert.equal(plan.suggestedTransferCents, 6000);
  assert.equal(plan.sharedTopUpCents, 3500);
  assert.deepEqual(plan.dueCents, { me: 3500, partner: 3500, person_3: 3500, person_4: 3500 });
  checkBalance(book);
});

test('third-party advances, reimbursement, collected sales, transfers and capital conversion balance', () => {
  let book = add(bookWith(3), 'purchase', 9000, { source: 'person_3' });
  book = add(book, 'sale', 5000, { source: 'person_3', costCents: 2000 });
  book = add(book, 'sale_transfer', 5000, { person: 'person_3' });
  book = add(book, 'reimbursement', 3000, { person: 'person_3' });
  book = add(book, 'convert_advance', 4000, { person: 'person_3' });
  let totals = checkBalance(book);
  assert.equal(totals.capitalCents.person_3, 4000);
  assert.equal(totals.payableCents.person_3, 2000);
  assert.equal(totals.receivableCents.person_3, 0);
  assert.equal(totals.reimbursedCents.person_3, 3000);
  assert.equal(totals.convertedAdvanceCents.person_3, 4000);
  assert.equal(totals.personalAdvanceCents.person_3, 9000);
  assert.equal(totals.profitCents, 3000);
  book = add(book, 'return_capital', 1000, { person: 'person_3' });
  totals = checkBalance(book);
  assert.equal(totals.capitalCents.person_3, 3000);
  assert.equal(totals.cashCents, 1000);
});

test('supplier refunds follow the third partner who paid and refunded advances cannot be reimbursed twice', () => {
  let book = add(bookWith(3), 'purchase', 10000, { source: 'supplier_credit', creditor: '供货商' });
  const creditId = book.entries.at(-1).id;
  book = add(book, 'supplier_payment', 7000, { source: 'person_3', creditId });
  book = add(book, 'purchase_refund', 2000, { source: 'person_3', creditId, refundDisposition: 'advance_offset' });
  book = add(book, 'purchase_refund', 1000, { source: 'supplier_credit', creditId });
  assert.throws(() => add(book, 'purchase_refund', 100, { source: 'partner', creditId }), /超过该账户/);
  book = add(book, 'deposit', 5000, { person: 'me' });
  book = add(book, 'reimbursement', 5000, { person: 'person_3' });
  book = add(book, 'purchase_refund', 1000, { source: 'person_3', creditId, refundDisposition: 'person_receivable' });
  book = add(book, 'sale_transfer', 1000, { person: 'person_3' });
  const totals = checkBalance(book);
  assert.equal(totals.inventoryCents, 6000);
  assert.equal(totals.payableCents.person_3, 0);
  assert.equal(totals.supplierPayableCents, 2000);
  assert.equal(totals.cashCents, 1000);
});

test('treasury overdrafts can be reclassified to a third partner without changing operating results', () => {
  let book = add(bookWith(3), 'purchase', 5000, { source: 'treasury' });
  const originId = book.entries.at(-1).id;
  book = resolveFunding(book, originId, 'funding_to_person', 5000, { person: 'person_3' });
  book = add(book, 'purchase_refund', 1000, { source: 'person_3', refundDisposition: 'advance_offset' });
  const totals = checkBalance(book);
  assert.equal(totals.cashCents, 0);
  assert.equal(totals.pendingFundingCents, 0);
  assert.equal(totals.payableCents.person_3, 4000);
  assert.equal(totals.inventoryCents, 4000);
  assert.equal(totals.profitCents, 0);
});

test('reclassifying an overdrawn supplier repayment also moves the refundable payment to the third partner', () => {
  let book = add(bookWith(3), 'purchase', 5000, { source: 'supplier_credit', creditor: '批发商' });
  const creditId = book.entries.at(-1).id;
  book = add(book, 'supplier_payment', 5000, { source: 'treasury', creditId });
  const paymentId = book.entries.at(-1).id;
  book = resolveFunding(book, paymentId, 'funding_to_person', 5000, { person: 'person_3' });
  book = add(book, 'purchase_refund', 2000, { source: 'person_3', creditId, refundDisposition: 'advance_offset' });
  assert.throws(() => add(book, 'purchase_refund', 100, { source: 'treasury', creditId }), /超过该账户/);
  const totals = checkBalance(book);
  assert.equal(totals.cashCents, 0);
  assert.equal(totals.supplierPayableCents, 0);
  assert.equal(totals.payableCents.person_3, 3000);
  assert.equal(totals.inventoryCents, 3000);
});

test('renaming preserves stable IDs and all recorded people including voided history cannot be deleted', () => {
  let book = add(bookWith(3), 'deposit', 1000, { person: 'person_3' });
  book = updateSettings(book, { names: { ...book.settings.names, person_3: '小林' } });
  assert.equal(totalsFor(book).capitalCents.person_3, 1000);
  assert.equal(book.entries[0].person, 'person_3');
  assert.equal(personHasHistory(book, 'person_3'), true);
  assert.throws(() => updateSettings(book, { names: roster(2) }), /历史.*不能删除/);
  book = voidEntry(book, book.entries[0].id);
  assert.equal(totalsFor(book).capitalCents.person_3, 0);
  assert.throws(() => updateSettings(book, { names: roster(2) }), /历史.*不能删除/);
  assert.throws(() => updateSettings(book, { names: { ...roster(2), person_replacement: '小林' } }), /历史.*不能删除/);
  assert.equal(getPeople(updateSettings(bookWith(3), { names: roster(1) })).length, 1);

  const payerBook = add(bookWith(3), 'expense', 100, { source: 'person_3' });
  assert.equal(personHasHistory(payerBook, 'person_3'), true);
  assert.throws(() => updateSettings(payerBook, { names: roster(2) }), /历史.*不能删除/);
});

test('empty rosters, ambiguous names, dangerous IDs and unknown references are rejected', () => {
  for (const names of [{}, { me: '' }, { me: '   ' }, { me: '字'.repeat(21) }, { me: '小林', partner: ' 小林 ' }]) {
    assert.throws(() => updateSettings(emptyBook(), { names }), /合伙人/);
  }
  for (const id of ['treasury', 'supplier_credit', '__proto__', 'prototype', 'constructor', 'toString', 'person.3']) {
    assert.throws(() => updateSettings(emptyBook(), { names: Object.fromEntries([[id, '小林']]) }), /合伙人/);
  }
  for (const [kind, options] of [['deposit', { person: 'person_unknown' }], ['purchase', { source: 'person_unknown' }], ['sale', { source: 'person_unknown' }]]) {
    assert.throws(() => add(bookWith(3), kind, 100, options), /合伙人|来源/);
  }
  const unknown = newEntry('deposit', 100, { person: 'person_unknown' });
  const badBook = bookWith(3);
  badBook.entries.push({ ...unknown, voidedAt: new Date().toISOString() });
  assert.throws(() => assertBook(badBook), /合伙人/);
  assert.throws(() => summarize([unknown], getPeople(bookWith(3))), /合伙人/);
  assert.throws(() => summarize([], ['me', 'me']), /合伙人/);
});

test('v1 backups migrate only through explicit normalization without changing old IDs or money', () => {
  const oldBook = JSON.parse(readFileSync(new URL('./empty-book.json', import.meta.url), 'utf8'));
  oldBook.entries = [newEntry('deposit', 10000, { person: 'partner' }), newEntry('purchase', 3000, { source: 'treasury' })];
  assert.throws(() => assertBook(oldBook), /版本不匹配/);
  const migrated = normalizeLegacyFundingReviews(oldBook);
  assert.equal(migrated.partnerStructureChanged, true);
  assert.equal(migrated.fundingReviewsChanged, false);
  assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.renamedLegacyPeople, []);
  assert.equal(migrated.book.version, 2);
  assert.deepEqual(migrated.book.entries, oldBook.entries);
  assert.deepEqual(migrated.book.settings.names, oldBook.settings.names);
  assert.equal(oldBook.version, 1);
  assert.equal(checkBalance(migrated.book).cashCents, 7000);
  assert.equal(normalizeLegacyFundingReviews(migrated.book).changed, false);
  const legacyGap = { ...emptyBook(), version: 1, entries: [newEntry('purchase', 1000, { source: 'treasury' })] };
  const both = normalizeLegacyFundingReviews(legacyGap);
  assert.equal(both.partnerStructureChanged, true);
  assert.equal(both.fundingReviewsChanged, true);
  assert.equal(both.book.entries[0].fundingReviewCents, 1000);
  assert.equal(legacyGap.entries[0].fundingReviewCents, undefined);
  assert.throws(() => normalizeLegacyFundingReviews({ ...bookWith(3), version: 1 }), /旧版.*名单/);
  assert.throws(() => normalizeLegacyFundingReviews({ ...emptyBook(), version: 999 }), /版本不匹配/);
});

test('duplicate legacy names gain bounded suffixes without changing IDs or transaction ownership', () => {
  for (const name of ['小林', '林'.repeat(20), '🌸'.repeat(20)]) {
    const oldBook = { ...emptyBook(), version: 1 };
    oldBook.settings.names = { me: name, partner: ` ${name} ` };
    oldBook.entries = [newEntry('deposit', 1000, { person: 'partner' })];
    const migrated = normalizeLegacyFundingReviews(oldBook);
    assert.deepEqual(migrated.renamedLegacyPeople, ['partner']);
    assert.equal(migrated.book.settings.names.me, name);
    assert.match(migrated.book.settings.names.partner, /（2）$/);
    assert.ok([...migrated.book.settings.names.partner].length <= 20);
    assert.deepEqual(migrated.book.entries, oldBook.entries);
    assert.equal(totalsFor(migrated.book).capitalCents.partner, 1000);
    assert.deepEqual(normalizeLegacyFundingReviews(migrated.book).renamedLegacyPeople, []);
    assert.throws(() => normalizeLegacyFundingReviews({ ...oldBook, version: 2 }), /称呼不能重复/);
  }
});
