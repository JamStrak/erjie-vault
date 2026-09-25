import {
  STORAGE_KEY, ENTRY_LABELS, PEOPLE, addEntries, assertBook, assertCurrentRevision, emptyBook, entryCashDelta,
  fundingPlan, money, newEntry, parseNonnegativeYuan, parseYuan, summarize,
  todayLocal, updateSettings, voidEntry,
} from './ledger.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const screens = ['home', 'entry', 'history', 'settings'];
const advancedKinds = new Set(['other_income', 'sale_transfer', 'reimbursement', 'convert_advance', 'return_capital']);
const RECOVERY_KEY = 'erjie-vault-before-import-v1';
let book = emptyBook();
let storageReady = false;
let damagedStorageRaw = null;
let toastTimer;

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
  const latest = latestRaw ? assertBook(JSON.parse(latestRaw)) : emptyBook();
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
    const loaded = raw ? assertBook(JSON.parse(raw)) : emptyBook();
    if (!raw) localStorage.setItem(STORAGE_KEY, JSON.stringify(loaded));
    book = loaded;
    storageReady = true;
    damagedStorageRaw = null;
    $('#storage-warning').hidden = true;
    $('#entry-submit').disabled = false;
    $('#settings-form button[type="submit"]').disabled = false;
    render();
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
function compactMoney(cents) { return money(cents); }

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
  $('#cash-balance').textContent = money(totals.cashCents);
  $('#sales-total').textContent = money(totals.salesCents);
  $('#purchase-total').textContent = money(totals.purchaseCents);
  $('#cash-caption').textContent = totals.activeCount ? `${totals.activeCount} 笔有效记录 · 每笔都算得清楚` : '记录第一笔入金，开始记账';
  $('#me-label').textContent = personName('me');
  $('#partner-label').textContent = personName('partner');
  $('#me-capital').textContent = money(totals.capitalCents.me);
  $('#partner-capital').textContent = money(totals.capitalCents.partner);
  const combined = totals.capitalCents.me + totals.capitalCents.partner;
  const mePercent = combined ? totals.capitalCents.me / combined * 100 : 50;
  $('#me-bar').style.width = `${mePercent}%`;
  $('#partner-bar').style.width = `${100 - mePercent}%`;
  $('#parity-note').textContent = plan.equalizeCents
    ? `${personName(plan.lower)}实际出资少 ${money(plan.equalizeCents)}。等这笔钱真的存入金库后，再记录入金，就能追平五五。`
    : '目前两人实际出资相同。';

  const needCash = plan.cashGapCents > 0;
  const status = $('#funding-status');
  status.textContent = plan.afterTransferGapCents > 0 ? '需要补钱' : needCash ? '先转入代收' : plan.equalizeCents ? '出资待追平' : '现金够用';
  status.classList.toggle('needs-money', plan.afterTransferGapCents > 0);
  const planned = book.settings.plannedPurchaseCents;
  const reserve = book.settings.reserveCents;
  if (plan.targetCents === 0) {
    $('#funding-explain').textContent = '设置下次计划进货和备用金后，这里会告诉你金库够不够。';
  } else if (needCash) {
    const targetText = `下次进货 ${money(planned)}、备用金 ${money(reserve)}${plan.payableTotalCents ? `、待报销 ${money(plan.payableTotalCents)}` : ''}。`;
    const transferText = plan.suggestedTransferCents
      ? `当前现金差 ${money(plan.cashGapCents)}；先让代收的 ${money(plan.suggestedTransferCents)} 实际转入金库，转入后还差 ${money(plan.afterTransferGapCents)}。`
      : `当前金库还差 ${money(plan.cashGapCents)}。`;
    $('#funding-explain').textContent = `${targetText}${transferText}下面的入金建议按先转入代收款、再追平五五出资计算。`;
  } else {
    $('#funding-explain').textContent = `当前金库现金可覆盖计划进货 ${money(planned)}、备用金 ${money(reserve)}${plan.payableTotalCents ? `及待报销 ${money(plan.payableTotalCents)}` : ''}，预计还剩 ${money(totals.cashCents - plan.targetCents)}。${plan.equalizeCents ? '但两人的实际出资还未追平。' : '暂时不必为了这次计划再入金。'}`;
  }
  $('#me-due-label').textContent = `${personName('me')}建议再存`;
  $('#partner-due-label').textContent = `${personName('partner')}建议再存`;
  $('#me-due').textContent = money(plan.dueCents.me);
  $('#partner-due').textContent = money(plan.dueCents.partner);
  const payable = $('#payable-note');
  payable.hidden = plan.payableTotalCents === 0;
  payable.textContent = `待报销：${personName('me')} ${money(totals.payableCents.me)}，${personName('partner')} ${money(totals.payableCents.partner)}。这笔待支付的钱已算入资金需求。`;
  const receivable = $('#receivable-note');
  receivable.hidden = plan.receivableTotalCents === 0;
  receivable.textContent = `代收但还没转入金库的销售款：${personName('me')} ${money(totals.receivableCents.me)}，${personName('partner')} ${money(totals.receivableCents.partner)}。这笔钱暂未计入可用余额，转入后再登记。`;
  const active = book.entries.filter(item => !item.voidedAt).sort(sortNewest);
  $('#recent-list').innerHTML = active.length
    ? active.slice(0, 4).map(entry => entryHtml(entry, false)).join('')
    : '<div class="empty-state"><b>✦</b>这里还空着。<br>记下第一笔真实入金，账本就开始了。</div>';
}

