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
  reprocessarPaginaUnica,
  preaquecerOCR
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
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  if (!sidebar) return;
  const isMobile = window.innerWidth <= 960;

  if (isMobile) {
    const isOpen = sidebar.classList.toggle('mobile-open');
    if (backdrop) backdrop.classList.toggle('visible', isOpen);
  } else {
    sidebar.classList.toggle('collapsed');
  }
}

function navigate(view) {
  ['dashboard', 'separador', 'historico', 'configuracoes'].forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('hidden', v !== view);
  });

  const navDash = document.getElementById('nav-dashboard');
  const navSep = document.getElementById('nav-separador');
  const navHist = document.getElementById('nav-historico');
  const navConf = document.getElementById('nav-configuracoes');
  if (navDash) navDash.classList.toggle('active', view === 'dashboard');
  if (navSep) navSep.classList.toggle('active', view === 'separador');
  if (navHist) navHist.classList.toggle('active', view === 'historico');
  if (navConf) navConf.classList.toggle('active', view === 'configuracoes');

  if (window.innerWidth <= 960) {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('mobile-open');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (backdrop) backdrop.classList.remove('visible');
  }

  const crumbs = {
    dashboard: '<span>Dashboard</span>',
    separador: 'Ferramentas / <span>Separador de Notas Fiscais</span>',
    historico: '<span>Histórico de Processamentos</span>',
    configuracoes: '<span>Configurações</span>'
  };
  const bc = document.getElementById('breadcrumb');
  if (bc) bc.innerHTML = crumbs[view] || '';

  if (view === 'dashboard') carregarDashboard();
  if (view === 'separador') preaquecerOCR(4).catch(() => {});
  if (view === 'historico') renderizarHistorico();
}

// =========================================================================
// DASHBOARD
// =========================================================================
async function carregarDashboard() {
  const container = document.getElementById('dash-history-container');
  try {
    const registros = await dbListarProcessamentos();
    const totalDocs = registros.length;
    const totalNfs = registros.reduce((acc, r) => acc + (r.notasIdentificadas || 0), 0);
    const totalArqs = registros.reduce((acc, r) => acc + (r.arquivosGerados || 0), 0);

    document.getElementById('stat-docs').textContent = totalDocs;
    document.getElementById('stat-nfs').textContent = totalNfs;
    document.getElementById('stat-files').textContent = totalArqs;

    if (!container) return;
    if (registros.length === 0) {
      container.className = 'empty-box';
      container.innerHTML = 'Nenhum processamento registrado na nuvem ainda.';
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
                    <button type="button" class="btn-outline" onclick="consultarRegistro(${r.id})">Consultar</button>
                    <button type="button" class="btn-danger-outline" title="Excluir conjunto" onclick="excluirConjuntoHistorico(${r.id})">🗑</button>
                  </div>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }
  } catch (err) {
    console.error('Erro ao carregar dashboard:', err);
    if (container) {
      container.className = 'empty-box';
      container.innerHTML = 'Nenhum processamento carregado no momento.';
    }
  }
}

// =========================================================================
// UPLOAD E PROCESSAMENTO
// =========================================================================
function inicializarDropzone() {
  const dropzone = document.getElementById('dropzone');
  if (!dropzone) return;
  dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
  });
}

