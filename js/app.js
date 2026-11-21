import {
  dbSalvarProcessamento,
  dbListarProcessamentos,
  dbObterPorId,
  dbExcluirPorId,
  dbLimparTudo,
  formatarDataHoraBR
} from './db.js';

import {
  contarPaginasPDF,
  processarLotePDF,
  reprocessarPaginaUnica
} from './ocr-engine.js';

let selectedFile = null;
let sourceArrayBuffer = null;
let currentRecordId = null;
let currentRecordMeta = null;
let batchItems = [];
let batchStats = { paginas: 0, tempo: '0.0 s' };
let editingId = null;
let isConsultingMode = false;

// =========================================================================
// NAVEGAÇÃO E SIDEBAR
// =========================================================================
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('collapsed');
}

function navigate(view) {
  ['dashboard', 'separador', 'historico', 'configuracoes'].forEach(v => {
    document.getElementById('view-' + v).classList.toggle('hidden', v !== view);
  });

  document.getElementById('nav-dashboard').classList.toggle('active', view === 'dashboard');
  document.getElementById('nav-separador').classList.toggle('active', view === 'separador');
  document.getElementById('nav-historico').classList.toggle('active', view === 'historico');
  document.getElementById('nav-configuracoes').classList.toggle('active', view === 'configuracoes');

  const crumbs = {
    dashboard: '<span>Dashboard</span>',
    separador: 'Ferramentas / <span>Separador de Notas Fiscais</span>',
    historico: '<span>Histórico de Processamentos</span>',
    configuracoes: '<span>Configurações</span>'
  };
  document.getElementById('breadcrumb').innerHTML = crumbs[view];

  if (view === 'dashboard') carregarDashboard();
  if (view === 'historico') renderizarHistorico();
}

