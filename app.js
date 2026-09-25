import {
  STORAGE_KEY, ENTRY_LABELS, PEOPLE, addEntries, assertBook, assertCurrentRevision, emptyBook, entryCashDelta,
  fundingCases, fundingPlan, money, newEntry, normalizeLegacyFundingReviews, parseNonnegativeYuan, parseYuan, resolveFunding, summarize,
  todayLocal, updateSettings, voidEntry,
} from './ledger.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const screens = ['home', 'entry', 'review', 'history', 'settings'];
const advancedKinds = new Set(['sale_cost', 'purchase_refund', 'supplier_payment', 'stock_loss', 'other_income', 'sale_transfer', 'reimbursement', 'convert_advance', 'return_capital', 'funding_to_person', 'funding_to_supplier', 'funding_confirmed']);
const RECOVERY_KEY = 'erjie-vault-before-import-v1';
let book = emptyBook();
let storageReady = false;
let damagedStorageRaw = null;
let toastTimer;
let selectedReviewId = null;
let fundingCaseById = new Map();

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 3600);
}

function showStorageError(error) {
  const warning = $('#storage-warning');
  warning.hidden = false;
  warning.textContent = `暂时无法安全保存账本：${error.message}。请不要继续录入；可尝试关闭无痕浏览、释放手机空间，或从设置导入有效备份。`;
  $('#entry-submit').disabled = true;
  $('#settings-form button[type="submit"]').disabled = true;
}

function writeBook(next) {
  assertBook(next);
  const latestRaw = localStorage.getItem(STORAGE_KEY);
  const latest = latestRaw ? assertBook(normalizeLegacyFundingReviews(JSON.parse(latestRaw)).book) : emptyBook();
  assertCurrentRevision(latest, book);
  const saved = { ...next, revision: (book.revision ?? 0) + 1 };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  book = saved;
  storageReady = true;
  $('#storage-warning').hidden = true;
  $('#entry-submit').disabled = false;
  $('#settings-form button[type="submit"]').disabled = false;
  render();
}

function loadBook() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    const migration = raw ? normalizeLegacyFundingReviews(JSON.parse(raw)) : { book: emptyBook(), changed: false };
    const loaded = assertBook(migration.book);
    if (!raw) localStorage.setItem(STORAGE_KEY, JSON.stringify(loaded));
    if (migration.changed) {
      if (localStorage.getItem(STORAGE_KEY) !== raw) throw new Error('另一个标签页已更新账本；请刷新后核对。');
      book = { ...loaded, revision: (loaded.revision ?? 0) + 1 };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(book));
    } else book = loaded;
    storageReady = true;
    damagedStorageRaw = null;
    $('#storage-warning').hidden = true;
    $('#entry-submit').disabled = false;
    $('#settings-form button[type="submit"]').disabled = false;
    render();
    if (migration.changed) showToast('旧账本中有金库付款差额，已标记为待核实；请在首页逐笔确认');
  } catch (error) {
    storageReady = false;
    damagedStorageRaw = raw;
    showStorageError(error);
    render();
  }
}

function personName(person) { return book.settings.names[person] ?? person; }
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function shortDate(value) { return value.replaceAll('-', '.'); }
function pendingFundingCases() { return [...fundingCaseById.values()].filter(item => item.pendingCents > 0); }
function supplierCredits() {
  const active = book.entries.filter(entry => !entry.voidedAt);
  const used = new Map();
  for (const entry of active) {
    if (entry.kind === 'supplier_payment' || (entry.kind === 'purchase_refund' && entry.source === 'supplier_credit')) {
      used.set(entry.creditId, (used.get(entry.creditId) ?? 0) + entry.amountCents);
    }
  }
  return active.filter(entry => (['purchase', 'expense'].includes(entry.kind) && entry.source === 'supplier_credit') || entry.kind === 'funding_to_supplier')
    .map(entry => ({ entry, remainingCents: entry.amountCents - (used.get(entry.id) ?? 0) }))
    .filter(item => item.remainingCents > 0).sort((a, b) => sortNewest(a.entry, b.entry));
}
function refundableSupplierCredits(source) {
  const active = book.entries.filter(entry => !entry.voidedAt);
  const byId = new Map(active.map(entry => [entry.id, entry]));
  const usage = new Map();
  for (const entry of active) {
    if (!entry.creditId || !['supplier_payment', 'purchase_refund'].includes(entry.kind)) continue;
    const current = usage.get(entry.creditId) ?? { paid: { treasury: 0, me: 0, partner: 0 }, refunded: { treasury: 0, me: 0, partner: 0 }, creditRefunded: 0 };
    if (entry.kind === 'supplier_payment') current.paid[entry.source] += entry.amountCents;
    else if (entry.source === 'supplier_credit') current.creditRefunded += entry.amountCents;
    else current.refunded[entry.source] += entry.amountCents;
    usage.set(entry.creditId, current);
  }
  return active.filter(entry => (entry.kind === 'purchase' && entry.source === 'supplier_credit') ||
    (entry.kind === 'funding_to_supplier' && byId.get(entry.targetId)?.kind === 'purchase'))
    .map(entry => {
      const current = usage.get(entry.id) ?? { paid: { treasury: 0, me: 0, partner: 0 }, refunded: { treasury: 0, me: 0, partner: 0 }, creditRefunded: 0 };
      const paidTotal = current.paid.treasury + current.paid.me + current.paid.partner;
      const refundableCents = source === 'supplier_credit'
        ? entry.amountCents - paidTotal - current.creditRefunded
        : current.paid[source] - current.refunded[source];
      return { entry, refundableCents };
    })
    .filter(item => item.refundableCents > 0).sort((a, b) => sortNewest(a.entry, b.entry));
}

function renderRefundCreditOptions() {
  const source = $('#entry-source').value;
  const options = refundableSupplierCredits(source);
  const select = $('#refund-credit');
  const previous = select.value;
  const ordinary = source === 'supplier_credit' ? '<option value="">请选择要抵扣的赊账</option>' : '<option value="">普通原路退回（非赊账）</option>';
  select.innerHTML = ordinary + options.map(item => `<option value="${escapeHtml(item.entry.id)}">${shortDate(item.entry.date)} · ${escapeHtml(item.entry.creditor)} · 此去向可退 ${money(item.refundableCents)}</option>`).join('');
  if (options.some(item => item.entry.id === previous)) select.value = previous;
  $('#refund-credit-help').textContent = source === 'supplier_credit'
    ? '选择尚未付清的对应赊账；退货金额将直接抵扣欠供应商的款。'
    : '普通进货退款选“普通原路退回”；如果这笔赊账已由该去向付款，选对应赊账，退款会退回这个去向。';
}
function reviewReceipts(originId) {
  const originPosition = book.entries.findIndex(entry => entry.id === originId);
  const used = new Map();
  for (const entry of book.entries) {
    if (!entry.voidedAt && entry.kind === 'funding_confirmed' && entry.reason === 'receipt_fixed') used.set(entry.receiptId, (used.get(entry.receiptId) ?? 0) + entry.amountCents);
  }
  return book.entries.filter((entry, position) => position > originPosition && !entry.voidedAt && entryCashDelta(entry) > 0 &&
    (['deposit', 'sale', 'other_income', 'sale_transfer'].includes(entry.kind) || (entry.kind === 'purchase_refund' && entry.source === 'treasury')))
    .map(entry => ({ entry, remainingCents: entryCashDelta(entry) - (used.get(entry.id) ?? 0) }))
    .filter(item => item.remainingCents > 0).sort((a, b) => sortNewest(a.entry, b.entry));
}
function pendingCostSaleIds() {
  const supplemented = new Set(book.entries.filter(item => item.kind === 'sale_cost' && !item.voidedAt).map(item => item.saleId));
  return new Set(book.entries.filter(item => item.kind === 'sale' && !item.voidedAt && item.costCents == null && !supplemented.has(item.id)).map(item => item.id));
}

