/* 数据需求排期 - 前端逻辑
 * 只读访问：读取仓库里的 data.json（所有历史需求永久保存在这里）
 * 管理模式：持有 GitHub Token 的人通过 Contents API 写回 data.json
 * 业务方为需求上的字段，自动汇总历史值供筛选和输入联想
 */

const CFG = (() => {
  const h = location.hostname, p = location.pathname.split('/').filter(Boolean);
  if (h.endsWith('.github.io') && p.length >= 1) {
    return { owner: h.split('.')[0], repo: p[0] };
  }
  return { owner: 'OWNER_PLACEHOLDER', repo: 'REPO_PLACEHOLDER' };
})();
const DATA_PATH = 'data.json';
const API = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/contents/${DATA_PATH}`;

let DB = { demands: [] };
let SHA = null;
let editingDemandId = null;
let VIEW = 'active'; // active | done | all

const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function token() { return localStorage.getItem('ds_token') || ''; }
function isAdmin() { return !!token(); }

function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}
function openModal(id) { $(id).classList.add('show'); }
function closeModal(id) { $(id).classList.remove('show'); }
window.closeModal = closeModal;

// 旧数据迁移：stakeholderId -> stakeholder 名称；已上线 -> 已完成
function migrate(raw) {
  const shMap = {};
  (raw.stakeholders || []).forEach(s => { shMap[s.id] = s.name; });
  const demands = (raw.demands || []).map(d => {
    const nd = { ...d };
    if (!nd.stakeholder && nd.stakeholderId) nd.stakeholder = shMap[nd.stakeholderId] || '';
    delete nd.stakeholderId;
    if (nd.status === '已上线') nd.status = '已完成';
    return nd;
  });
  return { demands };
}

// ---------- 加载数据 ----------
async function loadData() {
  try {
    const r = await fetch(API, { headers: { 'Accept': 'application/vnd.github+json' }, cache: 'no-store' });
    if (!r.ok) throw new Error('api ' + r.status);
    const j = await r.json();
    SHA = j.sha;
    DB = migrate(JSON.parse(decodeURIComponent(escape(atob(j.content.replace(/\n/g, ''))))));
  } catch (e) {
    try {
      const r2 = await fetch(DATA_PATH + '?t=' + Date.now(), { cache: 'no-store' });
      DB = migrate(await r2.json());
    } catch (e2) { toast('数据加载失败'); }
  }
  render();
}

// ---------- 保存数据 ----------
async function saveData(msg) {
  if (!isAdmin()) { toast('请先进入管理模式'); return false; }
  const body = {
    message: msg || '更新数据',
    content: btoa(unescape(encodeURIComponent(JSON.stringify(DB, null, 2)))),
  };
  if (SHA) body.sha = SHA;
  const hdr = { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' };
  const r = await fetch(API, { method: 'PUT', headers: hdr, body: JSON.stringify(body) });
  if (r.status === 409) {
    const rr = await fetch(API, { headers: { 'Accept': 'application/vnd.github+json' }, cache: 'no-store' });
    if (rr.ok) { SHA = (await rr.json()).sha; body.sha = SHA;
      const r2 = await fetch(API, { method: 'PUT', headers: hdr, body: JSON.stringify(body) });
      if (r2.ok) { SHA = (await r2.json()).content.sha; toast('已保存 ✓'); return true; }
    }
    toast('保存冲突，请刷新后重试'); return false;
  }
  if (r.status === 401 || r.status === 403) { toast('Token 无效或权限不足'); return false; }
  if (!r.ok) { toast('保存失败 (' + r.status + ')'); return false; }
  SHA = (await r.json()).content.sha;
  toast('已保存 ✓（线上生效约需 1 分钟）');
  return true;
}

// ---------- 业务方汇总 ----------
function stakeholderNames() {
  return [...new Set(DB.demands.map(d => (d.stakeholder || '').trim()).filter(Boolean))].sort();
}

// ---------- 渲染 ----------
function render() {
  document.body.classList.toggle('admin', isAdmin());
  const d = DB.demands;
  const cnt = (st) => d.filter(x => x.status === st).length;
  $('stats').innerHTML = [
    ['总需求', d.length], ['待排期', cnt('待排期')], ['开发中', cnt('开发中')], ['已完成', cnt('已完成')], ['业务方', stakeholderNames().length],
  ].map(([l, n]) => `<div class="stat"><div class="num">${n}</div><div class="label">${l}</div></div>`).join('');

  // 业务方筛选下拉 + 输入联想
  const names = stakeholderNames();
  const fs = $('fStakeholder'); const cur = fs.value;
  fs.innerHTML = '<option value="">全部业务方</option>' + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  fs.value = cur;
  $('shList').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');

  renderDemands();
  $('updateTime').textContent = '共 ' + d.length + ' 条需求（含全部历史） · ' + names.length + ' 个业务方';
}

function renderDemands() {
  const q = $('fSearch').value.trim().toLowerCase();
  const fSh = $('fStakeholder').value, fSt = $('fStatus').value, fP = $('fPriority').value;
  const today = new Date().toISOString().slice(0, 10);
  const order = { 'P0': 0, 'P1': 1, 'P2': 2 };
  const stOrder = { '开发中': 0, '已排期': 1, '待排期': 2, '已暂停': 3, '已完成': 4 };

  let rows = DB.demands.filter(x => {
    if (VIEW === 'active' && x.status === '已完成') return false;
    if (VIEW === 'done' && x.status !== '已完成') return false;
    return (!q || ((x.title || '') + (x.requester || '') + (x.stakeholder || '')).toLowerCase().includes(q)) &&
      (!fSh || x.stakeholder === fSh) && (!fSt || x.status === fSt) && (!fP || x.priority === fP);
  });

  if (VIEW === 'done') {
    rows.sort((a, b) => (b.dueDate || '').localeCompare(a.dueDate || '') || (b.startDate || '').localeCompare(a.startDate || ''));
  } else {
    rows.sort((a, b) => (stOrder[a.status] ?? 9) - (stOrder[b.status] ?? 9) || (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  }

  $('demandBody').innerHTML = rows.length ? rows.map(x => {
    const overdue = x.dueDate && x.dueDate < today && x.status !== '已完成';
    return `<tr>
      <td style="font-weight:500;max-width:220px;">${esc(x.title)}</td>
      <td>${esc(x.stakeholder || '—')}</td>
      <td>${esc(x.requester || '—')}</td>
      <td><span class="tag ${(x.priority || 'P2').toLowerCase()}">${x.priority || '—'}</span></td>
      <td><span class="tag st-${x.status}">${x.status}</span></td>
      <td class="muted">${x.startDate || '—'}</td>
      <td class="${overdue ? 'overdue' : 'muted'}">${x.dueDate || '—'}${overdue ? ' ⚠' : ''}</td>
      <td class="muted" style="max-width:180px;">${esc(x.note || '')}</td>
      <td class="admin-col" style="white-space:nowrap;">
        ${x.status !== '已完成' ? `<button class="btn small" onclick="markDone('${x.id}')">完成</button>` : ''}
        <button class="btn small" onclick="editDemand('${x.id}')">编辑</button>
        <button class="btn small danger" onclick="delDemand('${x.id}')">删除</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="9" class="empty">暂无需求</td></tr>';
}

