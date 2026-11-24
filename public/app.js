const state = {
  view: null,
  selectedTraveller: null,
  busy: false,
};

const $ = (selector) => document.querySelector(selector);

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[character]);

const bucketLabel = { handover: '可交接', hold: '待确认', manual: '必须人工处理' };

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `请求失败（${response.status}）`);
  return body;
}

function setStatus(text, bad = false) {
  const node = $('#status');
  node.textContent = text;
  node.style.color = bad ? 'var(--manual)' : '';
}

function renderOverview(view) {
  const { workbench, model } = view;
  const counts = workbench.counts;
  const metrics = [
    { value: counts.handover, label: '可交接（件）', cls: '' },
    { value: counts.hold, label: '待确认（件）', cls: 'warn' },
    { value: counts.manual, label: '必须人工处理（件）', cls: 'bad' },
    { value: counts.claimed, label: '已认领指令', cls: '' },
    { value: counts.unclaimed, label: '待认领（交接班）', cls: counts.unclaimed ? 'warn' : '' },
    { value: counts.carriedOver, label: '跨班次按原操作人跟踪', cls: '' },
  ];
  const notices = (workbench.warnings ?? []).map((warning) => `<li>${escapeHtml(warning)}</li>`).join('');
  $('#overview').innerHTML = `
    <div class="metric ${counts.manual ? 'bad' : ''}">
      <strong>${escapeHtml(workbench.shift || '未识别班次')}</strong>
      <span>${escapeHtml(workbench.replaces ? `接替 ${workbench.replaces} · ${workbench.handoverAt || '时间待核'}` : '当前班次')}</span>
    </div>
    ${metrics.map((item) => `<div class="metric ${item.cls}"><strong>${item.value}</strong><span>${escapeHtml(item.label)}</span></div>`).join('')}
    ${model.collection?.errors?.length ? `<p class="notice">来源读取错误：${model.collection.errors.map((error) => escapeHtml(error.source + ': ' + error.message)).join('；')}</p>` : ''}
    ${notices ? `<ul class="notice">${notices}</ul>` : ''}
  `;
}

function renderTravellers(view) {
  const { workbench } = view;
  if (!workbench.travellers.length) {
    $('#travellers').innerHTML = '<p class="empty">还没有可核对的旅客资料。</p>';
    return;
  }
  if (!state.selectedTraveller || !workbench.travellers.some((item) => item.traveller === state.selectedTraveller)) {
    state.selectedTraveller = workbench.travellers[0].traveller;
  }
  $('#travellers').innerHTML = workbench.travellers.map((item) => `
    <button class="traveller" data-traveller="${escapeHtml(item.traveller)}" aria-selected="${item.traveller === state.selectedTraveller}">
      <div><strong>${escapeHtml(item.traveller)}</strong></div>
      <div class="meta">${escapeHtml(item.summary)}</div>
      <div class="meta">可交接 ${item.counts.handover} · 待确认 ${item.counts.hold} · 人工 ${item.counts.manual}</div>
    </button>
  `).join('');
  for (const button of document.querySelectorAll('.traveller')) {
    button.addEventListener('click', () => {
      state.selectedTraveller = button.dataset.traveller;
      render();
    });
  }
}

function pieceClass(piece) {
  return piece.bucket;
}

function renderEvidence(piece) {
  const items = piece.evidence.items.map((item) => `
    <li class="${item.ok ? 'ok' : 'miss'}">
      <span class="k">${escapeHtml(item.label)}</span>
      <span>${item.ok ? '' : '缺 · '}${escapeHtml(item.value)}${item.batch ? ` · 批 ${escapeHtml(item.batch)}` : ''}${item.page ? ` · 页 ${escapeHtml(item.page)}` : ''}</span>
    </li>
  `).join('');
  return `<ul class="kv">${items}</ul>`;
}
function renderTimeline(piece) {
  const items = piece.commands.map((entry) => `
    <li class="${escapeHtml(entry.phase ?? '')}">
      <div>${escapeHtml(labelForCommand(entry))} ${entry.owner ? `· ${escapeHtml(entry.owner)}` : ''}</div>
      <div class="when">${escapeHtml(entry.at || '时间未记录')}${entry.seen ? ` · 采集 ${escapeHtml(entry.seen)}` : ''} · ${escapeHtml(entry.source)}</div>
      <div class="note">${escapeHtml(entry.note)}</div>
    </li>
  `).join('');
  return `<ul class="timeline">${items}</ul>`;
}

