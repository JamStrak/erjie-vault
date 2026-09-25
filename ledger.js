export const STORAGE_KEY = 'erjie-vault-ledger-v1';
export const BOOK_VERSION = 1;
export const PEOPLE = ['me', 'partner'];

export const ENTRY_LABELS = {
  deposit: '合伙人入金',
  purchase: '进货',
  sale: '销售记录',
  sale_cost: '补录已售成本',
  sale_transfer: '个人代收款转入金库',
  expense: '其他支出',
  other_income: '其他收入',
  purchase_refund: '进货退货退款',
  stock_loss: '货品报损',
  reimbursement: '报销垫付',
  convert_advance: '垫付转出资',
  return_capital: '返还出资',
  funding_to_person: '缺口归类为个人垫付',
  funding_to_supplier: '缺口归类为供应商赊账',
  funding_confirmed: '金库透支已核实',
  supplier_payment: '偿还供应商赊账',
};

const ENTRY_KINDS = new Set(Object.keys(ENTRY_LABELS));
const CASH_SOURCES = new Set(['treasury', ...PEOPLE]);
const PURCHASE_SOURCES = new Set([...CASH_SOURCES, 'supplier_credit']);
const REVIEWABLE_KINDS = new Set(['purchase', 'expense', 'supplier_payment']);
const FUNDING_RESOLUTIONS = new Set(['funding_to_person', 'funding_to_supplier', 'funding_confirmed']);
const MAX_CENTS = 99_999_999_999;

export function emptyBook() {
  return {
    version: BOOK_VERSION,
    revision: 0,
    settings: {
      names: { me: '我', partner: '合伙人' },
      plannedPurchaseCents: 0,
      reserveCents: 0,
    },
    entries: [],
    lastBackupAt: null,
  };
}

export function parseYuan(value) {
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/.test(text)) {
    throw new Error('金额请输入大于 0 的数字，最多两位小数。');
  }
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents === 0) throw new Error('金额须大于 0。');
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) {
    throw new Error('金额超出可记录范围。');
  }
  return cents;
}

export function parseNonnegativeYuan(value) {
  const text = String(value).trim();
  return text === '' || /^0(?:\.0{1,2})?$/.test(text) ? 0 : parseYuan(text);
}

export function money(cents) {
  const value = Math.abs(Number(cents)) / 100;
  return `${cents < 0 ? '−' : ''}¥${new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)}`;
}

export function todayLocal() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function positiveCents(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_CENTS;
}

function nonnegativeCents(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_CENTS;
}

function realDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
}

function assertEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('账本中有损坏的记录。');
  if (typeof entry.id !== 'string' || !entry.id || !ENTRY_KINDS.has(entry.kind)) throw new Error('账本中有无法识别的记录。');
  if (!(entry.kind === 'sale_cost' ? nonnegativeCents(entry.amountCents) : positiveCents(entry.amountCents)) || !realDate(entry.date)) {
    throw new Error('账本中有金额或日期错误的记录。');
  }
  if (typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error('账本中有录入时间错误的记录。');
  if (typeof entry.note !== 'string' || entry.note.length > 160) throw new Error('账本中有备注错误的记录。');
  if (entry.voidedAt !== null && entry.voidedAt !== undefined &&
      (typeof entry.voidedAt !== 'string' || !Number.isFinite(Date.parse(entry.voidedAt)))) {
    throw new Error('账本中有作废状态错误的记录。');
  }
  if (entry.voidedAtEntryCount != null &&
      (!entry.voidedAt || !Number.isSafeInteger(entry.voidedAtEntryCount) || entry.voidedAtEntryCount < 1)) {
    throw new Error('账本中有作废顺序错误的记录。');
  }
  if (['deposit', 'sale_transfer', 'reimbursement', 'convert_advance', 'return_capital'].includes(entry.kind) && !PEOPLE.includes(entry.person)) {
    throw new Error('账本中有合伙人信息错误的记录。');
  }
  if (['purchase', 'expense', 'purchase_refund'].includes(entry.kind) && !PURCHASE_SOURCES.has(entry.source)) {
    throw new Error('账本中有付款来源错误的记录。');
  }
  if (entry.kind === 'supplier_payment' && !CASH_SOURCES.has(entry.source)) {
    throw new Error('赊账还款的付款来源无效。');
  }
  if ((['purchase', 'expense'].includes(entry.kind) && entry.source === 'supplier_credit') || entry.kind === 'funding_to_supplier') {
    if (typeof entry.creditor !== 'string' || !entry.creditor.trim() || entry.creditor.length > 40) {
      throw new Error('请填写供应商名称。');
    }
  }
  if (entry.fundingReviewCents != null &&
      (!REVIEWABLE_KINDS.has(entry.kind) || entry.source !== 'treasury' ||
       !positiveCents(entry.fundingReviewCents) || entry.fundingReviewCents > entry.amountCents)) {
    throw new Error('待核实透支金额无效。');
  }
  if (FUNDING_RESOLUTIONS.has(entry.kind) && (typeof entry.targetId !== 'string' || !entry.targetId)) {
    throw new Error('缺口归类缺少对应支出。');
  }
  if (entry.kind === 'funding_to_person' && !PEOPLE.includes(entry.person)) {
    throw new Error('缺口归类的合伙人无效。');
  }
  if (entry.kind === 'funding_confirmed' && !['true_overdraft', 'receipt_fixed'].includes(entry.reason)) {
    throw new Error('金库透支的核实原因无效。');
  }
  if (entry.kind === 'funding_confirmed' && entry.reason === 'receipt_fixed' &&
      (typeof entry.receiptId !== 'string' || !entry.receiptId)) {
    throw new Error('补录入金核实必须关联一笔实际入账记录。');
  }
  if ((entry.kind === 'supplier_payment' || (entry.kind === 'purchase_refund' && entry.source === 'supplier_credit')) &&
      (typeof entry.creditId !== 'string' || !entry.creditId)) {
    throw new Error('请关联对应的供应商赊账。');
  }
  if (entry.creditId != null &&
      (!['supplier_payment', 'purchase_refund'].includes(entry.kind) || typeof entry.creditId !== 'string' || !entry.creditId)) {
    throw new Error('关联的供应商赊账编号无效。');
  }
  if (entry.refundDisposition != null &&
      (entry.kind !== 'purchase_refund' || !PEOPLE.includes(entry.source) ||
       !['person_receivable', 'advance_offset'].includes(entry.refundDisposition))) {
    throw new Error('个人退款处理方式无效。');
  }
  // Earlier v1 sale records had no source field and meant money already entered the vault.
  if (entry.kind === 'sale' && entry.source != null && !CASH_SOURCES.has(entry.source)) {
    throw new Error('账本中有付款来源错误的记录。');
  }
  if (entry.kind === 'sale' && entry.costCents != null && !nonnegativeCents(entry.costCents)) {
    throw new Error('账本中有已售商品成本错误的记录。');
  }
  if (entry.kind === 'sale_cost' && (typeof entry.saleId !== 'string' || !entry.saleId)) {
    throw new Error('补录成本缺少对应销售。');
  }
}

