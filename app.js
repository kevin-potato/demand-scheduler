/* 数据需求排期 - 前端逻辑
 * 只读访问：直接读取仓库里的 data.json
 * 管理模式：持有 GitHub Token 的人通过 Contents API 写回 data.json
 */

// —— 仓库配置：部署在 GitHub Pages 时自动识别，本地预览时用下面的默认值 ——
const CFG = (() => {
  const h = location.hostname, p = location.pathname.split('/').filter(Boolean);
  if (h.endsWith('.github.io') && p.length >= 1) {
    return { owner: h.split('.')[0], repo: p[0] };
  }
  return { owner: 'OWNER_PLACEHOLDER', repo: 'REPO_PLACEHOLDER' };
})();
const DATA_PATH = 'data.json';
const API = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/contents/${DATA_PATH}`;

let DB = { stakeholders: [], demands: [] };
let SHA = null;           // 当前 data.json 的 git sha，写回时需要
let editingDemandId = null;
let editingShId = null;

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

// ---------- 加载数据 ----------
async function loadData() {
  try {
    const r = await fetch(API, { headers: { 'Accept': 'application/vnd.github+json' }, cache: 'no-store' });
    if (!r.ok) throw new Error('api ' + r.status);
    const j = await r.json();
    SHA = j.sha;
    DB = JSON.parse(decodeURIComponent(escape(atob(j.content.replace(/\n/g, '')))));
  } catch (e) {
    // 兜底：直接读同目录静态文件（本地预览或 API 限流时）
    try {
      const r2 = await fetch(DATA_PATH + '?t=' + Date.now(), { cache: 'no-store' });
      DB = await r2.json();
    } catch (e2) { toast('数据加载失败'); }
  }
  render();
}

// ---------- 保存数据（管理模式） ----------
async function saveData(msg) {
  if (!isAdmin()) { toast('请先进入管理模式'); return false; }
  const body = {
    message: msg || '更新数据',
    content: btoa(unescape(encodeURIComponent(JSON.stringify(DB, null, 2)))),
  };
  if (SHA) body.sha = SHA;
  const r = await fetch(API, {
    method: 'PUT',
    headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 409) { // sha 冲突，拉最新再试一次
    const rr = await fetch(API, { headers: { 'Accept': 'application/vnd.github+json' }, cache: 'no-store' });
    if (rr.ok) { SHA = (await rr.json()).sha; body.sha = SHA;
      const r2 = await fetch(API, { method: 'PUT', headers: { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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

// ---------- 渲染 ----------
function shName(id) { const s = DB.stakeholders.find(x => x.id === id); return s ? s.name : '—'; }

function render() {
  document.body.classList.toggle('admin', isAdmin());
  // 统计
  const d = DB.demands;
  const cnt = (st) => d.filter(x => x.status === st).length;
  $('stats').innerHTML = [
    ['总需求', d.length], ['待排期', cnt('待排期')], ['开发中', cnt('开发中')], ['已上线', cnt('已上线')], ['业务方', DB.stakeholders.length],
  ].map(([l, n]) => `<div class="stat"><div class="num">${n}</div><div class="label">${l}</div></div>`).join('');

  // 业务方筛选下拉
  const fs = $('fStakeholder'); const cur = fs.value;
  fs.innerHTML = '<option value="">全部业务方</option>' + DB.stakeholders.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  fs.value = cur;

  renderDemands();
  renderStakeholders();
  $('updateTime').textContent = '共 ' + d.length + ' 条需求 · ' + DB.stakeholders.length + ' 个业务方';
}

function renderDemands() {
  const q = $('fSearch').value.trim().toLowerCase();
  const fSh = $('fStakeholder').value, fSt = $('fStatus').value, fP = $('fPriority').value;
  const today = new Date().toISOString().slice(0, 10);
  const order = { 'P0': 0, 'P1': 1, 'P2': 2 };
  const stOrder = { '开发中': 0, '已排期': 1, '待排期': 2, '已暂停': 3, '已上线': 4 };

  let rows = DB.demands.filter(x =>
    (!q || (x.title + x.requester).toLowerCase().includes(q)) &&
    (!fSh || x.stakeholderId === fSh) && (!fSt || x.status === fSt) && (!fP || x.priority === fP)
  ).sort((a, b) => (stOrder[a.status] ?? 9) - (stOrder[b.status] ?? 9) || (order[a.priority] ?? 9) - (order[b.priority] ?? 9) || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));

  $('demandBody').innerHTML = rows.length ? rows.map(x => {
    const overdue = x.dueDate && x.dueDate < today && x.status !== '已上线';
    return `<tr>
      <td style="font-weight:500;max-width:220px;">${esc(x.title)}</td>
      <td>${esc(shName(x.stakeholderId))}</td>
      <td>${esc(x.requester || '—')}</td>
      <td><span class="tag ${x.priority.toLowerCase()}">${x.priority}</span></td>
      <td><span class="tag st-${x.status}">${x.status}</span></td>
      <td class="muted">${x.startDate || '—'}</td>
      <td class="${overdue ? 'overdue' : 'muted'}">${x.dueDate || '—'}${overdue ? ' ⚠' : ''}</td>
      <td class="muted" style="max-width:180px;">${esc(x.note || '')}</td>
      <td class="admin-col" style="white-space:nowrap;">
        <button class="btn small" onclick="editDemand('${x.id}')">编辑</button>
        <button class="btn small danger" onclick="delDemand('${x.id}')">删除</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="9" class="empty">暂无需求</td></tr>';
}