function setScreen(name) {
  if (!screens.includes(name)) return;
  for (const screen of screens) {
    const active = screen === name;
    $(`#screen-${screen}`).hidden = !active;
    $(`#screen-${screen}`).classList.toggle('is-active', active);
  }
  $$('.bottom-nav button').forEach(button => {
    const active = button.dataset.nav === name;
    button.classList.toggle('is-current', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (name === 'entry') $('#entry-date').max = todayLocal();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderHome(totals, plan) {
  const pending = totals.pendingCostCount > 0;
  const profit = $('#profit-balance');
  profit.textContent = pending ? '待核算' : money(totals.profitCents);
  profit.classList.toggle('pending', pending);
  profit.classList.toggle('positive', !pending && totals.profitCents > 0);
  profit.classList.toggle('negative', !pending && totals.profitCents < 0);
  const profitStatus = $('#profit-status');
  profitStatus.textContent = pending ? `${totals.pendingCostCount} 笔待补成本` : totals.profitCents < 0 ? '累计亏损' : totals.profitCents > 0 ? '累计盈利' : '收支持平';
  profitStatus.classList.toggle('pending', pending);
  $('#profit-caption').textContent = pending
    ? '有销售没填卖出商品的进价，盈亏与库存成本暂时不能准确计算。'
    : '累计经营结果＝销售＋其他收入－已售商品成本－费用－报损；还没卖的货留在库存。';
  $('#pending-cost-action').hidden = !pending;
  const recovery = $('#recovery-balance');
  const hasOperatingActivity = totals.purchaseCents > 0 || totals.salesCents > 0
    || totals.expensesCents > 0 || totals.otherIncomeCents > 0;
  recovery.textContent = money(totals.recoveryCents);
  recovery.classList.toggle('positive', hasOperatingActivity && totals.recoveryCents > 0);
  recovery.classList.toggle('negative', hasOperatingActivity && totals.recoveryCents < 0);
  recovery.classList.toggle('pending', !hasOperatingActivity);
  const recoveryStatus = $('#recovery-status');
  recoveryStatus.textContent = !hasOperatingActivity ? '尚无经营流水'
    : totals.recoveryCents < 0 ? `还差 ${money(-totals.recoveryCents)} 覆盖成本`
      : totals.recoveryCents > 0 ? '已覆盖已记成本' : '刚好覆盖已记成本';
  recoveryStatus.classList.toggle('positive', hasOperatingActivity && totals.recoveryCents > 0);
  recoveryStatus.classList.toggle('negative', hasOperatingActivity && totals.recoveryCents < 0);
  recoveryStatus.classList.toggle('pending', !hasOperatingActivity);
  $('#recovery-caption').textContent = !hasOperatingActivity
    ? '开始记进货和销售后，这里会显示收入离覆盖全部成本还差多少。'
    : '销售及其他收入－全部净进货－经营费用；未卖的货也算投入，入金不重复扣。';
  $('#cash-balance').textContent = money(totals.cashCents);
  $('#cash-balance').closest('.position-card').classList.toggle('is-negative', totals.cashCents < 0);
  $('#cash-caption').textContent = totals.cashCents < 0
    ? totals.pendingFundingCount ? '账面透支，请逐笔核对付款来源' : '已核实透支，待后续入金冲抵'
    : '金库实际进出后的账面金额';
  const needsReview = totals.pendingFundingCount > 0;
  $('#funding-alert').hidden = !needsReview && totals.cashCents >= 0;
  $('#funding-alert').classList.toggle('is-confirmed', !needsReview && totals.cashCents < 0);
  if (needsReview) {
    $('#funding-alert-title').textContent = `${totals.pendingFundingCount} 笔付款待核实 · ${money(totals.pendingFundingCents)}`;
    $('#funding-alert-detail').textContent = totals.cashCents < 0
      ? `金库账面余额 ${money(totals.cashCents)}；点这里确认是谁垫付或赊账`
      : '余额虽已回正，之前的付款差额仍要逐笔确认';
    $('#funding-alert').dataset.nav = 'review';
    delete $('#funding-alert').dataset.historyFilter;
  } else if (totals.cashCents < 0) {
    $('#funding-alert-title').textContent = `金库已核实透支 ${money(totals.cashCents)}`;
    $('#funding-alert-detail').textContent = '账面仍为负数；入金后会冲抵，点此查看流水';
    $('#funding-alert').dataset.nav = 'history';
    $('#funding-alert').dataset.historyFilter = 'all';
  }
  $('#supplier-debt-card').hidden = totals.supplierPayableCents <= 0;
  $('#supplier-debt-total').textContent = money(totals.supplierPayableCents);
  $('#inventory-balance').textContent = pending ? '待核算' : money(totals.inventoryCents);
  $('#inventory-caption').textContent = pending ? '补齐销售成本后显示准确库存成本' : '按进货成本计算，未售出的货';
  $('#receivable-total').textContent = money(totals.receivableCents.me + totals.receivableCents.partner);
  $('#payable-total').textContent = money(plan.payableTotalCents);
  $('#sales-total').textContent = money(totals.salesCents);
  $('#other-income-hero').textContent = money(totals.otherIncomeCents);
  $('#sold-cost-total').textContent = money(totals.soldCostCents);
  $('#operating-cost-total').textContent = money(totals.expensesCents + totals.stockLossCents);
  $('#purchase-total').textContent = money(totals.purchaseCents - totals.purchaseRefundCents);
  $('#sold-cost-repeat').textContent = money(totals.soldCostCents);
  $('#expense-total').textContent = money(totals.expensesCents + totals.stockLossCents);
  $('#other-income-total').textContent = money(totals.otherIncomeCents);
  $('#me-label').textContent = personName('me');
  $('#partner-label').textContent = personName('partner');
  $('#me-capital').textContent = money(totals.capitalCents.me);
  $('#partner-capital').textContent = money(totals.capitalCents.partner);
  $('#me-payable').textContent = money(totals.payableCents.me);
  $('#partner-payable').textContent = money(totals.payableCents.partner);
  $('#me-exposure').textContent = money(totals.capitalCents.me + totals.payableCents.me);
  $('#partner-exposure').textContent = money(totals.capitalCents.partner + totals.payableCents.partner);
  $('#parity-note').textContent = plan.equalizeCents
    ? `${personName(plan.lower)}正式净出资少 ${money(plan.equalizeCents)}。五五出资要按实际入金或双方确认的垫付转出资记录；待报销垫付暂不算出资。`
    : '目前两人正式净出资相同；各自待报销垫付仍单独显示。';

  const needCash = plan.cashGapCents > 0;
  const status = $('#funding-status');
  status.textContent = plan.afterTransferGapCents > 0 ? '需要补钱' : needCash ? '先转入代收' : plan.equalizeCents ? '出资待追平' : '现金够用';
  status.classList.toggle('needs-money', plan.afterTransferGapCents > 0);
  const planned = book.settings.plannedPurchaseCents;
  const reserve = book.settings.reserveCents;
  if (plan.targetCents === 0) {
    $('#funding-explain').textContent = plan.cashGapCents > 0
      ? `金库账面余额 ${money(totals.cashCents)}，当前需补 ${money(plan.cashGapCents)} 才能覆盖透支。${needsReview ? '付款来源尚待逐笔核实，确认后计划会更新。' : ''}`
      : `设置下次计划进货和备用金后，这里会告诉你金库够不够。${needsReview ? '之前仍有付款待核实，请先逐笔确认。' : ''}`;
  } else if (needCash) {
    const targetText = `下次进货 ${money(planned)}、备用金 ${money(reserve)}${plan.payableTotalCents ? `、待报销 ${money(plan.payableTotalCents)}` : ''}${plan.supplierPayableCents ? `、欠供应商 ${money(plan.supplierPayableCents)}` : ''}。`;
    const transferText = plan.suggestedTransferCents
      ? `当前现金差 ${money(plan.cashGapCents)}；先让代收的 ${money(plan.suggestedTransferCents)} 实际转入金库，转入后还差 ${money(plan.afterTransferGapCents)}。`
      : `当前金库还差 ${money(plan.cashGapCents)}。`;
    $('#funding-explain').textContent = `${targetText}${transferText}下面的入金建议按先转入代收款、再追平五五出资计算。${needsReview ? '仍有付款待核实，确认来源后建议会更新。' : ''}`;
  } else {
    $('#funding-explain').textContent = `当前金库账面余额可覆盖计划进货 ${money(planned)}、备用金 ${money(reserve)}${plan.payableTotalCents ? `及待报销 ${money(plan.payableTotalCents)}` : ''}${plan.supplierPayableCents ? `、欠供应商 ${money(plan.supplierPayableCents)}` : ''}，预计还剩 ${money(totals.cashCents - plan.targetCents)}。${plan.equalizeCents ? '但两人的实际出资还未追平。' : '暂时不必为了这次计划再入金。'}${needsReview ? '仍有付款待核实，请逐笔确认。' : ''}`;
  }
  $('#me-due-label').textContent = `${personName('me')}建议再存`;
  $('#partner-due-label').textContent = `${personName('partner')}建议再存`;
  $('#me-due').textContent = money(plan.dueCents.me);
  $('#partner-due').textContent = money(plan.dueCents.partner);
  $('#plan-payable-total').textContent = money(plan.payableTotalCents);
  $('#plan-supplier-row').hidden = plan.supplierPayableCents <= 0;
  $('#plan-supplier-total').textContent = money(plan.supplierPayableCents);
  const active = book.entries.filter(item => !item.voidedAt).sort(sortNewest);
  const pendingCostIds = pendingCostSaleIds();
  $('#recent-list').innerHTML = active.length
    ? active.slice(0, 4).map(entry => entryHtml(entry, false, pendingCostIds)).join('')
    : '<div class="empty-state"><b>✦</b>这里还空着。<br>记下第一笔真实入金，账本就开始了。</div>';
}

function sortNewest(a, b) { return b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt); }

function entryHtml(entry, detailed, pendingCostIds) {
  const change = entryCashDelta(entry);
  const reclassification = ['funding_to_person', 'funding_to_supplier', 'funding_confirmed'].includes(entry.kind);
  const tone = reclassification ? 'neutral' : change > 0 ? 'inflow' : change < 0 ? 'outflow' : 'neutral';
  let title = ENTRY_LABELS[entry.kind];
  let subtitle = shortDate(entry.date);
  if (entry.kind === 'deposit') title = `${personName(entry.person)}入金`;
  if (['purchase', 'expense', 'purchase_refund'].includes(entry.kind)) {
    if (entry.source === 'supplier_credit') subtitle += entry.kind === 'purchase_refund' ? ' · 退货抵扣供应商欠款' : ` · 欠供应商 ${entry.creditor}`;
    else if (entry.kind === 'purchase_refund' && entry.source === 'treasury') subtitle += ' · 退款已入金库';
    else if (entry.kind === 'purchase_refund') subtitle += entry.refundDisposition === 'person_receivable'
      ? ` · ${personName(entry.source)}代收待转入` : ` · 抵减${personName(entry.source)}待报销`;
    else subtitle += ` · ${entry.source === 'treasury' ? '金库付款' : `${personName(entry.source)}个人垫付`}`;
    if (entry.kind === 'purchase_refund' && entry.creditId && entry.source !== 'supplier_credit') subtitle += ' · 对应已付赊账';
  } else if (entry.kind === 'sale') {
    subtitle += ` · ${entry.source == null || entry.source === 'treasury' ? '已入金库' : `${personName(entry.source)}代收待转入`}`;
    if (entry.costCents != null) subtitle += ` · 已售成本 ${money(entry.costCents)}`;
    else if (pendingCostIds.has(entry.id)) subtitle += ' · 成本待补';
    else if (!entry.voidedAt) subtitle += ' · 成本已补录';
  } else if (entry.kind === 'sale_cost') {
    const sale = book.entries.find(item => item.id === entry.saleId);
    subtitle += sale ? ` · 对应 ${shortDate(sale.date)} 销售 ${money(sale.amountCents)}` : '';
  } else if (['sale_transfer', 'reimbursement', 'convert_advance', 'return_capital'].includes(entry.kind)) {
    subtitle += ` · ${personName(entry.person)}`;
  } else if (entry.kind === 'supplier_payment') {
    subtitle += ` · ${entry.source === 'treasury' ? '金库付款' : `${personName(entry.source)}垫付`} · 对应赊账`;
  } else if (entry.kind === 'funding_to_person') {
    subtitle += ` · ${personName(entry.person)}垫付 · 原付款已归类`;
  } else if (entry.kind === 'funding_to_supplier') {
    subtitle += ` · 欠 ${entry.creditor} · 原付款已归类`;
  } else if (entry.kind === 'funding_confirmed') {
    subtitle += entry.reason === 'receipt_fixed' ? ' · 已关联补录收款' : ' · 已确认真实透支';
  }
  if (entry.voidedAt) subtitle += ' · 已作废';
  const amountText = `${reclassification ? '' : change > 0 ? '+' : change < 0 ? '−' : ''}${money(entry.amountCents)}`;
  const symbol = reclassification ? '◇' : change > 0 ? '＋' : change < 0 ? '−' : '◇';
  const fundingCase = fundingCaseById.get(entry.id);
  const pending = entry.voidedAt ? 0 : fundingCase?.pendingCents ?? 0;
  return `<article class="entry-row ${tone}${entry.voidedAt ? ' is-voided' : ''}">
    <span class="entry-icon" aria-hidden="true">${symbol}</span>
    <div class="entry-main"><div class="entry-line"><span class="entry-title">${escapeHtml(title)}</span><strong class="entry-amount">${amountText}</strong></div>
      <div class="entry-meta">${escapeHtml(subtitle)}</div>${entry.note ? `<div class="entry-note">${escapeHtml(entry.note)}</div>` : ''}
      ${pending ? `<span class="funding-chip">待核实 ${money(pending)}</span><button type="button" class="review-entry-button" data-review-id="${escapeHtml(entry.id)}">归类这笔付款 →</button>` : ''}
      ${entry.kind === 'sale' && pendingCostIds.has(entry.id) ? `<button type="button" class="cost-button" data-fill-cost-id="${escapeHtml(entry.id)}">补这笔销售的进货成本 →</button>` : ''}
      ${detailed && !entry.voidedAt ? `<button type="button" class="void-button" data-void-id="${escapeHtml(entry.id)}">记错了？作废这笔</button>` : ''}
    </div></article>`;
}

function renderHistory(totals) {
  $('#history-summary-label').textContent = totals.pendingCostCount ? '累计经营盈亏 · 待核算' : '累计经营盈亏';
  $('#history-balance').textContent = totals.pendingCostCount ? '待核算' : money(totals.profitCents);
  $('#history-count').textContent = `${totals.activeCount} 笔有效记录 · ${book.entries.length - totals.activeCount} 笔作废`;
  const filter = $('#history-filter').value;
  const pendingCostIds = pendingCostSaleIds();
  const filtered = book.entries.filter(entry => {
    if (filter === 'all') return true;
    if (filter === 'voided') return Boolean(entry.voidedAt);
    if (filter === 'funding_review') return fundingCaseById.get(entry.id)?.pendingCents > 0;
    if (filter === 'pending_cost') return pendingCostIds.has(entry.id);
    if (filter === 'other') return advancedKinds.has(entry.kind);
    return entry.kind === filter;
  }).sort(sortNewest);
  const visible = filtered.slice(0, 250);
  $('#history-list').innerHTML = visible.length
    ? visible.map(entry => entryHtml(entry, true, pendingCostIds)).join('') + (filtered.length > visible.length ? `<p class="field-help">这里只显示最近 250 笔；导出明细表可查看全部 ${filtered.length} 笔。</p>` : '')
    : '<div class="empty-state"><b>○</b>这个分类下还没有记录。</div>';
}

function renderSettings() {
  $('#planned-purchase').value = (book.settings.plannedPurchaseCents / 100).toFixed(2);
  $('#reserve-amount').value = (book.settings.reserveCents / 100).toFixed(2);
  $('#my-name').value = personName('me');
  $('#partner-name').value = personName('partner');
  $('#backup-date').textContent = book.lastBackupAt
    ? `上次发起完整备份：${new Date(book.lastBackupAt).toLocaleString('zh-CN')}（请到“文件”确认）`
    : '尚未导出完整备份';
  const recovery = readRecovery();
  $('#restore-pre-import').hidden = !recovery;
  $('#recovery-description').hidden = !recovery;
  if (recovery) {
    $('#recovery-description').textContent = `上次导入前的账本已暂存在本机：${new Date(recovery.savedAt).toLocaleString('zh-CN')}，${recovery.book.entries.length} 笔流水。`;
  }
  const personOptions = PEOPLE.map(person => `<option value="${person}">${escapeHtml(personName(person))}</option>`).join('');
  for (const id of ['#entry-person', '#entry-target-person', '#review-person']) {
    const select = $(id);
    const previous = select.value;
    select.innerHTML = personOptions;
    if (PEOPLE.includes(previous)) select.value = previous;
  }
  $('#entry-source').querySelector('[value="me"]').textContent = `${personName('me')}个人垫付`;
  $('#entry-source').querySelector('[value="partner"]').textContent = `${personName('partner')}个人垫付`;
  $('#supplier-payment-source').querySelector('[value="me"]').textContent = `${personName('me')}个人垫付`;
  $('#supplier-payment-source').querySelector('[value="partner"]').textContent = `${personName('partner')}个人垫付`;
  $('#sale-source').querySelector('[value="me"]').textContent = `${personName('me')}先代收，还没转入金库`;
  $('#sale-source').querySelector('[value="partner"]').textContent = `${personName('partner')}先代收，还没转入金库`;
  const pendingIds = pendingCostSaleIds();
  const pendingSales = book.entries.filter(item => pendingIds.has(item.id)).sort(sortNewest);
  const costSelect = $('#sale-cost-sale');
  const previouslySelected = costSelect.value;
  costSelect.innerHTML = pendingSales.length
    ? pendingSales.map(item => `<option value="${escapeHtml(item.id)}">${shortDate(item.date)} · 销售 ${money(item.amountCents)}${item.note ? ` · ${escapeHtml(item.note.slice(0, 22))}` : ''}</option>`).join('')
    : '<option value="">没有待补成本的销售</option>';
  if (pendingSales.some(item => item.id === previouslySelected)) costSelect.value = previouslySelected;
  const credits = supplierCredits();
  for (const [id, options] of [
    ['#supplier-payment-credit', credits],
  ]) {
    const select = $(id);
    const previous = select.value;
    select.innerHTML = options.length ? options.map(item => `<option value="${escapeHtml(item.entry.id)}">${shortDate(item.entry.date)} · ${escapeHtml(item.entry.creditor)} · 尚欠 ${money(item.remainingCents)}</option>`).join('') : '<option value="">暂无可用的供应商赊账</option>';
    if (options.some(item => item.entry.id === previous)) select.value = previous;
  }
  renderRefundCreditOptions();
}

function renderReview(totals) {
  const cases = pendingFundingCases().sort((a, b) => sortNewest(a.entry, b.entry));
  $('#review-pending-total').textContent = money(totals.pendingFundingCents);
  $('#review-pending-count').textContent = `${cases.length} 笔待核实`;
  $('#review-list').innerHTML = cases.length ? cases.map(item => `<article class="review-case">
    <div class="review-case-top"><span>${escapeHtml(ENTRY_LABELS[item.entry.kind])} · ${shortDate(item.entry.date)}</span><strong>${money(item.pendingCents)}</strong></div>
    <p>${item.entry.note ? escapeHtml(item.entry.note) : '当时从金库支付，但账面余额不足。'}</p>
    <small>原始差额 ${money(item.originalCents)}${item.classifiedCents ? ` · 已归类 ${money(item.classifiedCents)}` : ''}${item.confirmedOverdraftCents ? ` · 已确认透支 ${money(item.confirmedOverdraftCents)}` : ''}</small>
    <button type="button" class="review-entry-button" data-review-id="${escapeHtml(item.entry.id)}">核实这笔 →</button>
  </article>`).join('') : '<div class="empty-state"><b>✓</b>目前没有待核实付款。<br>每笔付款来源都已经核对清楚。</div>';
  const selected = cases.find(item => item.entry.id === selectedReviewId);
  $('#review-form').hidden = !selected;
  if (!selected) { selectedReviewId = null; return; }
  $('#review-form-title').textContent = `归类 ${shortDate(selected.entry.date)} 的${ENTRY_LABELS[selected.entry.kind]}`;
  $('#review-form-context').textContent = `原付款 ${money(selected.entry.amountCents)}，当前待核实 ${money(selected.pendingCents)}。可以先处理一部分，余下继续提醒。`;
  $('#review-amount').value = (selected.pendingCents / 100).toFixed(2);
  $('#review-kind').querySelector('[value="funding_to_supplier"]').hidden = selected.entry.kind === 'supplier_payment';
  $('#review-kind').querySelector('[value="funding_to_supplier"]').disabled = selected.entry.kind === 'supplier_payment';
  if (selected.entry.kind === 'supplier_payment' && $('#review-kind').value === 'funding_to_supplier') $('#review-kind').value = 'funding_to_person';
  const receipts = reviewReceipts(selected.entry.id);
  const select = $('#review-receipt');
  select.innerHTML = receipts.length ? receipts.map(item => `<option value="${escapeHtml(item.entry.id)}" data-remaining-cents="${item.remainingCents}">${shortDate(item.entry.date)} · ${escapeHtml(ENTRY_LABELS[item.entry.kind])} · 可核实 ${money(item.remainingCents)}</option>`).join('') : '<option value="">没有可关联的已录入收款</option>';
  updateReviewFields();
}

function render() {
  fundingCaseById = new Map(fundingCases(book.entries).map(item => [item.entry.id, item]));
  const totals = summarize(book.entries);
  renderHome(totals, fundingPlan(book));
  renderHistory(totals);
  renderSettings();
  renderReview(totals);
}

function setKind(kind) {
  if (!ENTRY_LABELS[kind]) return;
  $('#entry-kind').value = kind;
  $$('.kind-tab').forEach(button => button.classList.toggle('is-selected', button.dataset.kind === kind));
  $('#more-kind').value = advancedKinds.has(kind) ? kind : '';
  $('#deposit-fields').hidden = kind !== 'deposit';
  $('#source-fields').hidden = !['purchase', 'expense', 'purchase_refund'].includes(kind);
  $('#sale-fields').hidden = kind !== 'sale';
  $('#sale-cost-fields').hidden = kind !== 'sale_cost';
  $('#supplier-payment-fields').hidden = kind !== 'supplier_payment';
  $('#person-fields').hidden = !['sale_transfer', 'reimbursement', 'convert_advance', 'return_capital'].includes(kind);
  $('#entry-date-row').hidden = kind === 'sale_cost';
  const refund = kind === 'purchase_refund';
  $('#source-label').textContent = refund ? '这笔退款退到哪里？' : '这笔钱从哪里付？';
  $('#entry-source').querySelector('[value="treasury"]').textContent = refund ? '退款进入金库' : '从金库支付';
  $('#entry-source').querySelector('[value="me"]').textContent = refund ? `退款退给${personName('me')}` : `${personName('me')}个人垫付`;
  $('#entry-source').querySelector('[value="partner"]').textContent = refund ? `退款退给${personName('partner')}` : `${personName('partner')}个人垫付`;
  $('#entry-source').querySelector('[value="supplier_credit"]').textContent = refund ? '未付款，直接抵扣欠供应商的款' : '先赊账，欠供应商';
  $('#source-help').textContent = refund ? '普通进货退款按原付款去向退回；已付的供应商赊账退款请关联下方的对应赊账。个人收到退款后若仍欠金库，可再记代收款转入。' : '金库余额不足也可以先保存，差额会持续提醒你核实；若已知是个人垫付或供应商赊账，直接选择对应来源。';
  const labels = {
    deposit: '这次实际存入多少？', purchase: '这次进货花了多少？', sale: '这次实际卖了多少？',
    expense: '这次实际支出多少？', other_income: '这次实际收到多少？',
    sale_cost: '这次卖出的货，进价合计是多少？', purchase_refund: '这次退货退回多少进货款？', stock_loss: '这次损失的商品进货成本是多少？',
    sale_transfer: '这次实际转入金库多少？',
    reimbursement: '这次已报销多少？', convert_advance: '这次转为出资多少？', return_capital: '这次实际返还多少？', supplier_payment: '这次实际偿还供应商多少？',
  };
  const hints = {
    deposit: '只记已经收到的钱；对方入金不会自动算作你的入金。',
    purchase: '按进货成本登记入库。金库账面不足也能先记下；之后逐笔核实是谁垫付或是否赊账。',
    sale: '销售款如果先进入个人收款码，请选“代收”。还需填这次卖掉的商品进价合计，才能算出经营盈亏。',
    expense: '例如摊位物料、运费和包装；已知谁垫付就直接选择她，不清楚的金库缺口可以稍后核实。',
    sale_cost: '先选对应销售，再填那次卖出的商品进价；日期会自动跟随原销售。真是零成本请明确填 0。',
    purchase_refund: '进货退款不算经营收入。普通退款按原付款去向退回；已支付的赊账退款要关联对应赊账。',
    stock_loss: '例如损坏、遗失或赠送，填该批商品原进货成本；库存减少，同时计入经营损失。',
    other_income: '只记与销售无关、确实属于店铺的经营收入；合伙人入金和进货退款请用各自类型。',
    sale_transfer: '个人代收的销售款或供应商退款实际进入金库时再记；不能超过该人当前待转入金额。',
    reimbursement: '从金库实际付给垫付人的钱。不能超过金库现金或该人的待报销金额。',
    convert_advance: '双方决定不再报销这笔垫付时，才转为该人的实际出资；金库现金不变。',
    return_capital: '从金库实际退给合伙人的出资，金库和该人的累计净出资会同时减少。',
    supplier_payment: '先选对应赊账，再记实际付款的人。个人代付会成为待报销；金库付款若产生新缺口，也会继续提醒核实。',
  };
  $('#amount-label').textContent = labels[kind];
  $('#entry-hint').textContent = hints[kind];
  $('#entry-submit').textContent = `保存这笔${ENTRY_LABELS[kind]}`;
  $('#person-help').textContent = hints[kind];
  updateDepositMode();
  renderRefundCreditOptions();
  updateEntrySourceFields();
}

function shortfallFor(amountCents) {
  const cash = summarize(book.entries).cashCents;
  return Math.max(0, amountCents - cash) - Math.max(0, -cash);
}

function updateEntrySourceFields() {
  const kind = $('#entry-kind').value;
  const source = $('#entry-source').value;
  $('#creditor-fields').hidden = !(['purchase', 'expense'].includes(kind) && source === 'supplier_credit');
  $('#refund-credit-fields').hidden = kind !== 'purchase_refund';
  $('#refund-disposition-fields').hidden = !(kind === 'purchase_refund' && ['me', 'partner'].includes(source));
  for (const [id, relevant] of [
    ['#source-shortfall-hint', ['purchase', 'expense'].includes(kind) && source === 'treasury'],
    ['#supplier-shortfall-hint', kind === 'supplier_payment' && $('#supplier-payment-source').value === 'treasury'],
  ]) {
    const hint = $(id);
    let amount;
    try { amount = parseYuan($('#entry-amount').value); } catch { amount = 0; }
    const shortage = relevant && amount ? shortfallFor(amount) : 0;
    hint.hidden = shortage <= 0;
    if (shortage) hint.textContent = `金库目前账面余额 ${money(summarize(book.entries).cashCents)}。仍可保存；这笔会新增待核实付款 ${money(shortage)}，之后可逐笔归类。`;
  }
}

function updateReviewFields() {
  const kind = $('#review-kind').value;
  const reason = $('#review-reason').value;
  $('#review-person-fields').hidden = kind !== 'funding_to_person';
  $('#review-creditor-fields').hidden = kind !== 'funding_to_supplier';
  $('#review-reason-fields').hidden = kind !== 'funding_confirmed';
  $('#review-receipt-fields').hidden = !(kind === 'funding_confirmed' && reason === 'receipt_fixed');
  if (kind === 'funding_confirmed' && reason === 'receipt_fixed') {
    const available = Number($('#review-receipt').selectedOptions[0]?.dataset.remainingCents ?? 0);
    if (available > 0) {
      try {
        if (parseYuan($('#review-amount').value) > available) $('#review-amount').value = (available / 100).toFixed(2);
      } catch { /* The user can finish entering an amount. */ }
    }
  }
  $('#review-explain').textContent = kind === 'funding_to_person' ? '会把这笔差额记为合伙人垫付待报销，不重复计算进货或费用。'
    : kind === 'funding_to_supplier' ? '会把这笔差额记为欠供应商，之后从“其他业务”记还款。'
      : reason === 'receipt_fixed' ? $('#review-receipt').value ? '关联已补录的真实收款，消除这笔提醒；原付款与收款记录都保留。' : '暂无可关联收款。请先在“记一笔”补录真实入账，再回来核实。'
        : '确认这是金库账户真实的透支；负余额仍会显示，后续入金会逐渐冲抵。';
}

function updateDepositMode() {
  const paired = $('input[name="depositMode"]:checked').value === 'paired';
  $('#single-depositor').hidden = paired;
  $('#paired-confirm-row').hidden = !paired;
  if (!paired) $('#paired-confirm').checked = false;
}

function toggleSaleCostInput() {
  const later = $('#sale-cost-later').checked;
  $('#sale-cost').disabled = later;
  if (later) $('#sale-cost').value = '';
}

function submitEntry(event) {
  event.preventDefault();
  if (!storageReady) return showToast('当前无法安全保存，请先恢复存储。');
  try {
    const kind = $('#entry-kind').value;
    if (kind === 'sale_cost' && $('#entry-amount').value.trim() === '') throw new Error('请填写已售商品进价；确实零成本请填 0。');
    const amountCents = kind === 'sale_cost' ? parseNonnegativeYuan($('#entry-amount').value) : parseYuan($('#entry-amount').value);
    const selectedSale = kind === 'sale_cost' ? book.entries.find(item => item.id === $('#sale-cost-sale').value && !item.voidedAt) : null;
    if (kind === 'sale_cost' && !selectedSale) throw new Error('请先选择要补成本的销售记录。');
    const date = selectedSale?.date ?? $('#entry-date').value;
    if (!date || date > todayLocal()) throw new Error('请选择真实发生的日期，不能记未来的流水。');
    const note = $('#entry-note').value.trim();
    let entries;
    if (kind === 'deposit' && $('input[name="depositMode"]:checked').value === 'paired') {
      if (!$('#paired-confirm').checked) throw new Error('请先确认两笔钱都已实际进入金库。');
      const groupId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-paired`;
      entries = PEOPLE.map(person => newEntry(kind, amountCents, { person, date, note, groupId }));
    } else {
      const person = kind === 'deposit' ? $('#entry-person').value
        : ['sale_transfer', 'reimbursement', 'convert_advance', 'return_capital'].includes(kind) ? $('#entry-target-person').value : null;
      const source = ['purchase', 'expense', 'purchase_refund'].includes(kind) ? $('#entry-source').value
        : kind === 'sale' ? $('#sale-source').value : kind === 'supplier_payment' ? $('#supplier-payment-source').value : null;
      const creditor = ['purchase', 'expense'].includes(kind) && source === 'supplier_credit' ? $('#entry-creditor').value.trim() : undefined;
      const creditId = kind === 'supplier_payment' ? $('#supplier-payment-credit').value
        : kind === 'purchase_refund' ? $('#refund-credit').value || undefined : undefined;
      const refundDisposition = kind === 'purchase_refund' && ['me', 'partner'].includes(source)
        ? $('#refund-disposition').value : undefined;
      let costCents;
      if (kind === 'sale') {
        const later = $('#sale-cost-later').checked;
        if (!later && $('#sale-cost').value.trim() === '') throw new Error('请填这笔销售的商品进价；暂不知道就勾选稍后补录。');
        costCents = later ? null : parseNonnegativeYuan($('#sale-cost').value);
      }
      entries = [newEntry(kind, amountCents, { person, source, date, note, costCents, saleId: selectedSale?.id, creditor, creditId, refundDisposition })];
    }
    const beforePending = summarize(book.entries).pendingFundingCents;
    const next = addEntries(book, entries);
    const newPending = summarize(next.entries).pendingFundingCents - beforePending;
    writeBook(next);
    $('#entry-form').reset();
    toggleSaleCostInput();
    $('#entry-date').value = todayLocal();
    setKind(kind);
    setScreen('home');
    showToast(newPending > 0 ? `已记下；新增待核实付款 ${money(newPending)}，稍后逐笔归类` : entries.length === 2 ? '两笔实际入金已记下' : '这笔账已记下');
  } catch (error) { showToast(error.message); }
}

function selectReview(id) {
  const item = fundingCaseById.get(id);
  if (!item || item.pendingCents <= 0) return showToast('这笔付款已经核实完成。');
  selectedReviewId = id;
  renderReview(summarize(book.entries));
  setScreen('review');
  $('#review-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function submitReview(event) {
  event.preventDefault();
  if (!storageReady) return showToast('当前无法安全保存，请先恢复存储。');
  const item = fundingCaseById.get(selectedReviewId);
  if (!item || item.pendingCents <= 0) return showToast('这笔付款已经核实完成，请刷新后查看。');
  try {
    const kind = $('#review-kind').value;
    const amountCents = parseYuan($('#review-amount').value);
    const options = kind === 'funding_to_person' ? { person: $('#review-person').value }
      : kind === 'funding_to_supplier' ? { creditor: $('#review-creditor').value.trim() }
        : { reason: $('#review-reason').value, receiptId: $('#review-reason').value === 'receipt_fixed' ? $('#review-receipt').value : undefined };
    writeBook(resolveFunding(book, selectedReviewId, kind, amountCents, options));
    showToast('已归类并保留核对记录');
  } catch (error) { showToast(error.message); }
}

function submitSettings(event) {
  event.preventDefault();
  if (!storageReady) return showToast('当前无法安全保存，请先恢复存储。');
  try {
    const next = updateSettings(book, {
      plannedPurchaseCents: parseNonnegativeYuan($('#planned-purchase').value),
      reserveCents: parseNonnegativeYuan($('#reserve-amount').value),
      names: { me: $('#my-name').value.trim(), partner: $('#partner-name').value.trim() },
    });
    writeBook(next);
    setScreen('home');
    showToast('计划和称呼已保存');
  } catch (error) { showToast(error.message); }
}

function downloadBlob(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function saveFile(filename, content, mime) {
  if (typeof File !== 'undefined' && navigator.canShare && navigator.share) {
    let file = null;
    try {
      const candidate = new File([content], filename, { type: mime });
      if (navigator.canShare({ files: [candidate] })) file = candidate;
    } catch { /* This browser cannot share this file type; use a download. */ }
    if (file) {
      try {
        await navigator.share({ files: [file], title: filename });
        return 'shared';
      } catch (error) {
        if (error.name === 'AbortError') return 'cancelled';
      }
    }
  }
  downloadBlob(filename, content, mime);
  return 'downloaded';
}

async function exportJson() {
  if (!storageReady) return showToast('当前账本未安全载入，不能导出。');
  try {
    const next = { ...book, lastBackupAt: new Date().toISOString() };
    writeBook(next);
    const result = await saveFile(`二姐小金库_完整备份_${todayLocal()}.json`, JSON.stringify(book, null, 2), 'application/json');
    showToast(result === 'cancelled' ? '已取消分享；账本还没有完成备份' : '备份文件已交给系统，请在手机“文件”中确认保存');
  } catch (error) { showToast(`备份失败：${error.message}`); }
}

function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }

function readRecovery() {
  try {
    const raw = localStorage.getItem(RECOVERY_KEY);
    if (!raw) return null;
    const recovery = JSON.parse(raw);
    if (!Number.isFinite(Date.parse(recovery.savedAt))) return null;
    const migration = normalizeLegacyFundingReviews(recovery.book);
    assertBook(migration.book);
    return { ...recovery, book: migration.book, migrated: migration.changed };
  } catch { return null; }
}

function latestEntryTime(bookToInspect) {
  if (!bookToInspect.entries.length) return '无';
  const latest = bookToInspect.entries.reduce((max, entry) => entry.createdAt > max ? entry.createdAt : max, '');
  return new Date(latest).toLocaleString('zh-CN');
}

async function exportCsv() {
  if (!storageReady) return showToast('当前账本未安全载入，不能导出。');
  const totals = summarize(book.entries);
  const exportedAt = new Date().toLocaleString('zh-CN');
  const heading = ['日期', '类型', '金额（元）', '已售成本（元）', '关联销售编号', '合伙人', '付款或收款去向', '个人退款处理', '供应商', '本笔新增待核实（元）', '当前仍待核实（元）', '归类或核实原因', '关联原付款编号', '关联供应商赊账编号', '关联补录收款编号', '备注', '状态', '录入时间', '作废时间', '记录编号'];
  const rows = [...book.entries].sort(sortNewest);
  const supplementedCosts = new Map(book.entries.filter(entry => entry.kind === 'sale_cost' && !entry.voidedAt).map(entry => [entry.saleId, entry.amountCents]));
  const overview = [
    ['二姐小金库 · 账目摘要'],
    ['导出时间', exportedAt],
    ['累计经营盈亏（元）', totals.pendingCostCount ? `待核算：${totals.pendingCostCount} 笔销售未补成本` : (totals.profitCents / 100).toFixed(2)],
    ['整摊回本差额（经营收入覆盖全部进货及费用，元）', (totals.recoveryCents / 100).toFixed(2)],
    ['累计销售（元）', (totals.salesCents / 100).toFixed(2)],
    ['已售商品成本（元）', (totals.soldCostCents / 100).toFixed(2)],
    ['其他经营费用及报损（元）', ((totals.expensesCents + totals.stockLossCents) / 100).toFixed(2)],
    ['其他经营收入（元）', (totals.otherIncomeCents / 100).toFixed(2)],
    ['金库账面余额（可为负，元）', (totals.cashCents / 100).toFixed(2)],
    ['待核实付款笔数', totals.pendingFundingCount],
    ['待核实付款合计（元）', (totals.pendingFundingCents / 100).toFixed(2)],
    ['欠供应商待付（元）', (totals.supplierPayableCents / 100).toFixed(2)],
    ['累计已确认透支（元）', (totals.confirmedOverdraftCents / 100).toFixed(2)],
    ['未售商品进货成本（元）', totals.pendingCostCount ? '待核算' : (totals.inventoryCents / 100).toFixed(2)],
    [`${personName('me')}正式净出资（元）`, (totals.capitalCents.me / 100).toFixed(2)],
    [`${personName('me')}垫付待报销（元）`, (totals.payableCents.me / 100).toFixed(2)],
    [`${personName('me')}出资及待报销合计（元）`, ((totals.capitalCents.me + totals.payableCents.me) / 100).toFixed(2)],
    [`${personName('partner')}正式净出资（元）`, (totals.capitalCents.partner / 100).toFixed(2)],
    [`${personName('partner')}垫付待报销（元）`, (totals.payableCents.partner / 100).toFixed(2)],
    [`${personName('partner')}出资及待报销合计（元）`, ((totals.capitalCents.partner + totals.payableCents.partner) / 100).toFixed(2)],
    ['代收待转入合计（元）', ((totals.receivableCents.me + totals.receivableCents.partner) / 100).toFixed(2)],
    [],
  ];
  const lines = [...overview, heading, ...rows.map(entry => [
    entry.date, ENTRY_LABELS[entry.kind], (entry.amountCents / 100).toFixed(2),
    entry.kind === 'sale' ? entry.costCents != null ? (entry.costCents / 100).toFixed(2)
      : supplementedCosts.has(entry.id) ? (supplementedCosts.get(entry.id) / 100).toFixed(2)
        : entry.voidedAt ? '' : '待补录' : '',
    entry.saleId ?? '',
    entry.person ? personName(entry.person) : '',
    entry.source === 'treasury' || (entry.kind === 'sale' && entry.source == null) ? '金库' : entry.source === 'supplier_credit' ? '供应商赊账' : entry.source ? `${personName(entry.source)}${entry.kind === 'sale' ? '代收待转入' : entry.kind === 'purchase_refund' ? '收到进货退款' : '个人垫付'}` : '',
    entry.kind === 'purchase_refund' && ['me', 'partner'].includes(entry.source) ? entry.refundDisposition === 'person_receivable' ? '个人代收待转入' : '抵减垫付待报销' : '',
    entry.creditor ?? '', entry.fundingReviewCents ? (entry.fundingReviewCents / 100).toFixed(2) : '',
    fundingCaseById.get(entry.id)?.pendingCents ? (fundingCaseById.get(entry.id).pendingCents / 100).toFixed(2) : '',
    entry.kind === 'funding_confirmed' ? entry.reason === 'receipt_fixed' ? '已补录收款' : '已确认透支' : '',
    entry.targetId ?? '', entry.creditId ?? '', entry.receiptId ?? '',
    entry.note, entry.voidedAt ? '已作废' : '有效', entry.createdAt, entry.voidedAt ?? '', entry.id,
  ])];
  try {
    const result = await saveFile(`二姐小金库_明细_${todayLocal()}.csv`, `\uFEFF${lines.map(row => row.map(csvCell).join(',')).join('\r\n')}`, 'text/csv');
    showToast(result === 'cancelled' ? '已取消分享明细表' : '明细表已交给系统；恢复账本请使用 JSON 完整备份');
  } catch (error) { showToast(`明细表导出失败：${error.message}`); }
}

async function shareSummary() {
  if (!storageReady) return showToast('当前账本未安全载入。');
  const totals = summarize(book.entries);
  const profitText = totals.pendingCostCount ? `待核算（${totals.pendingCostCount} 笔销售未补成本）` : money(totals.profitCents);
  const inventoryText = totals.pendingCostCount ? '待核算' : money(totals.inventoryCents);
  const text = `二姐小金库 · ${todayLocal()}\n累计经营盈亏 ${profitText}\n整摊回本差额 ${money(totals.recoveryCents)}（经营收入覆盖全部净进货和费用；不代表出资已返还）\n累计销售 ${money(totals.salesCents)}｜已售商品成本 ${money(totals.soldCostCents)}\n金库账面余额 ${money(totals.cashCents)}｜未售商品成本 ${inventoryText}\n待核实付款 ${totals.pendingFundingCount} 笔，共 ${money(totals.pendingFundingCents)}｜欠供应商 ${money(totals.supplierPayableCents)}\n个人代收待转入 ${money(totals.receivableCents.me + totals.receivableCents.partner)}\n${personName('me')}：正式出资 ${money(totals.capitalCents.me)}，垫付待报销 ${money(totals.payableCents.me)}，合计 ${money(totals.capitalCents.me + totals.payableCents.me)}\n${personName('partner')}：正式出资 ${money(totals.capitalCents.partner)}，垫付待报销 ${money(totals.payableCents.partner)}，合计 ${money(totals.capitalCents.partner + totals.payableCents.partner)}\n有效记录 ${totals.activeCount} 笔`;
  try {
    if (navigator.share) await navigator.share({ title: '二姐小金库经营账摘要', text });
    else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      showToast('经营账摘要已复制，可以发给合伙人');
    } else window.prompt('复制下面的摘要发给合伙人：', text);
  } catch (error) {
    if (error.name !== 'AbortError') showToast('暂时无法分享，请试试导出明细表。');
  }
}

async function importJson(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const replacingDamagedBook = !storageReady && damagedStorageRaw !== null;
    if (!storageReady && !replacingDamagedBook) throw new Error('当前账本被其他标签页更新或存储不可用，请先刷新核对。');
    if (file.size > 12_000_000) throw new Error('备份文件过大，请检查是否选错文件。');
    const migration = normalizeLegacyFundingReviews(JSON.parse(await file.text()));
    const imported = assertBook(migration.book);
    const totals = summarize(imported.entries);
    const currentText = replacingDamagedBook
      ? '当前：账本数据无法读取，不能自动保留恢复点。请确认已有可用备份。'
      : `当前：${book.entries.length} 笔，最新录入 ${latestEntryTime(book)}`;
    const recoveryText = replacingDamagedBook
      ? '这会覆盖手机里无法读取的原数据。'
      : '继续前会在本机保留当前账本，可从设置撤销这次导入。仍建议另存完整 JSON 备份。';
    const promptText = `将用所选备份替换本机账本：\n${currentText}\n导入：${imported.entries.length} 笔，最新录入 ${latestEntryTime(imported)}，金库余额 ${money(totals.cashCents)}\n${migration.changed ? '旧备份中的金库付款差额将标记为待核实，请导入后逐笔确认。\n' : ''}${recoveryText}`;
    if (!window.confirm(promptText)) return;
    const latestRaw = localStorage.getItem(STORAGE_KEY);
    if (replacingDamagedBook) {
      if (latestRaw !== damagedStorageRaw) throw new Error('另一个标签页已更新账本，请刷新后重新导入。');
      const saved = { ...imported, revision: (imported.revision ?? 0) + 1 };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      book = saved;
      storageReady = true;
      damagedStorageRaw = null;
      $('#storage-warning').hidden = true;
      $('#entry-submit').disabled = false;
      $('#settings-form button[type="submit"]').disabled = false;
      render();
    } else {
      assertCurrentRevision(latestRaw ? assertBook(JSON.parse(latestRaw)) : emptyBook(), book);
      localStorage.setItem(RECOVERY_KEY, JSON.stringify({ savedAt: new Date().toISOString(), book }));
      writeBook(imported);
    }
    setScreen('home');
    showToast(migration.changed ? '旧付款差额已标记待核实，请从首页逐笔核对' : '备份已恢复，请核对余额和明细');
  } catch (error) { showToast(`导入失败：${error.message}`); }
  finally { event.target.value = ''; }
}

function restorePreImport() {
  if (!storageReady) return showToast('请先刷新并核对当前账本。');
  const recovery = readRecovery();
  if (!recovery) return showToast('没有可恢复的上次导入前账本。');
  if (!window.confirm(`确定撤销上次导入，恢复 ${new Date(recovery.savedAt).toLocaleString('zh-CN')} 暂存的 ${recovery.book.entries.length} 笔流水吗？这会替换当前账本；若导入后又记了新账，请先导出当前完整备份。`)) return;
  try {
    writeBook(recovery.book);
    localStorage.removeItem(RECOVERY_KEY);
    renderSettings();
    setScreen('home');
    showToast(recovery.migrated ? '已恢复旧账本，付款差额已标记待核实' : '已恢复导入前的账本，请核对余额');
  } catch (error) { showToast(`恢复失败：${error.message}`); }
}

function handleVoid(id) {
  if (!storageReady) return;
  const entry = book.entries.find(item => item.id === id);
  if (!entry) return;
  if (!window.confirm(`确定作废 ${ENTRY_LABELS[entry.kind]} ${money(entry.amountCents)} 吗？原记录仍会保留在明细中。`)) return;
  try {
    writeBook(voidEntry(book, id));
    showToast('已作废；需要更正时请重新记一笔');
  } catch (error) { showToast(`不能作废：${error.message}`); }
}

function bindEvents() {
  window.addEventListener('storage', event => {
    if (event.key !== STORAGE_KEY) return;
    storageReady = false;
    damagedStorageRaw = null;
    const warning = $('#storage-warning');
    warning.hidden = false;
    warning.textContent = '账本已在另一个标签页更新。请刷新此页并核对最新余额，然后再继续录入；此页尚未保存的内容不会自动合并。';
    $('#entry-submit').disabled = true;
    $('#settings-form button[type="submit"]').disabled = true;
  });
  document.addEventListener('click', event => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      if (nav.dataset.historyFilter) {
        $('#history-filter').value = nav.dataset.historyFilter;
        renderHistory(summarize(book.entries));
      }
      setScreen(nav.dataset.nav);
    }
    const quick = event.target.closest('[data-entry-kind]');
    if (quick) { setKind(quick.dataset.entryKind); setScreen('entry'); }
    const fillCost = event.target.closest('[data-fill-cost-id]');
    if (fillCost) {
      setKind('sale_cost');
      $('#sale-cost-sale').value = fillCost.dataset.fillCostId;
      setScreen('entry');
    }
    const reviewButton = event.target.closest('[data-review-id]');
    if (reviewButton) selectReview(reviewButton.dataset.reviewId);
    const kindButton = event.target.closest('[data-kind]');
    if (kindButton) setKind(kindButton.dataset.kind);
    const voidButton = event.target.closest('[data-void-id]');
    if (voidButton) handleVoid(voidButton.dataset.voidId);
  });
  $$('input[name="depositMode"]').forEach(input => input.addEventListener('change', updateDepositMode));
  $('#sale-cost-later').addEventListener('change', toggleSaleCostInput);
  $('#entry-source').addEventListener('change', () => { renderRefundCreditOptions(); updateEntrySourceFields(); });
  $('#supplier-payment-source').addEventListener('change', updateEntrySourceFields);
  $('#entry-amount').addEventListener('input', updateEntrySourceFields);
  $('#review-kind').addEventListener('change', updateReviewFields);
  $('#review-reason').addEventListener('change', updateReviewFields);
  $('#review-receipt').addEventListener('change', updateReviewFields);
  $('#more-kind').addEventListener('change', event => { if (event.target.value) setKind(event.target.value); });
  $('#entry-form').addEventListener('submit', submitEntry);
  $('#review-form').addEventListener('submit', submitReview);
  $('#settings-form').addEventListener('submit', submitSettings);
  $('#history-filter').addEventListener('change', () => renderHistory(summarize(book.entries)));
  $('#quick-backup').addEventListener('click', exportJson);
  $('#export-json').addEventListener('click', exportJson);
  $('#export-csv').addEventListener('click', exportCsv);
  $('#share-summary').addEventListener('click', shareSummary);
  $('#import-file').addEventListener('change', importJson);
  $('#restore-pre-import').addEventListener('click', restorePreImport);
}

$('#entry-date').value = todayLocal();
bindEvents();
loadBook();
setKind('deposit');
toggleSaleCostInput();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