function historicalCashAtOutflows(entries) {
  const count = entries.length;
  const tree = new Array(count + 1).fill(0);
  const addVoid = (index, delta) => {
    for (let bit = index + 1; bit <= count; bit += bit & -bit) tree[bit] += delta;
  };
  const voidedBefore = index => {
    let total = 0;
    for (let bit = index; bit > 0; bit -= bit & -bit) total += tree[bit];
    return total;
  };
  const prefixCash = [0];
  const voidEvents = [];
  const voidByEntryCount = new Array(count + 1).fill(0);
  for (let index = 0; index < count; index++) {
    const entry = entries[index];
    const delta = entryCashDelta({ ...entry, voidedAt: null });
    prefixCash.push(prefixCash[index] + delta);
    if (entry.voidedAt && entry.voidedAtEntryCount != null) {
      if (entry.voidedAtEntryCount <= index || entry.voidedAtEntryCount > count) {
        throw new Error('账本中有作废顺序错误的记录。');
      }
      voidByEntryCount[entry.voidedAtEntryCount] += delta;
    } else if (entry.voidedAt) voidEvents.push({ index, at: Date.parse(entry.voidedAt), delta });
  }
  for (let index = 1; index <= count; index++) voidByEntryCount[index] += voidByEntryCount[index - 1];
  voidEvents.sort((a, b) => a.at - b.at);
  const queries = entries.map((entry, index) => ({ entry, index, at: Date.parse(entry.createdAt) }))
    .filter(({ entry }) => !entry.voidedAt &&
      ((REVIEWABLE_KINDS.has(entry.kind) && entry.source === 'treasury') ||
       ['reimbursement', 'return_capital'].includes(entry.kind)))
    .sort((a, b) => a.at - b.at);
  const cashByEntryId = new Map();
  let eventIndex = 0;
  for (const { entry, index, at } of queries) {
    while (eventIndex < voidEvents.length && voidEvents[eventIndex].at < at) {
      const event = voidEvents[eventIndex++];
      addVoid(event.index, event.delta);
    }
    cashByEntryId.set(entry.id, prefixCash[index] - voidByEntryCount[index] - voidedBefore(index));
  }
  return cashByEntryId;
}

export function normalizeLegacyFundingReviews(book) {
  if (!book || book.version !== BOOK_VERSION || !Array.isArray(book.entries)) {
    throw new Error('账本文件版本不匹配，不能直接导入。');
  }
  if (book.entries.length > 100_000) throw new Error('账本记录数量无效。');
  const next = structuredClone(book);
  for (const entry of next.entries) assertEntry(entry);
  const cashByEntryId = historicalCashAtOutflows(next.entries);
  let changed = false;
  for (const entry of next.entries) {
    if (entry.voidedAt || !REVIEWABLE_KINDS.has(entry.kind) || entry.source !== 'treasury') continue;
    const cashBefore = cashByEntryId.get(entry.id);
    const shortfall = Math.max(0, -(cashBefore - entry.amountCents)) - Math.max(0, -cashBefore);
    if (shortfall > 0 && entry.fundingReviewCents == null) {
      entry.fundingReviewCents = shortfall;
      changed = true;
    }
  }
  assertBook(next);
  return { book: next, changed };
}

