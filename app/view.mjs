// Server-rendered workbench. Deliberately dependency-free and read-mostly: forms post to the
// instruction ledger, never to booking or loading systems.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

const STATUS_CLASS = {
  可交接: 'ready',
  待确认: 'check',
  必须人工处理: 'manual',
};

function statusChip(status) {
  return `<span class="chip ${STATUS_CLASS[status] ?? 'unknown'}">${esc(status)}</span>`;
}

function holderText(holder) {
  if (!holder) return '未知';
  const side = holder.side === 'old' ? '原航司' : holder.side === 'new' ? '新航司' : '位置未定';
  const carrier = holder.carrier ?? '';
  const team = holder.team ? ` / ${holder.team}` : '';
  const shift = holder.shift ? `（${holder.shift} 班）` : '';
  return `${side} ${carrier}${team}${shift}`;
}

function list(items, render) {
  if (!items || items.length === 0) return '<p class="muted">无</p>';
  return `<ul>${items.map((item) => `<li>${render(item)}</li>`).join('')}</ul>`;
}

function bagCard(bag, instruction, history = []) {
  const reasons = bag.reasons.map((entry) => `<li class="reason ${STATUS_CLASS[entry.severity]}">${esc(entry.text)}</li>`).join('');
  const gaps = bag.gaps.map((entry) => `<li><b>${esc(entry.source)}</b>：${esc(entry.text)}</li>`).join('');
  const contacts = bag.nextContacts.map(
    (contact) => `<li>${esc(contact.role)}${contact.team ? ` · ${esc(contact.team)}` : ''}${contact.shift ? `（${esc(contact.shift)} 班）` : ''} — ${esc(contact.reason)}</li>`,
  ).join('');
  const observations = bag.observations.map((entry) => `<li>${esc(entry.text)}</li>`).join('');
  const depends = bag.dependsOn.map(
    (entry) => `<li><span class="source">${esc(entry.source)}</span> ${esc(entry.summary)} <span class="muted">${esc(entry.at ?? '')}</span></li>`,
  ).join('');

  const confirmForm = bag.receivingRows?.some((row) => row.accepted) || bag.manualRows?.length
    ? `<details><summary>登记双方确认的退接 / 转交</summary>
        <form method="post" action="/confirmations">
          <input type="hidden" name="transfer" value="${esc(bag.transfer)}">
          <input type="hidden" name="originalTag" value="${esc(bag.originalTag)}">
          <label>类型 <select name="type"><option value="return">退接</option><option value="transfer">转交</option></select></label>
          <label>交出方 <input name="from" value="${esc(bag.holder?.team ?? '')}" required></label>
          <label>接收方 <input name="to" required></label>
          <label>双方确认（逗号分隔） <input name="acceptedBy" placeholder="交出方,接收方" required></label>
          <label>现场动作时间 <input name="at" placeholder="2026-12-04T09:28:00+08:00"></label>
          <label>经办人 <input name="operator" required></label>
          <label>班次 <input name="shift" value="${esc(bag.shift?.shift ?? '')}" required></label>
          <button type="submit">登记</button>
        </form>
        <p class="muted">登记只是记录双方现场确认，不会自动改变票务或生成装机指令。</p>
      </details>`
    : '';

  const revokeInstructionForm = bag.instruction
    ? `<form method="post" action="/instructions/${esc(bag.instruction.id)}/revoke">
        <label>撤销原因 <input name="reason"></label>
        <label>经办人 <input name="operator" required></label>
        <button type="submit">撤销本件指令</button>
      </form>`
    : '';

  const claimForm = bag.status === '可交接' && !bag.hold
    ? `<form method="post" action="/instructions">
        <input type="hidden" name="transfer" value="${esc(bag.transfer)}">
        <input type="hidden" name="originalTag" value="${esc(bag.originalTag)}">
        <label>经办人 <input name="operator" required></label>
        <label>班次 <input name="shift" value="${esc(bag.shift?.shift ?? '')}" required></label>
        <label>备注 <input name="note"></label>
        <button type="submit">建立交接指令</button>
      </form>`
    : '';

  const instructionBlock = instruction ? renderInstruction(instruction) : '';
  const historyBlock = history.length > 1 || (history.length === 1 && !instruction)
    ? `<details><summary>本件指令记录（${history.length}）</summary><ul>${history.map((item) => instructionHistoryLine(item)).join('')}</ul></details>`
    : '';

  return `<section class="bag ${STATUS_CLASS[bag.status] ?? ''}" id="bag-${esc(bag.transfer)}-${esc(bag.originalTag)}">
    <header>
      <h3>原条码 ${esc(bag.originalTag ?? '（未定位）')} ${bag.newTag ? `<span class="muted">新条码 ${esc(bag.newTag)}</span>` : ''}</h3>
      ${statusChip(bag.status)}
      ${bag.hold ? '<span class="chip manual">自动交接依据已停住</span>' : ''}
    </header>
    <dl class="facts">
      <dt>签转</dt><dd>${esc(bag.transfer)} · ${esc(bag.oldCarrier ?? '?')} → ${esc(bag.newCarrier ?? '?')} · 票务 ${esc(bag.ticket.state ?? '无记录')}${bag.ticket.withdrawn ? '（已撤销）' : ''}</dd>
      <dt>交运链</dt><dd>${esc(bag.chain?.batch ?? '未开批')} · ${esc(bag.chain?.status ?? 'unknown')}${
        (bag.chains?.length ?? 0) > 1
          ? ` <span class="muted">（历次：${bag.chains.map((chain) => `${esc(chain.batch ?? '未开批')}/${esc(chain.status)}`).join('、')}）</span>`
          : ''
      }</dd>
      <dt>本次由谁接</dt><dd>${esc(holderText(bag.holder))} <span class="muted">${esc(bag.holder?.basis ?? '')}</span></dd>
      ${bag.resolution ? `<dt>处置</dt><dd>${esc(bag.reasonSummary ?? '')}</dd>` : ''}
    </dl>
    <div class="columns">
      <div><h4>判断</h4>${reasons ? `<ul class="reasons">${reasons}</ul>` : '<p class="muted">无阻断项</p>'}</div>
      <div><h4>证据缺在哪</h4>${gaps ? `<ul>${gaps}</ul>` : '<p class="muted">无</p>'}</div>
      <div><h4>下一步联系谁</h4>${contacts ? `<ul>${contacts}</ul>` : '<p class="muted">无需联系</p>'}</div>
    </div>
    ${observations ? `<details><summary>来源观察</summary><ul>${observations}</ul></details>` : ''}
    ${depends ? `<details><summary>依赖的资料（当时快照）</summary><ul>${depends}</ul></details>` : ''}
    ${instructionBlock}
    ${historyBlock}
    ${confirmForm}
    ${claimForm}
    ${revokeInstructionForm}
  </section>`;
}