function sortNewest(a, b) { return b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt); }

function entryHtml(entry, detailed) {
  const change = entryCashDelta(entry);
  const tone = change > 0 ? 'inflow' : change < 0 ? 'outflow' : 'neutral';
  let title = ENTRY_LABELS[entry.kind];
  let subtitle = shortDate(entry.date);
  if (entry.kind === 'deposit') title = `${personName(entry.person)}入金`;
  if (['purchase', 'expense'].includes(entry.kind)) {
    subtitle += ` · ${entry.source === 'treasury' ? '金库付款' : `${personName(entry.source)}个人垫付`}`;
  } else if (entry.kind === 'sale') {
    subtitle += ` · ${entry.source == null || entry.source === 'treasury' ? '已入金库' : `${personName(entry.source)}代收待转入`}`;
  } else if (['sale_transfer', 'reimbursement', 'convert_advance', 'return_capital'].includes(entry.kind)) {
    subtitle += ` · ${personName(entry.person)}`;
  }
  if (entry.voidedAt) subtitle += ' · 已作废';
  const amountText = `${change > 0 ? '+' : change < 0 ? '−' : ''}${money(entry.amountCents)}`;
  const symbol = change > 0 ? '＋' : change < 0 ? '−' : '◇';
  return `<article class="entry-row ${tone}${entry.voidedAt ? ' is-voided' : ''}">
    <span class="entry-icon" aria-hidden="true">${symbol}</span>
    <div class="entry-main"><div class="entry-line"><span class="entry-title">${escapeHtml(title)}</span><strong class="entry-amount">${amountText}</strong></div>
      <div class="entry-meta">${escapeHtml(subtitle)}</div>${entry.note ? `<div class="entry-note">${escapeHtml(entry.note)}</div>` : ''}
      ${detailed && !entry.voidedAt ? `<button type="button" class="void-button" data-void-id="${escapeHtml(entry.id)}">记错了？作废这笔</button>` : ''}
    </div></article>`;
}

function renderHistory(totals) {
  $('#history-balance').textContent = money(totals.cashCents);
  $('#history-count').textContent = `${totals.activeCount} 笔有效记录 · ${book.entries.length - totals.activeCount} 笔作废`;
  const filter = $('#history-filter').value;
  const filtered = book.entries.filter(entry => {
    if (filter === 'all') return true;
    if (filter === 'voided') return Boolean(entry.voidedAt);
    if (filter === 'other') return advancedKinds.has(entry.kind);
    return entry.kind === filter;
  }).sort(sortNewest);
  const visible = filtered.slice(0, 250);
  $('#history-list').innerHTML = visible.length
    ? visible.map(entry => entryHtml(entry, true)).join('') + (filtered.length > visible.length ? `<p class="field-help">这里只显示最近 250 笔；导出明细表可查看全部 ${filtered.length} 笔。</p>` : '')
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
  for (const id of ['#entry-person', '#entry-target-person']) {
    const select = $(id);
    const previous = select.value;
    select.innerHTML = personOptions;
    if (PEOPLE.includes(previous)) select.value = previous;
  }
  $('#entry-source').querySelector('[value="me"]').textContent = `${personName('me')}个人垫付`;
  $('#entry-source').querySelector('[value="partner"]').textContent = `${personName('partner')}个人垫付`;
  $('#sale-source').querySelector('[value="me"]').textContent = `${personName('me')}先代收，还没转入金库`;
  $('#sale-source').querySelector('[value="partner"]').textContent = `${personName('partner')}先代收，还没转入金库`;
}