export function assertBook(book) {
  if (!book || typeof book !== 'object' || Array.isArray(book) || book.version !== BOOK_VERSION) {
    throw new Error('账本文件版本不匹配，不能直接导入。');
  }
  if (book.revision !== undefined && (!Number.isSafeInteger(book.revision) || book.revision < 0)) {
    throw new Error('账本修订号无效。');
  }
  if (!book.settings || typeof book.settings !== 'object' || !book.settings.names) throw new Error('账本设置不完整。');
  for (const person of PEOPLE) {
    const name = book.settings.names[person];
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 20) throw new Error('合伙人称呼无效。');
  }
  if (!nonnegativeCents(book.settings.plannedPurchaseCents) || !nonnegativeCents(book.settings.reserveCents)) {
    throw new Error('计划进货或备用金金额无效。');
  }
  if (!Array.isArray(book.entries) || book.entries.length > 100_000) throw new Error('账本记录数量无效。');
  const ids = new Set();
  for (const entry of book.entries) {
    assertEntry(entry);
    if (ids.has(entry.id)) throw new Error('账本中有重复记录。');
    ids.add(entry.id);
  }
  // A later deposit or void must not erase a payment's original review marker.
  const historicalCash = historicalCashAtOutflows(book.entries);
  for (const entry of book.entries) {
    if (!historicalCash.has(entry.id)) continue;
    const historicalCashCents = historicalCash.get(entry.id);
    if (['reimbursement', 'return_capital'].includes(entry.kind)) {
      if (historicalCashCents < entry.amountCents) {
        throw new Error('报销或返还出资时，金库余额不能小于零。');
      }
      continue;
    }
    const shortfall = Math.max(0, -(historicalCashCents - entry.amountCents)) - Math.max(0, -historicalCashCents);
    if ((entry.fundingReviewCents ?? 0) !== shortfall) {
      throw new Error('金库透支明细与原始支出不符，请检查待核实付款记录。');
    }
  }
  // Voiding an earlier receipt can expose a new deficit in a later payment.
  // Never let an older confirmed overdraft silently cover that new shortfall.
  let activeCashCents = 0;
  for (const entry of book.entries) {
    if (entry.voidedAt) continue;
    const delta = entryCashDelta(entry);
    if (REVIEWABLE_KINDS.has(entry.kind) && entry.source === 'treasury') {
      const currentShortfall = Math.max(0, -(activeCashCents + delta)) - Math.max(0, -activeCashCents);
      if (currentShortfall > (entry.fundingReviewCents ?? 0)) {
        throw new Error('更正较早入账后，有后续金库付款出现新的缺口；请先核对并更正后续流水。');
      }
    }
    if (['reimbursement', 'return_capital'].includes(entry.kind) && activeCashCents < entry.amountCents) {
      throw new Error('更正较早入账后，报销或返还出资时金库余额不能小于零。');
    }
    activeCashCents += delta;
  }
  const activeEntries = new Map(book.entries.filter(entry => !entry.voidedAt).map(entry => [entry.id, entry]));
  const entryIndexById = new Map(book.entries.map((entry, index) => [entry.id, index]));
  const activeSales = new Map([...activeEntries].filter(([, entry]) => entry.kind === 'sale'));
  const supplementedSales = new Set();
  const purchasesBySource = { treasury: 0, me: 0, partner: 0, supplier_credit: 0 };
  const refundsBySource = { treasury: 0, me: 0, partner: 0, supplier_credit: 0 };
  const resolvedByTarget = new Map();
  const usedReceipts = new Map();
  const creditEntries = new Map([...activeEntries].filter(([, entry]) =>
    (['purchase', 'expense'].includes(entry.kind) && entry.source === 'supplier_credit') || entry.kind === 'funding_to_supplier'));
  const creditBalances = new Map([...creditEntries].map(([id, entry]) => [id, {
    dueCents: entry.amountCents,
    refundedCents: 0,
    paid: { treasury: 0, me: 0, partner: 0 },
    refundedTo: { treasury: 0, me: 0, partner: 0 },
  }]));
  for (const entry of book.entries) {
    if (entry.voidedAt) continue;
    if (entry.kind === 'purchase') purchasesBySource[entry.source] += entry.amountCents;
    if (entry.kind === 'purchase_refund' && !entry.creditId) refundsBySource[entry.source] += entry.amountCents;
    if (FUNDING_RESOLUTIONS.has(entry.kind)) {
      const target = activeEntries.get(entry.targetId);
      if (!target || !REVIEWABLE_KINDS.has(target.kind) || !target.fundingReviewCents || target.source !== 'treasury') {
        throw new Error('缺口归类必须对应仍有效的待核实金库支出。');
      }
      if (entry.kind === 'funding_to_supplier' && !['purchase', 'expense'].includes(target.kind)) {
        throw new Error('赊账归类只能对应进货或经营支出。');
      }
      resolvedByTarget.set(entry.targetId, (resolvedByTarget.get(entry.targetId) ?? 0) + entry.amountCents);
      if (target.kind === 'purchase' && ['funding_to_person', 'funding_to_supplier'].includes(entry.kind)) {
        purchasesBySource.treasury -= entry.amountCents;
        purchasesBySource[entry.kind === 'funding_to_person' ? entry.person : 'supplier_credit'] += entry.amountCents;
      }
      if (entry.kind === 'funding_confirmed' && entry.reason === 'receipt_fixed') {
        const receipt = activeEntries.get(entry.receiptId);
        if (!receipt || !isActualReceipt(receipt) || entryIndexById.get(receipt.id) <= entryIndexById.get(target.id)) {
          throw new Error('补录入金核实必须关联一笔晚于该笔支出的实际入账记录。');
        }
        usedReceipts.set(receipt.id, (usedReceipts.get(receipt.id) ?? 0) + entry.amountCents);
      }
    }
    if (entry.kind === 'supplier_payment' || (entry.kind === 'purchase_refund' && entry.creditId)) {
      const credit = creditEntries.get(entry.creditId);
      if (!credit) throw new Error('赊账还款或退货必须关联一笔有效的供应商欠款。');
      if (entryIndexById.get(credit.id) >= entryIndexById.get(entry.id)) {
        throw new Error('赊账还款或退货必须晚于对应欠款。');
      }
      const balance = creditBalances.get(credit.id);
      if (entry.kind === 'purchase_refund') {
        const creditIsPurchase = credit.kind === 'purchase' || (credit.kind === 'funding_to_supplier' && activeEntries.get(credit.targetId)?.kind === 'purchase');
        if (!creditIsPurchase) throw new Error('进货退款只能抵减进货形成的供应商赊账。');
        balance.refundedCents += entry.amountCents;
        if (balance.refundedCents > credit.amountCents) throw new Error('退货退款不能超过这笔赊账进货金额。');
        if (entry.source === 'supplier_credit') balance.dueCents -= entry.amountCents;
        else {
          balance.refundedTo[entry.source] += entry.amountCents;
          if (balance.refundedTo[entry.source] > balance.paid[entry.source]) {
            throw new Error('退到金库或个人的钱不能超过该账户已偿还的这笔赊账。');
          }
        }
      } else {
        balance.dueCents -= entry.amountCents;
        balance.paid[entry.source] += entry.amountCents;
      }
      if (balance.dueCents < 0) throw new Error('赊账还款或抵扣不能超过这笔剩余欠款。');
    }
    if (entry.kind !== 'sale_cost' || entry.voidedAt) continue;
    const sale = activeSales.get(entry.saleId);
    if (!sale || sale.costCents != null || supplementedSales.has(entry.saleId)) {
      throw new Error('补录成本必须对应一笔尚未核算成本的有效销售，且只能补录一次。');
    }
    supplementedSales.add(entry.saleId);
  }
  for (const [targetId, resolvedCents] of resolvedByTarget) {
    if (resolvedCents > activeEntries.get(targetId).fundingReviewCents) {
      throw new Error('缺口归类金额不能超过该笔待核实金额。');
    }
  }
  for (const [receiptId, usedCents] of usedReceipts) {
    if (usedCents > entryCashDelta(activeEntries.get(receiptId))) throw new Error('一笔入账不能重复核实超过自身的金额。');
  }
  for (const source of PURCHASE_SOURCES) {
    if (refundsBySource[source] > purchasesBySource[source]) {
      throw new Error('退货退款不能超过相同付款来源的有效进货金额。');
    }
  }
  if (book.lastBackupAt !== null && book.lastBackupAt !== undefined &&
      (typeof book.lastBackupAt !== 'string' || !Number.isFinite(Date.parse(book.lastBackupAt)))) {
    throw new Error('账本备份时间无效。');
  }
  const totals = summarize(book.entries);
  if (totals.cashCents < 0 && -totals.cashCents > totals.pendingFundingCents + totals.confirmedOverdraftCents) {
    throw new Error('金库余额不能小于零，除非透支支出已有对应的待核实或已确认明细。');
  }
  if (totals.inventoryCents < 0) throw new Error('已售、退货或报损的成本不能超过已记录的进货成本，请先补记进货。');
  if (totals.supplierPayableCents < 0) throw new Error('偿还供应商赊账不能超过待付款。');
  for (const person of PEOPLE) {
    if (totals.capitalCents[person] < 0) throw new Error('返还出资不能超过该人累计净出资。');
    if (totals.payableCents[person] < 0) throw new Error('报销或转出资不能超过该人的待报销金额。');
    if (totals.receivableCents[person] < 0) throw new Error('转入金额不能超过该人的待转入款。');
  }
  const assets = totals.cashCents + totals.inventoryCents + totals.receivableCents.me + totals.receivableCents.partner;
  const claims = totals.capitalCents.me + totals.capitalCents.partner + totals.payableCents.me + totals.payableCents.partner + totals.supplierPayableCents + totals.profitCents;
  if (!Number.isSafeInteger(assets) || !Number.isSafeInteger(claims) || assets !== claims) {
    throw new Error('账本资产与出资、垫付和经营盈亏无法对平，请检查记录。');
  }
  return book;
}