function instructionHistoryLine(instruction) {
  const stateLabel = {
    pending: '待认领',
    claimed: '已认领',
    closed: '已关闭',
    revoked: '已撤销',
    invalidated: '已失效',
  }[instruction.status] ?? instruction.status;
  return `<li><code>${esc(instruction.id.slice(0, 8))}</code> ${esc(stateLabel)}
    · 建立 ${esc(instruction.createdBy.shift)} / ${esc(instruction.createdBy.operator)}
    ${instruction.assignee ? ` · 跟踪 ${esc(instruction.assignee.shift)} / ${esc(instruction.assignee.operator)}` : ''}
    ${instruction.closedAt ? ` · 关闭于 ${esc(instruction.closedAt)}` : ''}
    ${instruction.invalidatedAt ? ` · 失效于 ${esc(instruction.invalidatedAt)}` : ''}
    ${instruction.revokedAt ? ` · 撤销于 ${esc(instruction.revokedAt)}` : ''}</li>`;
}

function renderInstruction(instruction) {
  const stateLabel = {
    pending: '待认领',
    claimed: '已认领',
    closed: '已关闭',
    revoked: '已撤销',
    invalidated: '已失效',
  }[instruction.status] ?? instruction.status;
  const evidence = instruction.evidence ?? {};
  const depended = (evidence.dependsOn ?? []).map(
    (entry) => `<li><span class="source">${esc(entry.source)}</span> ${esc(entry.summary)} <span class="muted">${esc(entry.at ?? '')}</span></li>`,
  ).join('');
  const actions = [];
  if (instruction.status === 'pending') {
    actions.push(`<form method="post" action="/instructions/${esc(instruction.id)}/claim">
      <label>经办人 <input name="operator" required></label>
      <label>班次 <input name="shift" value="${esc(instruction.pendingFor?.shift ?? '')}" required></label>
      <button type="submit">认领</button></form>`);
  }
  if (instruction.status === 'pending' || instruction.status === 'claimed') {
    actions.push(`<form method="post" action="/instructions/${esc(instruction.id)}/handover">
      <label>接班人 <input name="toOperator" required></label>
      <label>接班班次 <input name="toShift" required></label>
      <label>双方确认（逗号分隔） <input name="acceptedBy" placeholder="原操作人,接班人"></label>
      <button type="submit">交班</button></form>`);
    actions.push(`<form method="post" action="/instructions/${esc(instruction.id)}/close">
      <label>凭据来源 <select name="kind"><option value="receiving">新航司收件</option><option value="manual">现场双边确认</option></select></label>
      <label>经办人 <input name="operator"></label>
      <button type="submit">凭现场凭据关闭</button></form>`);
    actions.push(`<form method="post" action="/instructions/${esc(instruction.id)}/revoke">
      <label>原因 <input name="reason"></label>
      <label>经办人 <input name="operator"></label>
      <button type="submit">撤销指令</button></form>`);
  }
  return `<div class="instruction">
    <p>交接指令 <code>${esc(instruction.id.slice(0, 8))}</code> · ${esc(stateLabel)}
      · 建立 ${esc(instruction.createdBy.shift)} / ${esc(instruction.createdBy.operator)}
      ${instruction.assignee ? ` · 跟踪 ${esc(instruction.assignee.shift)} / ${esc(instruction.assignee.operator)}` : ''}
      ${instruction.closedAt ? ` · 关闭于 ${esc(instruction.closedAt)}` : ''}
      ${instruction.revokedAt ? ` · 撤销于 ${esc(instruction.revokedAt)}` : ''}
      ${instruction.invalidatedAt ? ` · 失效于 ${esc(instruction.invalidatedAt)}` : ''}
    </p>
    ${depended ? `<details><summary>建立时依赖的资料</summary><ul>${depended}</ul></details>` : ''}
    ${instruction.invalidation ? `<p class="reason manual">失效原因：${esc(instruction.invalidation.detail ?? instruction.invalidation.reasons.join('、'))}</p>` : ''}
    ${instruction.closure ? `<p>关闭凭据：${esc(instruction.closure.source)} ${esc(instruction.closure.at ?? '')}</p>` : ''}
    <div class="actions">${actions.join('')}</div>
  </div>`;
}