async function handleFileSelect(file) {
  if (!file || !file.name.toLowerCase().endsWith('.pdf')) {
    alert('Selecione um arquivo PDF válido.');
    return;
  }
  selectedFile = file;
  preaquecerOCR(4).catch(() => {});
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

  try {
    currentRecordId = await dbSalvarProcessamento(currentRecordMeta);
    currentRecordMeta.id = currentRecordId;
  } catch (err) {
    console.error('Erro ao salvar no Supabase:', err);
    alert('As NFs foram separadas na sessão, mas houve erro ao registrar no Supabase: ' + err.message);
  }

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
  const temArquivosNaSessao = batchItems.some(x => Boolean(x.pdfBytes));

  document.getElementById('res-paginas').textContent = batchStats.paginas;
  document.getElementById('res-identificadas').textContent = identificadas;
  document.getElementById('res-gerar').textContent = batchItems.length;
  document.getElementById('res-revisao').textContent = revisao;
  document.getElementById('res-tempo').textContent = batchStats.tempo;

  document.getElementById('res-subinfo').textContent =
    `${batchItems.length} arquivo(s) · ${revisao} aguardando revisão`;

  const btnZip = document.getElementById('btn-download-zip');
  if (btnZip) btnZip.classList.toggle('hidden', !temArquivosNaSessao);

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
      ? `<button type="button" class="icon-btn confirm" title="Confirmar" onclick="salvarEdicao(${item.id})">✓</button>`
      : `<button type="button" class="icon-btn" title="Editar número da NF" onclick="ativarEdicao(${item.id})">✎</button>`;

    const sessionActions = item.pdfBytes
      ? `
        <button type="button" class="icon-btn" title="Visualizar PDF (Sessão atual)" onclick="visualizarPDF(${item.id})">👁</button>
        ${editBtn}
        <button type="button" class="icon-btn" title="Reprocessar OCR clássico" onclick="reprocessarItem(${item.id})">↻</button>
        <button type="button" class="icon-btn" title="Baixar PDF (Sessão atual)" onclick="baixarPDF(${item.id})">⬇</button>
        <button type="button" class="icon-btn danger" title="Remover" onclick="excluirItem(${item.id})">🗑</button>
      `
      : `
        ${editBtn}
        <button type="button" class="icon-btn danger" title="Remover registro" onclick="excluirItem(${item.id})">🗑</button>
      `;

    return `
      <tr>
        <td>${nfCell}</td>
        <td>${item.pageIndices.length}</td>
        <td class="mono" style="font-size: 13px;">${item.filename}</td>
        <td>${statusBadge}</td>
        <td>
          <div class="action-btns" style="justify-content: flex-end;">
            ${sessionActions}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  document.getElementById('footer-summary').textContent = temArquivosNaSessao
    ? `${identificadas} nota(s) identificada(s). Os arquivos PDF estão disponíveis para download apenas nesta sessão.`
    : `Consulta de registro sincronizado na nuvem (arquivos PDF disponíveis apenas na sessão em que foram gerados).`;
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
  const itensComBytes = batchItems.filter(x => Boolean(x.pdfBytes));
  if (itensComBytes.length === 0) return;
  const zip = new JSZip();
  for (const item of itensComBytes) {
    zip.file(item.filename, item.pdfBytes);
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
// HISTÓRICO DE PROCESSAMENTOS (SINCRONIZADO ENTRE PC E CELULAR)
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
            <button type="button" class="btn-outline" onclick="consultarRegistro(${reg.id})">Consultar</button>
            <button type="button" class="btn-danger-outline" title="Excluir este conjunto do histórico" onclick="excluirConjuntoHistorico(${reg.id})">🗑</button>
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
                  <span style="font-size: 12px; color: var(--success-text); font-weight: 600;">✓ Registrada no lote ${reg.pdfOriginal}</span>
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

async function excluirConjuntoHistorico(recordId) {
  if (!confirm('Deseja excluir este conjunto do histórico? Os indicadores do Dashboard serão atualizados em todos os dispositivos.')) return;
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
// BACKUP / EXPORTAÇÃO JSON
// =========================================================================
async function exportarBackupJSON() {
  const registros = await dbListarProcessamentos();
  const blob = new Blob([JSON.stringify(registros, null, 2)], { type: 'application/json' });
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
    alert(`${lista.length} registro(s) importado(s) para o banco online!`);
    carregarDashboard();
  } catch (e) {
    alert('Erro ao importar arquivo JSON: ' + e.message);
  }
}

async function limparTodoBanco() {
  if (!confirm('Tem certeza que deseja apagar todos os registros salvos no banco online?')) return;
  await dbLimparTudo();
  carregarDashboard();
  alert('Histórico limpo.');
}

// Registra todas as funções no escopo global imediatamente
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
  exportarBackupJSON,
  importarBackupJSON,
  limparTodoBanco
});

// Inicializa eventos e carrega o Dashboard
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    inicializarDropzone();
    carregarDashboard();
  });
} else {
  inicializarDropzone();
  carregarDashboard();
}