export function assertCurrentRevision(storedBook, openedBook) {
  const stored = storedBook?.revision ?? 0;
  const opened = openedBook?.revision ?? 0;
  if (stored !== opened) throw new Error('另一标签页已更新账本；请刷新此页核对后再保存，避免覆盖新记录。');
}

export function fundingCases(entries) {
  const cases = new Map(entries.filter(entry => !entry.voidedAt && entry.fundingReviewCents).map(entry => [entry.id, {
    entry,
    originalCents: entry.fundingReviewCents,
    pendingCents: entry.fundingReviewCents,
    confirmedOverdraftCents: 0,
    receiptFixedCents: 0,
    classifiedCents: 0,
  }]));
  for (const entry of entries) {
    if (entry.voidedAt || !FUNDING_RESOLUTIONS.has(entry.kind)) continue;
    const item = cases.get(entry.targetId);
    if (!item) continue;
    item.pendingCents -= entry.amountCents;
    if (entry.kind === 'funding_confirmed') {
      if (entry.reason === 'true_overdraft') item.confirmedOverdraftCents += entry.amountCents;
      else item.receiptFixedCents += entry.amountCents;
    } else item.classifiedCents += entry.amountCents;
  }
  return [...cases.values()];
}

export function summarize(entries) {
  const result = {
    cashCents: 0,
    capitalCents: { me: 0, partner: 0 },
    payableCents: { me: 0, partner: 0 },
    receivableCents: { me: 0, partner: 0 },
    supplierPayableCents: 0,
    pendingFundingCents: 0,
    pendingFundingCount: 0,
    confirmedOverdraftCents: 0,
    personalAdvanceCents: { me: 0, partner: 0 },
    reimbursedCents: { me: 0, partner: 0 },
    convertedAdvanceCents: { me: 0, partner: 0 },
    depositsCents: 0,
    purchaseCents: 0,
    purchaseRefundCents: 0,
    salesCents: 0,
    soldCostCents: 0,
    inventoryCents: 0,
    stockLossCents: 0,
    expensesCents: 0,
    otherIncomeCents: 0,
    profitCents: 0,
    pendingCostCount: 0,
    activeCount: 0,
  };
  const supplementedSales = new Set(entries.filter(entry => entry.kind === 'sale_cost' && !entry.voidedAt).map(entry => entry.saleId));
  for (const entry of entries) {
    if (entry.voidedAt) continue;
    const amount = entry.amountCents;
    result.activeCount++;
    switch (entry.kind) {
      case 'deposit':
        result.cashCents += amount;
        result.capitalCents[entry.person] += amount;
        result.depositsCents += amount;
        break;
      case 'sale':
        if (entry.source == null || entry.source === 'treasury') result.cashCents += amount;
        else result.receivableCents[entry.source] += amount;
        result.salesCents += amount;
        if (entry.costCents == null) {
          if (!supplementedSales.has(entry.id)) result.pendingCostCount++;
        } else result.soldCostCents += entry.costCents;
        break;
      case 'sale_cost':
        result.soldCostCents += amount;
        break;
      case 'sale_transfer':
        result.receivableCents[entry.person] -= amount;
        result.cashCents += amount;
        break;
      case 'other_income':
        result.cashCents += amount;
        result.otherIncomeCents += amount;
        break;
      case 'purchase':
      case 'expense':
        if (entry.kind === 'purchase') result.purchaseCents += amount;
        else result.expensesCents += amount;
        if (entry.source === 'treasury') result.cashCents -= amount;
        else if (entry.source === 'supplier_credit') result.supplierPayableCents += amount;
        else {
          result.payableCents[entry.source] += amount;
          result.personalAdvanceCents[entry.source] += amount;
        }
        break;
      case 'purchase_refund':
        result.purchaseRefundCents += amount;
        if (entry.source === 'treasury') result.cashCents += amount;
        else if (entry.source === 'supplier_credit') result.supplierPayableCents -= amount;
        else if (entry.refundDisposition === 'person_receivable') result.receivableCents[entry.source] += amount;
        else result.payableCents[entry.source] -= amount;
        break;
      case 'funding_to_person':
        result.cashCents += amount;
        result.payableCents[entry.person] += amount;
        result.personalAdvanceCents[entry.person] += amount;
        break;
      case 'funding_to_supplier':
        result.cashCents += amount;
        result.supplierPayableCents += amount;
        break;
      case 'funding_confirmed':
        break;
      case 'supplier_payment':
        result.supplierPayableCents -= amount;
        if (entry.source === 'treasury') result.cashCents -= amount;
        else {
          result.payableCents[entry.source] += amount;
          result.personalAdvanceCents[entry.source] += amount;
        }
        break;
      case 'stock_loss':
        result.stockLossCents += amount;
        break;
      case 'reimbursement':
        result.cashCents -= amount;
        result.payableCents[entry.person] -= amount;
        result.reimbursedCents[entry.person] += amount;
        break;
      case 'convert_advance':
        result.payableCents[entry.person] -= amount;
        result.capitalCents[entry.person] += amount;
        result.convertedAdvanceCents[entry.person] += amount;
        break;
      case 'return_capital':
        result.cashCents -= amount;
        result.capitalCents[entry.person] -= amount;
        break;
    }
  }
  result.inventoryCents = result.purchaseCents - result.purchaseRefundCents - result.soldCostCents - result.stockLossCents;
  result.profitCents = result.salesCents + result.otherIncomeCents - result.soldCostCents - result.expensesCents - result.stockLossCents;
  for (const item of fundingCases(entries)) {
    if (item.pendingCents > 0) {
      result.pendingFundingCount++;
      result.pendingFundingCents += item.pendingCents;
    }
    result.confirmedOverdraftCents += item.confirmedOverdraftCents;
  }
  return result;
}