function groupSection(group) {
  const cards = group.bags.map((bag) => bagCard(bag, bag.instruction, bag.instructionHistory ?? [])).join('');
  return `<article class="group" id="traveller-${esc(group.traveller)}">
    <h2>旅客 ${esc(group.traveller ?? '未知')} · 航段 ${esc(group.segment ?? '未知')} <span class="muted">该旅客最高状态</span> ${statusChip(group.status)}</h2>
    <p class="muted">逐件判断，不按航班号或姓氏合并；一件停住不影响同组其他行李。</p>
    ${cards}
  </article>`;
}

export function renderWorkbench(snapshot) {
  const shift = snapshot.shift ?? { shift: null, teams: {} };
  const teams = Object.entries(shift.teams ?? {}).map(([carrier, team]) => `<li>${esc(carrier)} → ${esc(team)}</li>`).join('');
  const problems = snapshot.problems ?? [];
  const problemList = problems.length
    ? `<ul class="problems">${problems.map((problem) => `<li>${esc(problem.kind)}${problem.batch ? ` · ${esc(problem.batch)}` : ''}${problem.message ? ` — ${esc(problem.message)}` : ''}</li>`).join('')}</ul>`
    : '<p class="muted">来源读取未见结构性问题。</p>';
  const counts = { 可交接: 0, 待确认: 0, 必须人工处理: 0 };
  for (const bag of snapshot.bags ?? []) counts[bag.status] = (counts[bag.status] ?? 0) + 1;
  const pendingInstructions = (snapshot.instructions ?? []).filter((item) => item.status === 'pending');
  const successors = pendingInstructions.map(
    (item) => `<li>${esc(item.originalTag)}（${esc(item.transfer)}）→ ${
      item.pendingFor
        ? `接班人 ${esc(item.pendingFor.operator)} / ${esc(item.pendingFor.shift)}`
        : `尚未交班${item.successor ? `，当前班次 ${esc(item.successor.shift)} 需接手` : ''}`
    }</li>`,
  ).join('');
  const shiftAlerts = pendingInstructions
    .filter((item) => item.successor && !item.pendingFor)
    .map((item) => `<li>${esc(item.originalTag)}：${esc(item.successor.reason)}</li>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>跨航司签转行李交运工作台</title>
<style>
  :root { color-scheme: light; --ink:#17202a; --muted:#6b7785; --line:#d7dde4; --ready:#12643a; --check:#8a5a00; --manual:#9b1c1c; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; color: var(--ink); background: #f6f8fa; }
  main { max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 0 0 4px; } h3 { font-size: 16px; margin: 0; }
  h4 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 12px 0 6px; }
  .muted { color: var(--muted); } .grid { display: grid; gap: 16px; }
  .panel, .group, .bag { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
  .group { margin-top: 20px; } .bag { margin-top: 12px; border-left: 4px solid var(--line); }
  .bag.ready { border-left-color: var(--ready); } .bag.check { border-left-color: var(--check); } .bag.manual { border-left-color: var(--manual); }
  .chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid currentColor; margin-left: 6px; }
  .chip.ready { color: var(--ready); } .chip.check { color: var(--check); } .chip.manual { color: var(--manual); } .chip.unknown { color: var(--muted); }
  .columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  ul { margin: 4px 0; padding-left: 20px; } li { margin: 2px 0; }
  ul.reasons { list-style: none; padding-left: 0; }
  .reason.ready { color: var(--ready); } .reason.check { color: var(--check); } .reason.manual { color: var(--manual); }
  dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 8px 0; }
  dt { color: var(--muted); }
  form { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); }
  label { display: flex; flex-direction: column; font-size: 12px; color: var(--muted); }
  input, select, button { font: inherit; padding: 4px 6px; border: 1px solid var(--line); border-radius: 4px; }
  button { background: var(--ink); color: #fff; border: 0; padding: 6px 12px; cursor: pointer; }
  .instruction { margin-top: 12px; padding: 10px; background: #f9fafb; border: 1px solid var(--line); border-radius: 6px; }
  .source { font-size: 11px; text-transform: uppercase; color: var(--muted); border: 1px solid var(--line); border-radius: 3px; padding: 0 4px; }
  .actions { display: grid; gap: 8px; } details { margin-top: 8px; } summary { cursor: pointer; color: var(--muted); }
  .counts { display: flex; gap: 16px; flex-wrap: wrap; margin: 8px 0 0; }
  .problems { color: var(--manual); }
</style>
</head>
<body><main>
  <h1>跨航司签转行李交运工作台</h1>
  <p class="muted">仅汇集与解释来源资料，不订票、不向行李设备下达装机命令。逐件以原条码追踪。</p>
  <section class="panel">
    <div class="counts">
      <span>当前班次 <b>${esc(shift.shift ?? '未知')}</b></span>
      <span>${statusChip('可交接')} ${counts['可交接'] ?? 0}</span>
      <span>${statusChip('待确认')} ${counts['待确认'] ?? 0}</span>
      <span>${statusChip('必须人工处理')} ${counts['必须人工处理'] ?? 0}</span>
      <span>采集时间 ${esc(snapshot.refreshedAt ?? '未采集')}</span>
    </div>
    <details><summary>班次联系人</summary><ul>${teams || '<li class="muted">无</li>'}</ul></details>
    ${successors ? `<details open><summary>待交给接班人</summary><ul>${successors}</ul></details>` : ''}
    ${shiftAlerts ? `<details open class="problems"><summary>班次交替提醒</summary><ul>${shiftAlerts}</ul></details>` : ''}
    <details><summary>来源读取问题</summary>${problemList}</details>
    ${snapshot.fetchError ? `<p class="reason manual">采集失败：${esc(snapshot.fetchError)}</p>` : ''}
    <form method="post" action="/refresh"><button type="submit">重新采集</button></form>
  </section>
  <div class="grid">
    ${(snapshot.travellers ?? []).map(groupSection).join('') || '<p class="muted">没有可显示的数据。</p>'}
  </div>
</main>
<script>
// Progressive enhancement only: forms post JSON to the ledger API and then reload.
// Without JavaScript, the same forms post to the server-rendered fallbacks.
document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[action^="/instructions"], form[action^="/refresh"]');
  if (!form || form.dataset.plain === 'true') return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const path = form.getAttribute('action');
  if (path === '/refresh') { location.reload(); return; }
  const parts = path.split('/').filter(Boolean);
  const id = parts[1];
  let url;
  let body = data;
  if (parts.length === 1) url = '/api/instructions';
  else url = '/api/instructions/' + id + '/' + parts[2];
  if (body.acceptedBy) body.acceptedBy = body.acceptedBy.split(',').map((value) => value.trim()).filter(Boolean);
  if (body.toOperator && !body.toShift) { alert('需填写接班班次'); return; }
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    alert(payload.error || '操作失败');
    return;
  }
  location.reload();
});
</script>
</body></html>`;
}