// ---------- 需求 CRUD ----------
$('btnAddDemand').onclick = () => {
  editingDemandId = null;
  $('demandModalTitle').textContent = '新增需求';
  ['dTitle', 'dStakeholder', 'dRequester', 'dStart', 'dDue', 'dNote'].forEach(i => $(i).value = '');
  $('dPriority').value = 'P1'; $('dStatus').value = '待排期';
  openModal('demandModal');
};
window.editDemand = (id) => {
  const x = DB.demands.find(d => d.id === id); if (!x) return;
  editingDemandId = id;
  $('demandModalTitle').textContent = '编辑需求';
  $('dTitle').value = x.title; $('dStakeholder').value = x.stakeholder || '';
  $('dRequester').value = x.requester || ''; $('dPriority').value = x.priority || 'P1';
  $('dStatus').value = x.status; $('dStart').value = x.startDate || '';
  $('dDue').value = x.dueDate || ''; $('dNote').value = x.note || '';
  openModal('demandModal');
};
$('btnSaveDemand').onclick = async () => {
  const title = $('dTitle').value.trim();
  const stakeholder = $('dStakeholder').value.trim();
  if (!title) { toast('请填写需求名称'); return; }
  if (!stakeholder) { toast('请填写业务方'); return; }
  const obj = {
    id: editingDemandId || uid(), title, stakeholder,
    requester: $('dRequester').value.trim(),
    priority: $('dPriority').value, status: $('dStatus').value,
    startDate: $('dStart').value, dueDate: $('dDue').value, note: $('dNote').value.trim(),
  };
  if (editingDemandId) { const i = DB.demands.findIndex(d => d.id === editingDemandId); DB.demands[i] = obj; }
  else DB.demands.push(obj);
  closeModal('demandModal'); render();
  await saveData((editingDemandId ? '编辑需求: ' : '新增需求: ') + title);
};
window.markDone = async (id) => {
  const x = DB.demands.find(d => d.id === id); if (!x) return;
  x.status = '已完成';
  render(); await saveData('完成需求: ' + x.title);
};
window.delDemand = async (id) => {
  const x = DB.demands.find(d => d.id === id);
  if (!confirm('确定删除需求「' + x.title + '」？\n（做完的需求建议标记为"已完成"而不是删除，以便保留历史记录）')) return;
  DB.demands = DB.demands.filter(d => d.id !== id);
  render(); await saveData('删除需求: ' + x.title);
};

// ---------- 视图切换 ----------
document.querySelectorAll('#viewTabs button').forEach(b => {
  b.addEventListener('click', () => {
    VIEW = b.dataset.view;
    document.querySelectorAll('#viewTabs button').forEach(x => x.classList.toggle('active', x === b));
    renderDemands();
  });
});

// ---------- 管理模式 ----------
$('btnAdmin').onclick = () => {
  if (isAdmin()) { toast('已在管理模式'); return; }
  openModal('adminModal');
};
$('btnLogin').onclick = async () => {
  const t = $('adminToken').value.trim();
  if (!t) { toast('请输入 Token'); return; }
  const r = await fetch(`https://api.github.com/repos/${CFG.owner}/${CFG.repo}`, { headers: { 'Authorization': 'Bearer ' + t, 'Accept': 'application/vnd.github+json' } });
  if (!r.ok) { toast('Token 无效'); return; }
  const j = await r.json();
  if (!j.permissions || !j.permissions.push) { toast('该 Token 没有此仓库的写权限'); return; }
  localStorage.setItem('ds_token', t);
  $('adminToken').value = '';
  closeModal('adminModal'); render();
  toast('已进入管理模式 ✓');
};
$('btnLogout').onclick = () => { localStorage.removeItem('ds_token'); render(); toast('已退出管理模式'); };

['fSearch', 'fStakeholder', 'fStatus', 'fPriority'].forEach(i => $(i).addEventListener('input', renderDemands));
document.querySelectorAll('.modal-mask').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); }));

loadData();