function describeReliedOn(reliedOn) {
  if (!reliedOn) return '无';
  const parts = [];
  if (reliedOn.ticket) parts.push(`票务 ${reliedOn.ticket.transfer} 旧票 ${reliedOn.ticket.old || '—'} 新票 ${reliedOn.ticket.new || '—'}`);
  if (reliedOn.receipt) parts.push(`受理批 ${reliedOn.receipt.batch || '—'} 原条码 ${reliedOn.receipt.oldTag || '—'} 新条码 ${reliedOn.receipt.newTag || '未给'} ${reliedOn.receipt.accepted ? '已签收' : '拒收'} @ ${reliedOn.receipt.at || '时间缺'}`);
  if (reliedOn.fact) parts.push(`双边 ${reliedOn.fact.kind} ${reliedOn.fact.from || '—'}→${reliedOn.fact.to || '—'} @ ${reliedOn.fact.at || '时间缺'}`);
  if (reliedOn.pass) parts.push(`票务链 ${reliedOn.pass.transfer} ${reliedOn.pass.state}`);
  if (!parts.length && Array.isArray(reliedOn.evidence)) {
    return reliedOn.evidence.map((item) => `${item.label}:${item.ok ? item.value : '缺'}`).join('；');
  }
  return parts.join('；') || '无';
}

function labelForCommand(entry) {
  const map = {
    ticket: '票务签转',
    withdraw: '票务撤销签转',
    handover: entry.source === 'receiving' ? '新航司逐件签收' : '交接/转交指令',
    reject: '新航司拒收',
    return: '双边确认退接',
    blocked: '装机扫描 · 自动依据停止',
    'stale-handoff': '旧分拣点补传待交运记录',
    pending: '尚未取得资料',
  };
  return map[entry.kind] ?? entry.kind;
}