export function fundingPlan(book) {
  const totals = summarize(book.entries);
  const me = totals.capitalCents.me;
  const partner = totals.capitalCents.partner;
  const lower = me < partner ? 'me' : partner < me ? 'partner' : null;
  const equalizeCents = Math.abs(me - partner);
  const payableTotalCents = totals.payableCents.me + totals.payableCents.partner;
  const receivableTotalCents = totals.receivableCents.me + totals.receivableCents.partner;
  const supplierPayableCents = totals.supplierPayableCents;
  const targetCents = book.settings.plannedPurchaseCents + book.settings.reserveCents + payableTotalCents + supplierPayableCents;
  const cashGapCents = Math.max(0, targetCents - totals.cashCents);
  const suggestedTransferCents = Math.min(receivableTotalCents, cashGapCents);
  const afterTransferGapCents = Math.max(0, cashGapCents - suggestedTransferCents);
  const afterEqualizeGapCents = Math.max(0, targetCents - totals.cashCents - suggestedTransferCents - equalizeCents);
  const sharedTopUpCents = Math.ceil(afterEqualizeGapCents / 2);
  return {
    targetCents,
    payableTotalCents,
    supplierPayableCents,
    receivableTotalCents,
    cashGapCents,
    suggestedTransferCents,
    afterTransferGapCents,
    equalizeCents,
    lower,
    sharedTopUpCents,
    dueCents: {
      me: sharedTopUpCents + (lower === 'me' ? equalizeCents : 0),
      partner: sharedTopUpCents + (lower === 'partner' ? equalizeCents : 0),
    },
  };
}

