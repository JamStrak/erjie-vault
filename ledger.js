export const STORAGE_KEY = 'erjie-vault-ledger-v1';
export const BOOK_VERSION = 1;
export const PEOPLE = ['me', 'partner'];

export const ENTRY_LABELS = {
  deposit: '合伙人入金',
  purchase: '进货',
  sale: '销售记录',
  sale_transfer: '代收销售款转入金库',
  expense: '其他支出',
  other_income: '其他收入',
  reimbursement: '报销垫付',
  convert_advance: '垫付转出资',
  return_capital: '返还出资',
};

const ENTRY_KINDS = new Set(Object.keys(ENTRY_LABELS));
const CASH_SOURCES = new Set(['treasury', ...PEOPLE]);
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
  const value = Number(cents) / 100;
  return `¥${new Intl.NumberFormat('zh-CN', {
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
  if (!positiveCents(entry.amountCents) || !realDate(entry.date)) throw new Error('账本中有金额或日期错误的记录。');
  if (typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error('账本中有录入时间错误的记录。');
  if (typeof entry.note !== 'string' || entry.note.length > 160) throw new Error('账本中有备注错误的记录。');
  if (entry.voidedAt !== null && entry.voidedAt !== undefined &&
      (typeof entry.voidedAt !== 'string' || !Number.isFinite(Date.parse(entry.voidedAt)))) {
    throw new Error('账本中有作废状态错误的记录。');
  }
  if (['deposit', 'sale_transfer', 'reimbursement', 'convert_advance', 'return_capital'].includes(entry.kind) && !PEOPLE.includes(entry.person)) {
    throw new Error('账本中有合伙人信息错误的记录。');
  }
  if (['purchase', 'expense'].includes(entry.kind) && !CASH_SOURCES.has(entry.source)) {
    throw new Error('账本中有付款来源错误的记录。');
  }
  // Earlier v1 sale records had no source field and meant money already entered the vault.
  if (entry.kind === 'sale' && entry.source != null && !CASH_SOURCES.has(entry.source)) {
    throw new Error('账本中有付款来源错误的记录。');
  }
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
  if (book.lastBackupAt !== null && book.lastBackupAt !== undefined &&
      (typeof book.lastBackupAt !== 'string' || !Number.isFinite(Date.parse(book.lastBackupAt)))) {
    throw new Error('账本备份时间无效。');
  }
  const totals = summarize(book.entries);
  if (totals.cashCents < 0) throw new Error('金库余额不能小于零，请检查漏记的入金或垫付。');
  for (const person of PEOPLE) {
    if (totals.capitalCents[person] < 0) throw new Error('返还出资不能超过该人累计净出资。');
    if (totals.payableCents[person] < 0) throw new Error('报销或转出资不能超过该人的待报销金额。');
    if (totals.receivableCents[person] < 0) throw new Error('转入金额不能超过该人的待转入销售款。');
  }
  return book;
}

export function assertCurrentRevision(storedBook, openedBook) {
  const stored = storedBook?.revision ?? 0;
  const opened = openedBook?.revision ?? 0;
  if (stored !== opened) throw new Error('另一标签页已更新账本；请刷新此页核对后再保存，避免覆盖新记录。');
}

export function summarize(entries) {
  const result = {
    cashCents: 0,
    capitalCents: { me: 0, partner: 0 },
    payableCents: { me: 0, partner: 0 },
    receivableCents: { me: 0, partner: 0 },
    depositsCents: 0,
    purchaseCents: 0,
    salesCents: 0,
    expensesCents: 0,
    otherIncomeCents: 0,
    activeCount: 0,
  };
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
        else result.payableCents[entry.source] += amount;
        break;
      case 'reimbursement':
        result.cashCents -= amount;
        result.payableCents[entry.person] -= amount;
        break;
      case 'convert_advance':
        result.payableCents[entry.person] -= amount;
        result.capitalCents[entry.person] += amount;
        break;
      case 'return_capital':
        result.cashCents -= amount;
        result.capitalCents[entry.person] -= amount;
        break;
    }
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
  const targetCents = book.settings.plannedPurchaseCents + book.settings.reserveCents + payableTotalCents;
  const cashGapCents = Math.max(0, targetCents - totals.cashCents);
  const suggestedTransferCents = Math.min(receivableTotalCents, cashGapCents);
  const afterTransferGapCents = Math.max(0, cashGapCents - suggestedTransferCents);
  const afterEqualizeGapCents = Math.max(0, targetCents - totals.cashCents - suggestedTransferCents - equalizeCents);
  const sharedTopUpCents = Math.ceil(afterEqualizeGapCents / 2);
  return {
    targetCents,
    payableTotalCents,
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
    groupId: options.groupId ?? null,
    createdAt: new Date().toISOString(),
    voidedAt: null,
  };
  assertEntry(entry);
  return entry;
}

export function addEntries(book, entries) {
  const next = structuredClone(book);
  next.entries.push(...entries);
  return assertBook(next);
}

export function voidEntry(book, id) {
  const next = structuredClone(book);
  const entry = next.entries.find(item => item.id === id);
  if (!entry || entry.voidedAt) throw new Error('这笔记录已经作废或不存在。');
  entry.voidedAt = new Date().toISOString();
  return assertBook(next);
}

export function updateSettings(book, settings) {
  const next = structuredClone(book);
  next.settings = { ...next.settings, ...settings, names: { ...next.settings.names, ...(settings.names ?? {}) } };
  return assertBook(next);
}

export function entryCashDelta(entry) {
  if (entry.voidedAt) return 0;
  if (['deposit', 'other_income', 'sale_transfer'].includes(entry.kind)) return entry.amountCents;
  if (entry.kind === 'sale' && (entry.source == null || entry.source === 'treasury')) return entry.amountCents;
  if (['reimbursement', 'return_capital'].includes(entry.kind)) return -entry.amountCents;
  if (['purchase', 'expense'].includes(entry.kind) && entry.source === 'treasury') return -entry.amountCents;
  return 0;
}