function renderPiece(piece) {
  const claim = piece.claim;
  const claimActions = piece.status === 'handover'
    ? `<button class="primary" data-action="claim" data-code="${escapeHtml(piece.id)}">认领交接指令</button>`
    : '';
  const ownerActions = claim && claim.state === 'claimed'
    ? `
      <button data-action="release" data-code="${escapeHtml(piece.id)}">释放认领</button>
      <button data-action="reassign" data-code="${escapeHtml(piece.id)}">双方转交</button>
      <button data-action="resolve" data-code="${escapeHtml(piece.id)}">有现场凭据，结案</button>
    `
    : '';
  const actions = [
    ...piece.actions.map((item) => `<span class="chip">${escapeHtml(item.label)}${item.team ? '：' + escapeHtml(item.team) : ''}</span>`),
  ].join('');
  return `
    <article class="piece" data-piece="${escapeHtml(piece.id)}">
      <div class="piece-head">
        <span class="tag">${escapeHtml(piece.tag)}</span>
        <span class="chip ${pieceClass(piece)}">${escapeHtml(piece.statusLabel)}</span>
        <span class="chip">${escapeHtml(piece.chain || '未关联交运链')}</span>
        ${piece.segment ? `<span class="chip">${escapeHtml(piece.segment)}</span>` : ''}
        <span class="muted">${escapeHtml(piece.reason)}</span>
      </div>
      <div class="piece-body">
        <div class="grid2">
          <div class="block">
            <h3>证据</h3>
            ${renderEvidence(piece)}
            ${piece.missingEvidence.length ? `<p class="note miss">缺：${piece.missingEvidence.map(escapeHtml).join('；')}</p>` : ''}
          </div>
          <div class="block">
            <h3>本次交运</h3>
            <ul class="kv">
              <li><span class="k">交运链</span><span>${escapeHtml(piece.chain || '未关联')}</span></li>
              <li><span class="k">票务</span><span>${escapeHtml(piece.ticket ? `${piece.ticket.old || '—'} → ${piece.ticket.new || '—'}（${piece.ticket.transfer}）` : '无签转记录')}</span></li>
              <li><span class="k">受理批</span><span>${escapeHtml(piece.receipt ? `${piece.receipt.batch} · ${piece.receipt.accepted ? '已签收' : '拒收'} · ${piece.receipt.newTag || '未给新条码'}` : '未读到')}</span></li>
              <li><span class="k">撤销</span><span>${piece.withdrawn ? `${escapeHtml(piece.withdrawn.state)} @ ${escapeHtml(piece.withdrawn.at)}` : '无'}</span></li>
              <li><span class="k">谁接</span><span>${escapeHtml(piece.command?.assignee || '尚无可依据的接手指派')}</span></li>
              <li><span class="k">下一联系</span><span>${escapeHtml(piece.nextContact || '待班次资料')}</span></li>
            </ul>
          </div>
        </div>
        <div class="grid2">
          <div class="block">
            <h3>指令与资料（含已撤销/已认领）</h3>
            ${renderTimeline(piece)}
          </div>
          <div class="block">
            <h3>认领</h3>
            ${claim ? `
              <ul class="kv">
                <li><span class="k">状态</span><span>${escapeHtml(claim.state)} · 班次 ${escapeHtml(claim.shift)}</span></li>
                <li><span class="k">操作人</span><span>${escapeHtml(claim.operator)}</span></li>
                <li><span class="k">认领时间</span><span>${escapeHtml(claim.claimedAt)}</span></li>
                <li><span class="k">现场凭据</span><span>${claim.physicalEvidence ? '已登记' : '尚无（不能仅凭票务结案）'}</span></li>
                <li><span class="k">说明</span><span>${escapeHtml(piece.claimNote)}</span></li>
              </ul>` : `<p class="note">${escapeHtml(piece.claimNote || '本件当前没有可认领的指令。')}</p>`}
            <div class="actions">${claimActions}${ownerActions}</div>
            ${claim ? `<ul class="kv">
                <li><span class="k">依赖资料</span><span class="note">${escapeHtml(describeReliedOn(claim.reliedOn))}</span></li>
              </ul>` : ''}
          </div>
        </div>
        <div class="block">
          <h3>处置</h3>
          <div class="actions">${actions || '<span class="note">无自动处置，按现场流程联系。</span>'}</div>
        </div>
      </div>
    </article>
  `;
}

function renderDetail(view) {
  const traveller = view.workbench.travellers.find((item) => item.traveller === state.selectedTraveller);
  if (!traveller) {
    $('#detail').innerHTML = '<p class="empty">选择左侧旅客查看逐件交运凭据。</p>';
    return;
  }
  $('#detail').innerHTML = `
    <div class="traveller-head">
      <div>
        <h2>${escapeHtml(traveller.traveller)}</h2>
        <p class="muted">交运链 ${escapeHtml(traveller.chains.join('、') || '未关联')} · 联系人 ${escapeHtml(traveller.contacts.join(' / ') || '待班次资料')}</p>
      </div>
      <div class="chips">
        <span class="chip handover">可交接 ${traveller.counts.handover}</span>
        <span class="chip hold">待确认 ${traveller.counts.hold}</span>
        <span class="chip manual">必须人工 ${traveller.counts.manual}</span>
      </div>
    </div>
    ${traveller.pieces.map(renderPiece).join('') || '<p class="empty">该旅客还没有逐件资料。</p>'}
  `;
  for (const button of document.querySelectorAll('[data-action]')) {
    button.addEventListener('click', () => handleClaimAction(button.dataset.action, button.dataset.code));
  }
}