export function newEntry(kind, amountCents, options = {}) {
  const entry = {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind,
    amountCents,
    date: options.date ?? todayLocal(),
    note: String(options.note ?? '').trim(),
    person: options.person ?? null,
    source: options.source ?? null,
    ...(options.creditor != null ? { creditor: String(options.creditor).trim() } : {}),
    ...(options.creditId != null ? { creditId: options.creditId } : {}),
    ...(options.targetId != null ? { targetId: options.targetId } : {}),
    ...(options.reason != null ? { reason: options.reason } : {}),
    ...(options.receiptId != null ? { receiptId: options.receiptId } : {}),
    ...(options.fundingReviewCents != null ? { fundingReviewCents: options.fundingReviewCents } : {}),
    ...(options.refundDisposition != null ? { refundDisposition: options.refundDisposition } : {}),
    ...(kind === 'sale' ? { costCents: options.costCents ?? null } : {}),
    ...(kind === 'sale_cost' ? { saleId: options.saleId ?? null } : {}),
    groupId: options.groupId ?? null,
    createdAt: new Date().toISOString(),
    voidedAt: null,
  };
  assertEntry(entry);
  return entry;
}

export function addEntries(book, entries) {
  const next = structuredClone(book);
  let cashCents = summarize(next.entries).cashCents;
  for (const sourceEntry of entries) {
    const entry = structuredClone(sourceEntry);
    if (['reimbursement', 'return_capital'].includes(entry.kind) && cashCents < entry.amountCents) {
      throw new Error('金库余额不能小于零；请先补足金库再报销或返还出资。');
    }
    const delta = entryCashDelta(entry);
    if (REVIEWABLE_KINDS.has(entry.kind) && entry.source === 'treasury' && delta < 0 && !entry.voidedAt) {
      const shortage = Math.max(0, -(cashCents + delta)) - Math.max(0, -cashCents);
      if (shortage > 0) entry.fundingReviewCents = shortage;
      else delete entry.fundingReviewCents;
    }
    next.entries.push(entry);
    cashCents += delta;
  }
  return assertBook(next);
}