// =========================================================================
// DASHBOARD
// =========================================================================
async function carregarDashboard() {
  const registros = await dbListarProcessamentos();
  const totalDocs = registros.length;
  const totalNfs = registros.reduce((acc, r) => acc + (r.notasIdentificadas || 0), 0);
  const totalArqs = registros.reduce((acc, r) => acc + (r.arquivosGerados || 0), 0);

  document.getElementById('stat-docs').textContent = totalDocs;
  document.getElementById('stat-nfs').textContent = totalNfs;
  document.getElementById('stat-files').textContent = totalArqs;

  const container = document.getElementById('dash-history-container');
  if (registros.length === 0) {
    container.className = 'empty-box';
    container.innerHTML = 'Nenhum processamento ainda.';
  } else {
    container.className = 'table-card';
    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Data e horário</th>
            <th>PDF original</th>
            <th>Notas</th>
            <th>Arquivos</th>
            <th style="text-align:right;">Ação</th>
          </tr>
        </thead>
        <tbody>
          ${registros.slice(0, 5).map(r => `
            <tr>
              <td class="mono" style="font-size:12.5px;">${formatarDataHoraBR(r.timestamp)}</td>
              <td><strong>${r.pdfOriginal}</strong></td>
              <td class="mono">${r.notasIdentificadas}</td>
              <td class="mono">${r.arquivosGerados}</td>
              <td style="text-align:right;">
                <div class="action-btns" style="justify-content: flex-end;">
                  <button class="btn-outline" onclick="consultarRegistro(${r.id})">Consultar</button>
                  <button class="btn-danger-outline" title="Excluir conjunto" onclick="excluirConjuntoHistorico(${r.id})">🗑</button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }
}

// =========================================================================
// UPLOAD E PROCESSAMENTO
// =========================================================================
const dropzone = document.getElementById('dropzone');
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
});

async function handleFileSelect(file) {
  if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
    alert('Selecione um arquivo PDF válido.');
    return;
  }
  selectedFile = file;
  sourceArrayBuffer = await file.arrayBuffer();
  const totalPages = await contarPaginasPDF(sourceArrayBuffer);

  document.getElementById('meta-name').textContent = file.name;
  document.getElementById('meta-size').textContent = Math.max(1, Math.round(file.size / 1024)) + ' KB';
  document.getElementById('meta-pages').textContent = totalPages;
  document.getElementById('meta-date').textContent = formatarDataHoraBR(Date.now());
  document.getElementById('selected-file-box').classList.remove('hidden');
}

function setProgress(percent, stepIdx) {
  document.getElementById('progress-fill').style.width = percent + '%';
  for (let i = 1; i <= 5; i++) {
    const el = document.getElementById('st-' + i);
    const label = el.textContent.slice(2);
    if (i < stepIdx) {
      el.className = 'step-done';
      el.textContent = '✓ ' + label;
    } else if (i === stepIdx) {
      el.className = 'step-active';
      el.textContent = '• ' + label;
    } else {
      el.className = 'step-pending';
      el.textContent = '○ ' + label;
    }
  }
}

async function iniciarProcessamento() {
  if (!sourceArrayBuffer) return;

  isConsultingMode = false;
  document.getElementById('consulting-banner').classList.add('hidden');
  document.getElementById('step-upload').classList.add('hidden');
  document.getElementById('step-processing').classList.remove('hidden');
  setProgress(15, 2);

  const inicio = performance.now();
  const { items, totalPages } = await processarLotePDF(sourceArrayBuffer, setProgress);
  batchItems = items;

  const duracao = ((performance.now() - inicio) / 1000).toFixed(1) + ' s';
  batchStats = { paginas: totalPages, tempo: duracao };

  const identificadas = batchItems.filter(x => x.status === 'identificado').length;
  const revisao = batchItems.filter(x => x.status === 'nao_identificado').length;

  currentRecordMeta = {
    timestamp: Date.now(),
    ferramenta: 'Separador de Notas Fiscais',
    pdfOriginal: selectedFile.name,
    paginasAnalisadas: totalPages,
    notasIdentificadas: identificadas,
    arquivosGerados: batchItems.length,
    precisamRevisao: revisao,
    tempo: duracao,
    status: revisao > 0 ? 'Com falhas' : 'Concluído',
    items: batchItems
  };

  currentRecordId = await dbSalvarProcessamento(currentRecordMeta);
  currentRecordMeta.id = currentRecordId;

  setTimeout(() => {
    document.getElementById('step-processing').classList.add('hidden');
    document.getElementById('step-results').classList.remove('hidden');
    renderizarResultados();
  }, 250);
}

async function sincronizarRegistroNoDB() {
  if (!currentRecordId || !currentRecordMeta) return;
  const identificadas = batchItems.filter(x => x.status !== 'nao_identificado').length;
  const revisao = batchItems.filter(x => x.status === 'nao_identificado').length;

  currentRecordMeta.notasIdentificadas = identificadas;
  currentRecordMeta.arquivosGerados = batchItems.length;
  currentRecordMeta.precisamRevisao = revisao;
  currentRecordMeta.status = revisao > 0 ? 'Com falhas' : 'Concluído';
  currentRecordMeta.items = batchItems;

  await dbSalvarProcessamento(currentRecordMeta);
}

function renderizarResultados() {
  const identificadas = batchItems.filter(x => x.status !== 'nao_identificado').length;
  const revisao = batchItems.filter(x => x.status === 'nao_identificado').length;

  document.getElementById('res-paginas').textContent = batchStats.paginas;
  document.getElementById('res-identificadas').textContent = identificadas;
  document.getElementById('res-gerar').textContent = batchItems.length;
  document.getElementById('res-revisao').textContent = revisao;
  document.getElementById('res-tempo').textContent = batchStats.tempo;

  document.getElementById('res-subinfo').textContent =
    `${batchItems.length} arquivo(s) · ${revisao} aguardando revisão`;

  document.getElementById('warning-banner').classList.toggle('hidden', revisao === 0);
  document.getElementById('review-callout').classList.toggle('hidden', revisao === 0);
  document.getElementById('warning-text').textContent =
    `${revisao} página(s) não puderam ser lidas automaticamente. Use "Editar" ou "Reprocessar".`;
  document.getElementById('review-count').textContent = revisao;

  const tbody = document.getElementById('results-tbody');
  tbody.innerHTML = batchItems.map(item => {
    const isEditing = editingId === item.id;
    const nfCell = isEditing
      ? `<input type="text" class="inline-edit-input" id="input-nf-${item.id}" value="${item.nfNumber}" placeholder="Ex: 12345" onkeydown="if(event.key==='Enter') salvarEdicao(${item.id})">`
      : `<strong>${item.nfNumber || '—'}</strong>`;

    const statusBadge = item.status === 'nao_identificado'
      ? `<span class="status-pill status-warn">⊗ Não identificado</span>`
      : `<span class="status-pill status-ok">✓ Identificado</span>`;

    const editBtn = isEditing
      ? `<button class="icon-btn confirm" title="Confirmar" onclick="salvarEdicao(${item.id})">✓</button>`
      : `<button class="icon-btn" title="Editar número da NF" onclick="ativarEdicao(${item.id})">✎</button>`;

    return `
      <tr>
        <td>${nfCell}</td>
        <td>${item.pageIndices.length}</td>
        <td class="mono" style="font-size: 13px;">${item.filename}</td>
        <td>${statusBadge}</td>
        <td>
          <div class="action-btns" style="justify-content: flex-end;">
            <button class="icon-btn" title="Visualizar PDF" onclick="visualizarPDF(${item.id})">👁</button>
            ${editBtn}
            ${!isConsultingMode ? `<button class="icon-btn" title="Reprocessar OCR clássico" onclick="reprocessarItem(${item.id})">↻</button>` : ''}
            <button class="icon-btn" title="Baixar PDF" onclick="baixarPDF(${item.id})">⬇</button>
            <button class="icon-btn danger" title="Remover" onclick="excluirItem(${item.id})">🗑</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('footer-summary').textContent =
    `${identificadas} nota(s) identificada(s) localmente. ${batchStats.paginas} página(s) analisadas.`;
}

function ativarEdicao(id) {
  editingId = id;
  renderizarResultados();
  const inp = document.getElementById(`input-nf-${id}`);
  if (inp) inp.focus();
}

async function salvarEdicao(id) {
  const inp = document.getElementById(`input-nf-${id}`);
  const novoNumero = inp ? inp.value.trim().replace(/[^\w\-]/g, '') : '';
  editingId = null;

  const item = batchItems.find(x => x.id === id);
  if (item) {
    if (novoNumero) {
      item.nfNumber = novoNumero;
      item.filename = `${novoNumero}.pdf`;
      item.status = 'identificado';
    } else {
      item.nfNumber = '';
      item.filename = `NF_SEM_NUMERO_${item.id}.pdf`;
      item.status = 'nao_identificado';
    }
  }
  await sincronizarRegistroNoDB();
  renderizarResultados();
}

async function reprocessarItem(id) {
  const item = batchItems.find(x => x.id === id);
  if (!item || !sourceArrayBuffer) return;

  const nfNum = await reprocessarPaginaUnica(sourceArrayBuffer, item.pageIndices[0]);
  if (nfNum) {
    item.nfNumber = nfNum;
    item.filename = `${nfNum}.pdf`;
    item.status = 'identificado';
    await sincronizarRegistroNoDB();
  } else {
    alert('Não foi possível ler o número automaticamente nesta página. Clique no ícone de lápis para digitar.');
  }
  renderizarResultados();
}

async function excluirItem(id) {
  batchItems = batchItems.filter(x => x.id !== id);
  await sincronizarRegistroNoDB();
  renderizarResultados();
}

function visualizarPDF(id) {
  const item = batchItems.find(x => x.id === id);
  if (!item || !item.pdfBytes) return;
  const blob = new Blob([item.pdfBytes], { type: 'application/pdf' });
  window.open(URL.createObjectURL(blob), '_blank');
}

function baixarPDF(id) {
  const item = batchItems.find(x => x.id === id);
  if (!item || !item.pdfBytes) return;
  const blob = new Blob([item.pdfBytes], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = item.filename;
  a.click();
}

async function baixarZip() {
  if (batchItems.length === 0) return;
  const zip = new JSZip();
  for (const item of batchItems) {
    if (item.pdfBytes) zip.file(item.filename, item.pdfBytes);
  }
  const content = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(content);
  a.download = `Notas_Fiscais_${new Date().toISOString().slice(0, 10)}.zip`;
  a.click();
}

function resetarSeparador() {
  selectedFile = null;
  sourceArrayBuffer = null;
  batchItems = [];
  editingId = null;
  currentRecordId = null;
  currentRecordMeta = null;
  isConsultingMode = false;
  document.getElementById('consulting-banner').classList.add('hidden');
  document.getElementById('pdf-input').value = '';
  document.getElementById('selected-file-box').classList.add('hidden');
  document.getElementById('step-results').classList.add('hidden');
  document.getElementById('step-upload').classList.remove('hidden');
}

// =========================================================================
// HISTÓRICO DE PROCESSAMENTOS
// =========================================================================
async function renderizarHistorico() {
  const registros = await dbListarProcessamentos();
  const termoNF = document.getElementById('filter-nf').value.trim().toLowerCase();
  const dataDe = document.getElementById('filter-from').value;
  const dataAte = document.getElementById('filter-to').value;

  const filtrados = registros.map(reg => {
    const matchedItems = termoNF
      ? (reg.items || []).filter(item =>
          (item.nfNumber && item.nfNumber.toLowerCase().includes(termoNF)) ||
          (item.filename && item.filename.toLowerCase().includes(termoNF))
        )
      : [];
    return { reg, matchedItems };
  }).filter(({ reg, matchedItems }) => {
    if (termoNF && matchedItems.length === 0) return false;
    if (dataDe) {
      const inicioDia = new Date(dataDe + 'T00:00:00').getTime();
      if (reg.timestamp < inicioDia) return false;
    }
    if (dataAte) {
      const fimDia = new Date(dataAte + 'T23:59:59.999').getTime();
      if (reg.timestamp > fimDia) return false;
    }
    return true;
  });

  const tbody = document.getElementById('history-tbody');
  if (filtrados.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center; color:var(--text-secondary); padding: 32px;">
          Nenhum registro encontrado para os filtros informados.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = filtrados.map(({ reg, matchedItems }) => {
    const statusStyle = reg.status === 'Com falhas'
      ? 'color: var(--text-primary); font-weight: 500;'
      : 'color: var(--success-text); font-weight: 600;';

    let html = `
      <tr>
        <td class="mono" style="font-size: 13px;">${formatarDataHoraBR(reg.timestamp)}</td>
        <td>${reg.ferramenta}</td>
        <td>${reg.pdfOriginal}</td>
        <td class="mono">${reg.notasIdentificadas}</td>
        <td class="mono">${reg.arquivosGerados}</td>
        <td style="${statusStyle}">${reg.status}</td>
        <td style="text-align: right;">
          <div class="action-btns" style="justify-content: flex-end;">
            <button class="btn-outline" onclick="consultarRegistro(${reg.id})">Consultar</button>
            <button class="btn-danger-outline" title="Excluir este conjunto do histórico" onclick="excluirConjuntoHistorico(${reg.id})">🗑</button>
          </div>
        </td>
      </tr>
    `;

    if (termoNF && matchedItems.length > 0) {
      html += `
        <tr class="matched-nf-row">
          <td colspan="7">
            <div class="linked-nf-box">
              <div class="linked-nf-header">
                <span>↳ Nota(s) encontrada(s) neste conjunto</span>
              </div>
              ${matchedItems.map(item => `
                <div class="linked-nf-item">
                  <div class="linked-nf-meta">
                    <span class="nf-highlight-tag">NF ${item.nfNumber || 'Sem número'}</span>
                    <span class="mono" style="font-size: 13px; font-weight: 600;">${item.filename}</span>
                    <span style="font-size: 12.5px; color: var(--text-secondary);">(${item.pageIndices.length} pág.)</span>
                  </div>
                  <div class="action-btns">
                    <button class="btn-outline" onclick="visualizarItemHistorico(${reg.id}, ${item.id})">👁 Visualizar NF</button>
                    <button class="btn-primary" style="padding: 7px 14px; font-size: 13px;" onclick="baixarItemHistorico(${reg.id}, ${item.id})">⬇ Baixar NF</button>
                  </div>
                </div>
              `).join('')}
            </div>
          </td>
        </tr>
      `;
    }

    return html;
  }).join('');
}

async function visualizarItemHistorico(recordId, itemId) {
  const reg = await dbObterPorId(recordId);
  if (!reg) return;
  const item = (reg.items || []).find(x => x.id === itemId);
  if (!item || !item.pdfBytes) return;
  const blob = new Blob([item.pdfBytes], { type: 'application/pdf' });
  window.open(URL.createObjectURL(blob), '_blank');
}

async function baixarItemHistorico(recordId, itemId) {
  const reg = await dbObterPorId(recordId);
  if (!reg) return;
  const item = (reg.items || []).find(x => x.id === itemId);
  if (!item || !item.pdfBytes) return;
  const blob = new Blob([item.pdfBytes], { type: 'application/pdf' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = item.filename;
  a.click();
}

async function excluirConjuntoHistorico(recordId) {
  if (!confirm('Deseja excluir este conjunto do histórico? Os indicadores do Dashboard serão atualizados automaticamente.')) return;
  await dbExcluirPorId(recordId);
  if (currentRecordId === recordId) {
    currentRecordId = null;
    currentRecordMeta = null;
  }
  renderizarHistorico();
  carregarDashboard();
}

function limparFiltrosHistorico() {
  document.getElementById('filter-nf').value = '';
  document.getElementById('filter-from').value = '';
  document.getElementById('filter-to').value = '';
  renderizarHistorico();
}

async function consultarRegistro(id) {
  const reg = await dbObterPorId(id);
  if (!reg) return;

  isConsultingMode = true;
  currentRecordId = reg.id;
  currentRecordMeta = reg;
  batchItems = reg.items || [];
  batchStats = { paginas: reg.paginasAnalisadas, tempo: reg.tempo };
  editingId = null;

  navigate('separador');
  document.getElementById('step-upload').classList.add('hidden');
  document.getElementById('step-processing').classList.add('hidden');
  document.getElementById('step-results').classList.remove('hidden');

  document.getElementById('consulting-banner').classList.remove('hidden');
  document.getElementById('consulting-filename').textContent =
    `${reg.pdfOriginal} (${formatarDataHoraBR(reg.timestamp)})`;

  renderizarResultados();
}

// =========================================================================
// BACKUP / EXPORTAÇÃO JSON DO INDEXEDDB
// =========================================================================
async function exportarBackupJSON() {
  const registros = await dbListarProcessamentos();
  const payload = registros.map(r => ({
    timestamp: r.timestamp,
    ferramenta: r.ferramenta,
    pdfOriginal: r.pdfOriginal,
    paginasAnalisadas: r.paginasAnalisadas,
    notasIdentificadas: r.notasIdentificadas,
    arquivosGerados: r.arquivosGerados,
    precisamRevisao: r.precisamRevisao,
    tempo: r.tempo,
    status: r.status,
    items: (r.items || []).map(i => ({
      id: i.id,
      pageIndices: i.pageIndices,
      nfNumber: i.nfNumber,
      filename: i.filename,
      status: i.status
    }))
  }));

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Registro_NFs_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
}

async function importarBackupJSON(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const lista = JSON.parse(text);
    if (!Array.isArray(lista)) throw new Error('Formato inválido');
    for (const reg of lista) {
      delete reg.id;
      await dbSalvarProcessamento(reg);
    }
    alert(`${lista.length} registro(s) importado(s) com sucesso!`);
    carregarDashboard();
  } catch (e) {
    alert('Erro ao importar arquivo JSON: ' + e.message);
  }
}

async function limparTodoBanco() {
  if (!confirm('Tem certeza que deseja apagar todos os registros salvos neste navegador?')) return;
  await dbLimparTudo();
  carregarDashboard();
  alert('Histórico limpo.');
}

// Expõe funções chamadas pelos eventos onclick/oninput do HTML
Object.assign(window, {
  toggleSidebar,
  navigate,
  handleFileSelect,
  iniciarProcessamento,
  resetarSeparador,
  baixarZip,
  ativarEdicao,
  salvarEdicao,
  reprocessarItem,
  excluirItem,
  visualizarPDF,
  baixarPDF,
  renderizarHistorico,
  limparFiltrosHistorico,
  consultarRegistro,
  excluirConjuntoHistorico,
  visualizarItemHistorico,
  baixarItemHistorico,
  exportarBackupJSON,
  importarBackupJSON,
  limparTodoBanco
});

// Inicializa Dashboard
carregarDashboard();