function renderClaims(view) {
  const claims = view.workbench.claims ?? [];
  const carried = view.workbench.carryOver;
  const carryHtml = carried
    ? `<p class="note">${escapeHtml(carried.note)}</p>
       <div class="claims">
         <div class="claim"><div class="row"><strong>待认领</strong><span class="chip hold">${carried.unclaimed.length}</span></div>
           ${carried.unclaimed.map((item) => `<div class="note">${escapeHtml(item.id)} · ${escapeHtml(item.statusLabel)} · 下一联系 ${escapeHtml(item.nextContact || '待定')}</div>`).join('') || '<div class="note">无</div>'}
         </div>
         <div class="claim"><div class="row"><strong>已认领（按原操作人跟踪）</strong><span class="chip">${carried.claimed.length}</span></div>
           ${carried.claimed.map((item) => `<div class="note">${escapeHtml(item.id)} · ${escapeHtml(item.shift)}/${escapeHtml(item.operator)} · ${escapeHtml(item.reason)}</div>`).join('') || '<div class="note">无</div>'}
         </div>
       </div>`
    : '';
  $('#claims').innerHTML = `
    ${carryHtml}
    <div class="claims">
      ${claims.map((claim) => `
        <div class="claim">
          <div class="row"><strong>${escapeHtml(claim.code)}</strong><span class="chip">${escapeHtml(claim.status)}</span><span class="muted">${escapeHtml(claim.shift)}/${escapeHtml(claim.operator)}</span></div>
          <div class="note">认领 ${escapeHtml(claim.claimedAt)}${claim.resolvedAt ? ` · 结案 ${escapeHtml(claim.resolvedAt)}` : ''} · 依赖 ${escapeHtml(claim.reliedOn?.receipt ? '受理批 ' + claim.reliedOn.receipt.batch : claim.reliedOn?.pass ? '票务 ' + claim.reliedOn.pass.transfer : '')}</div>
        </div>
      `).join('') || '<p class="note">还没有认领记录。</p>'}
    </div>`;
}

function render() {
  if (!state.view) return;
  renderOverview(state.view);
  renderTravellers(state.view);
  renderDetail(state.view);
  renderClaims(state.view);
}

async function load() {
  if (state.busy) return;
  state.busy = true;
  setStatus('采集中…');
  try {
    state.view = await api('/api/view');
    setStatus(`采集完成 ${new Date(state.view.model.collection.finishedAt).toLocaleTimeString()}`);
    render();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    state.busy = false;
  }
}

function promptOperator(shift) {
  const operator = window.prompt('经办人工号');
  if (!operator) return null;
  const currentShift = shift ?? window.prompt('班次', state.view?.workbench?.shift ?? '');
  return { operator, shift: currentShift };
}

async function handleClaimAction(action, code) {
  const shift = state.view?.workbench?.shift ?? '';
  try {
    if (action === 'claim') {
      if (!shift) {
        alert('还没有读到班次资料，不能认领；请先确认当前班次。');
        return;
      }
      const who = promptOperator(shift);
      if (!who) return;
      const piece = state.view.model.pieces.find((item) => item.id === code);
      await api('/api/claims', { method: 'POST', body: JSON.stringify({ code, chain: piece?.chain, shift: who.shift, operator: who.operator }) });
    } else if (action === 'release') {
      const operator = window.prompt('原认领人工号');
      if (!operator) return;
      await api('/api/claims/release', { method: 'POST', body: JSON.stringify({ code, operator }) });
    } else if (action === 'reassign') {
      const from = window.prompt('转出人（当前认领人）');
      const to = window.prompt('转交人');
      if (!from || !to) return;
      const acceptedBy = window.prompt('双方确认人（逗号分隔）', `${from},${to}`);
      if (!acceptedBy) return;
      await api('/api/claims/reassign', {
        method: 'POST',
        body: JSON.stringify({ code, operator: from, from, to, acceptedBy: acceptedBy.split(',').map((item) => item.trim()).filter(Boolean) }),
      });
    } else if (action === 'resolve') {
      const operator = window.prompt('认领人工号');
      if (!operator) return;
      await api('/api/claims/resolve', { method: 'POST', body: JSON.stringify({ code, operator }) });
    }
    await load();
  } catch (error) {
    alert(error.message);
  }
}

$('#refresh').addEventListener('click', load);

$('#fact-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());
  payload.acceptedBy = String(payload.acceptedBy ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  for (const key of ['at', 'operator', 'shift']) if (!payload[key]) delete payload[key];
  try {
    const result = await api('/api/facts', { method: 'POST', body: JSON.stringify(payload) });
    $('#fact-status').textContent = result.created ? '已登记双边事实，重新采集后生效。' : '相同的双边事实已存在。';
    await load();
  } catch (error) {
    $('#fact-status').textContent = error.message;
  }
});

load();