export function resolveFunding(book, originId, kind, amountCents, options = {}) {
  if (!FUNDING_RESOLUTIONS.has(kind)) throw new Error('请选择有效的缺口归类方式。');
  const item = fundingCases(book.entries).find(candidate => candidate.entry.id === originId);
  if (!item || item.pendingCents <= 0) throw new Error('找不到这笔支出对应的待核实付款缺口。');
  if (!positiveCents(amountCents) || amountCents > item.pendingCents) {
    throw new Error('归类金额不能超过这笔待核实金额。');
  }
  if (kind === 'funding_to_supplier' && !['purchase', 'expense'].includes(item.entry.kind)) {
    throw new Error('供应商赊账只能用于进货或经营支出。');
  }
  const entry = newEntry(kind, amountCents, {
    ...options,
    targetId: originId,
    note: options.note || `对应 ${item.entry.date} ${ENTRY_LABELS[item.entry.kind]}`,
  });
  return addEntries(book, [entry]);
}

export function voidEntry(book, id) {
  const next = structuredClone(book);
  const entry = next.entries.find(item => item.id === id);
  if (!entry || entry.voidedAt) throw new Error('这笔记录已经作废或不存在。');
  entry.voidedAt = new Date().toISOString();
  entry.voidedAtEntryCount = next.entries.length;
  if (entry.kind === 'sale') {
    for (const linked of next.entries) {
      if (linked.kind === 'sale_cost' && linked.saleId === entry.id && !linked.voidedAt) {
        linked.voidedAt = entry.voidedAt;
        linked.voidedAtEntryCount = entry.voidedAtEntryCount;
      }
    }
  }
  return assertBook(next);
}

export function updateSettings(book, settings) {
  const next = structuredClone(book);
  next.settings = { ...next.settings, ...settings, names: { ...next.settings.names, ...(settings.names ?? {}) } };
  return assertBook(next);
}

export function entryCashDelta(entry) {
  if (entry.voidedAt) return 0;
  if (['deposit', 'other_income', 'sale_transfer', 'funding_to_person', 'funding_to_supplier'].includes(entry.kind)) return entry.amountCents;
  if (entry.kind === 'purchase_refund' && entry.source === 'treasury') return entry.amountCents;
  if (entry.kind === 'sale' && (entry.source == null || entry.source === 'treasury')) return entry.amountCents;
  if (['reimbursement', 'return_capital'].includes(entry.kind)) return -entry.amountCents;
  if (['purchase', 'expense'].includes(entry.kind) && entry.source === 'treasury') return -entry.amountCents;
  if (entry.kind === 'supplier_payment' && entry.source === 'treasury') return -entry.amountCents;
  return 0;
}

function isActualReceipt(entry) {
  return ['deposit', 'other_income', 'sale_transfer'].includes(entry.kind) ||
    (entry.kind === 'purchase_refund' && entry.source === 'treasury') ||
    (entry.kind === 'sale' && (entry.source == null || entry.source === 'treasury'));
}