function render() {
  const totals = summarize(book.entries);
  renderHome(totals, fundingPlan(book));
  renderHistory(totals);
  renderSettings();
}

function setKind(kind) {
  if (!ENTRY_LABELS[kind]) return;
  $('#entry-kind').value = kind;
  $$('.kind-tab').forEach(button => button.classList.toggle('is-selected', button.dataset.kind === kind));
  $('#more-kind').value = advancedKinds.has(kind) ? kind : '';
  $('#deposit-fields').hidden = kind !== 'deposit';
  $('#source-fields').hidden = !['purchase', 'expense'].includes(kind);
  $('#sale-fields').hidden = kind !== 'sale';
  $('#person-fields').hidden = !['sale_transfer', 'reimbursement', 'convert_advance', 'return_capital'].includes(kind);
  const labels = {
    deposit: '这次实际存入多少？', purchase: '这次进货花了多少？', sale: '这次实际卖了多少？',
    expense: '这次实际支出多少？', other_income: '这次实际收到多少？',
    sale_transfer: '这次实际转入金库多少？',
    reimbursement: '这次已报销多少？', convert_advance: '这次转为出资多少？', return_capital: '这次实际返还多少？',
  };
  const hints = {
    deposit: '只记已经收到的钱；对方入金不会自动算作你的入金。',
    purchase: '金库付款会减少现金；个人垫付只增加待报销，不算已入金。',
    sale: '销售款如果先进入某人的个人收款码，请选“代收”；尚未转入前，不能算成金库可用余额。',
    expense: '例如摊位物料、运费和包装；个人垫付会成为待报销。',
    other_income: '例如金库收到的进货退款；不要把合伙人出资记在这里。',
    sale_transfer: '个人代收的销售款实际进入金库时再记；不能超过该人当前待转入金额。',
    reimbursement: '从金库实际付给垫付人的钱。不能超过金库现金或该人的待报销金额。',
    convert_advance: '双方决定不再报销这笔垫付时，才转为该人的实际出资；金库现金不变。',
    return_capital: '从金库实际退给合伙人的出资，金库和该人的累计净出资会同时减少。',
  };
  $('#amount-label').textContent = labels[kind];
  $('#entry-hint').textContent = hints[kind];
  $('#entry-submit').textContent = `保存这笔${ENTRY_LABELS[kind]}`;
  $('#person-help').textContent = hints[kind];
  updateDepositMode();
}

function updateDepositMode() {
  const paired = $('input[name="depositMode"]:checked').value === 'paired';
  $('#single-depositor').hidden = paired;
  $('#paired-confirm-row').hidden = !paired;
  if (!paired) $('#paired-confirm').checked = false;
}