function renderStakeholders() {
  $('shBody').innerHTML = DB.stakeholders.length ? DB.stakeholders.map(s => {
    const n = DB.demands.filter(d => d.stakeholderId === s.id).length;
    return `<tr>
      <td style="font-weight:500;">${esc(s.name)}</td>
      <td>${esc(s.contact || '—')}</td>
      <td>${n}</td>
      <td class="muted">${esc(s.note || '')}</td>
      <td class="admin-col" style="white-space:nowrap;">
        <button class="btn small" onclick="editSh('${s.id}')">编辑</button>
        <button class="btn small danger" onclick="delSh('${s.id}')">删除</button>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty">暂无业务方</td></tr>';
}

// ---------- 需求 CRUD ----------
function fillShSelect() {
  $('dStakeholder').innerHTML = DB.stakeholders.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
}
$('btnAddDemand').onclick = () => {
  editingDemandId = null; fillShSelect();
  $('demandModalTitle').textContent = '新增需求';
  ['dTitle', 'dRequester', 'dStart', 'dDue', 'dNote'].forEach(i => $(i).value = '');
  $('dPriority').value = 'P1'; $('dStatus').value = '待排期';
  openModal('demandModal');
};
window.editDemand = (id) => {
  const x = DB.demands.find(d => d.id === id); if (!x) return;
  editingDemandId = id; fillShSelect();
  $('demandModalTitle').textContent = '编辑需求';
  $('dTitle').value = x.title; $('dStakeholder').value = x.stakeholderId;
  $('dRequester').value = x.requester || ''; $('dPriority').value = x.priority;
  $('dStatus').value = x.status; $('dStart').value = x.startDate || '';
  $('dDue').value = x.dueDate || ''; $('dNote').value = x.note || '';
  openModal('demandModal');
};
$('btnSaveDemand').onclick = async () => {
  const title = $('dTitle').value.trim();
  if (!title) { toast('请填写需求名称'); return; }
  if (!DB.stakeholders.length) { toast('请先添加业务方'); return; }
  const obj = {
    id: editingDemandId || uid(), title,
    stakeholderId: $('dStakeholder').value, requester: $('dRequester').value.trim(),
    priority: $('dPriority').value, status: $('dStatus').value,
    startDate: $('dStart').value, dueDate: $('dDue').value, note: $('dNote').value.trim(),
  };
  if (editingDemandId) { const i = DB.demands.findIndex(d => d.id === editingDemandId); DB.demands[i] = obj; }
  else DB.demands.push(obj);
  closeModal('demandModal'); render();
  await saveData((editingDemandId ? '编辑需求: ' : '新增需求: ') + title);
};
window.delDemand = async (id) => {
  const x = DB.demands.find(d => d.id === id);
  if (!confirm('确定删除需求「' + x.title + '」？')) return;
  DB.demands = DB.demands.filter(d => d.id !== id);
  render(); await saveData('删除需求: ' + x.title);
};

// ---------- 业务方 CRUD ----------
$('btnAddStakeholder').onclick = () => {
  editingShId = null;
  $('shModalTitle').textContent = '新增业务方';
  ['sName', 'sContact', 'sNote'].forEach(i => $(i).value = '');
  openModal('shModal');
};
window.editSh = (id) => {
  const s = DB.stakeholders.find(x => x.id === id); if (!s) return;
  editingShId = id;
  $('shModalTitle').textContent = '编辑业务方';
  $('sName').value = s.name; $('sContact').value = s.contact || ''; $('sNote').value = s.note || '';
  openModal('shModal');
};
$('btnSaveSh').onclick = async () => {
  const name = $('sName').value.trim();
  if (!name) { toast('请填写名称'); return; }
  const obj = { id: editingShId || uid(), name, contact: $('sContact').value.trim(), note: $('sNote').value.trim() };
  if (editingShId) { const i = DB.stakeholders.findIndex(s => s.id === editingShId); DB.stakeholders[i] = obj; }
  else DB.stakeholders.push(obj);
  closeModal('shModal'); render();
  await saveData((editingShId ? '编辑业务方: ' : '新增业务方: ') + name);
};
window.delSh = async (id) => {
  const s = DB.stakeholders.find(x => x.id === id);
  const used = DB.demands.filter(d => d.stakeholderId === id).length;
  if (used > 0) { toast('该业务方下还有 ' + used + ' 条需求，请先处理'); return; }
  if (!confirm('确定删除业务方「' + s.name + '」？')) return;
  DB.stakeholders = DB.stakeholders.filter(x => x.id !== id);
  render(); await saveData('删除业务方: ' + s.name);
};

// ---------- 管理模式 ----------
$('btnAdmin').onclick = () => {
  if (isAdmin()) { toast('已在管理模式'); return; }
  openModal('adminModal');
};
$('btnLogin').onclick = async () => {
  const t = $('adminToken').value.trim();
  if (!t) { toast('请输入 Token'); return; }
  // 校验 token 是否对该仓库有写权限
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

// 筛选事件
['fSearch', 'fStakeholder', 'fStatus', 'fPriority'].forEach(i => $(i).addEventListener('input', renderDemands));
// 点击遮罩关闭
document.querySelectorAll('.modal-mask').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); }));

loadData();