function submitEntry(event) {
  event.preventDefault();
  if (!storageReady) return showToast('当前无法安全保存，请先恢复存储。');
  try {
    const kind = $('#entry-kind').value;
    const amountCents = parseYuan($('#entry-amount').value);
    const date = $('#entry-date').value;
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
      const source = ['purchase', 'expense'].includes(kind) ? $('#entry-source').value : kind === 'sale' ? $('#sale-source').value : null;
      entries = [newEntry(kind, amountCents, { person, source, date, note })];
    }
    writeBook(addEntries(book, entries));
    $('#entry-form').reset();
    $('#entry-date').value = todayLocal();
    setKind(kind);
    setScreen('home');
    showToast(entries.length === 2 ? '两笔实际入金已记下' : '这笔账已记下');
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
    const result = await saveFile(`二姐小金库_完整备份_${todayLocal()}.json`, JSON.stringify(book, null, 2), 'application/json;charset=utf-8');
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
    assertBook(recovery.book);
    return recovery;
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
  const heading = ['日期', '类型', '金额（元）', '合伙人', '付款或收款去向', '备注', '状态', '录入时间', '作废时间', '记录编号'];
  const rows = [...book.entries].sort(sortNewest);
  const overview = [
    ['二姐小金库 · 账目摘要'],
    ['导出时间', exportedAt],
    ['金库可用余额（元）', (totals.cashCents / 100).toFixed(2)],
    [`${personName('me')}累计净出资（元）`, (totals.capitalCents.me / 100).toFixed(2)],
    [`${personName('partner')}累计净出资（元）`, (totals.capitalCents.partner / 100).toFixed(2)],
    ['待报销合计（元）', ((totals.payableCents.me + totals.payableCents.partner) / 100).toFixed(2)],
    ['代收待转入合计（元）', ((totals.receivableCents.me + totals.receivableCents.partner) / 100).toFixed(2)],
    [],
  ];
  const lines = [...overview, heading, ...rows.map(entry => [
    entry.date, ENTRY_LABELS[entry.kind], (entry.amountCents / 100).toFixed(2),
    entry.person ? personName(entry.person) : '',
    entry.source === 'treasury' || (entry.kind === 'sale' && entry.source == null) ? '金库' : entry.source ? `${personName(entry.source)}${entry.kind === 'sale' ? '代收待转入' : '个人垫付'}` : '',
    entry.note, entry.voidedAt ? '已作废' : '有效', entry.createdAt, entry.voidedAt ?? '', entry.id,
  ])];
  try {
    const result = await saveFile(`二姐小金库_明细_${todayLocal()}.csv`, `\uFEFF${lines.map(row => row.map(csvCell).join(',')).join('\r\n')}`, 'text/csv;charset=utf-8');
    showToast(result === 'cancelled' ? '已取消分享明细表' : '明细表已交给系统；恢复账本请使用 JSON 完整备份');
  } catch (error) { showToast(`明细表导出失败：${error.message}`); }
}

async function shareSummary() {
  if (!storageReady) return showToast('当前账本未安全载入。');
  const totals = summarize(book.entries);
  const text = `二姐小金库 · ${todayLocal()}\n金库可用余额 ${money(totals.cashCents)}\n${personName('me')}累计净出资 ${money(totals.capitalCents.me)}\n${personName('partner')}累计净出资 ${money(totals.capitalCents.partner)}\n待报销合计 ${money(totals.payableCents.me + totals.payableCents.partner)}\n代收待转入 ${money(totals.receivableCents.me + totals.receivableCents.partner)}\n有效记录 ${totals.activeCount} 笔`;
  try {
    if (navigator.share) await navigator.share({ title: '二姐小金库余额摘要', text });
    else if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      showToast('余额摘要已复制，可以发给合伙人');
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
    const imported = assertBook(JSON.parse(await file.text()));
    const totals = summarize(imported.entries);
    const currentText = replacingDamagedBook
      ? '当前：账本数据无法读取，不能自动保留恢复点。请确认已有可用备份。'
      : `当前：${book.entries.length} 笔，最新录入 ${latestEntryTime(book)}`;
    const recoveryText = replacingDamagedBook
      ? '这会覆盖手机里无法读取的原数据。'
      : '继续前会在本机保留当前账本，可从设置撤销这次导入。仍建议另存完整 JSON 备份。';
    const promptText = `将用所选备份替换本机账本：\n${currentText}\n导入：${imported.entries.length} 笔，最新录入 ${latestEntryTime(imported)}，金库余额 ${money(totals.cashCents)}\n${recoveryText}`;
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
    showToast('备份已恢复，请核对余额和明细');
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
    showToast('已恢复导入前的账本，请核对余额');
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
    if (nav) setScreen(nav.dataset.nav);
    const quick = event.target.closest('[data-entry-kind]');
    if (quick) { setKind(quick.dataset.entryKind); setScreen('entry'); }
    const kindButton = event.target.closest('[data-kind]');
    if (kindButton) setKind(kindButton.dataset.kind);
    const voidButton = event.target.closest('[data-void-id]');
    if (voidButton) handleVoid(voidButton.dataset.voidId);
  });
  $$('input[name="depositMode"]').forEach(input => input.addEventListener('change', updateDepositMode));
  $('#more-kind').addEventListener('change', event => { if (event.target.value) setKind(event.target.value); });
  $('#entry-form').addEventListener('submit', submitEntry);
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
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
