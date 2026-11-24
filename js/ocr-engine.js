// Módulo de Leitura de PDF, OCR Clássico Ultra-Rápido (< 20s) e Alta Precisão (Sem IA)
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

const UFS_VALIDAS = new Set([
  '11','12','13','14','15','16','17',
  '21','22','23','24','25','26','27','28','29',
  '31','32','33','35',
  '41','42','43',
  '50','51','52','53'
]);

// Valida Chave de Acesso NF-e (44 dígitos) via estrutura fiscal (UF, AAMM, Modelo) + Dígito Verificador (Módulo 11)
function validarChaveNFe(chave44) {
  if (!/^\d{44}$/.test(chave44)) return false;

  const uf = chave44.substring(0, 2);
  if (!UFS_VALIDAS.has(uf)) return false;

  const aa = parseInt(chave44.substring(2, 4), 10);
  const mm = parseInt(chave44.substring(4, 6), 10);
  if (aa < 15 || aa > 40 || mm < 1 || mm > 12) return false;

  const modelo = chave44.substring(20, 22);
  if (modelo !== '55' && modelo !== '65') return false;

  const base43 = chave44.substring(0, 43);
  const dvInformado = parseInt(chave44[43], 10);

  let soma = 0;
  let peso = 2;
  for (let i = 42; i >= 0; i--) {
    soma += parseInt(base43[i], 10) * peso;
    peso = peso === 9 ? 2 : peso + 1;
  }

  const resto = soma % 11;
  const dvCalculado = (resto === 0 || resto === 1) ? 0 : (11 - resto);
  return dvCalculado === dvInformado;
}

// Corrige confusões visuais comuns do OCR apenas em tokens curtos numéricos (ex: O->0, I/l->1, B->8)
function normalizarTextoChave(texto) {
  return texto.replace(/\b[0-9OIlSBZG]{3,8}\b/g, (bloco) => {
    if (!/\d/.test(bloco)) return bloco;
    return bloco
      .replace(/O/g, '0')
      .replace(/[Il]/g, '1')
      .replace(/Z/g, '2')
      .replace(/S/g, '5')
      .replace(/G/g, '6')
      .replace(/B/g, '8');
  });
}

// Extrai o número da NF a partir de uma Chave de Acesso validada pelo Módulo 11
function extrairChaveValidada(texto) {
  const normalizado = normalizarTextoChave(texto);
  const apenasDigitos = normalizado.replace(/[^0-9\s]/g, ' ').replace(/\s+/g, '');
  if (apenasDigitos.length < 44) return null;

  for (let i = 0; i <= apenasDigitos.length - 44; i++) {
    const candidata = apenasDigitos.substring(i, i + 44);
    if (validarChaveNFe(candidata)) {
      const nf = candidata.substring(25, 34).replace(/^0+/, '');
      if (nf) return nf;
    }
  }
  return null;
}

// Detecta indicador "FOLHA X/Y" (ex: "FOLHA 2/3", "FOLHA 3/3", "FOLHA 313", "FOLHA 3 3")
function extrairInfoFolha(texto) {
  const limpo = texto.replace(/\s+/g, ' ');
  const match = limpo.match(/FOLHA\s*([1-9][0-9]?)\s*[\/\\|1Il\s]\s*([1-9][0-9]?)/i);
  if (match) {
    const atual = parseInt(match[1], 10);
    const total = parseInt(match[2], 10);
    if (atual >= 1 && total >= atual && total <= 50) {
      return { atual, total };
    }
  }
  const matchSemBarra = limpo.match(/FOLHA\s*([1-9])([2-9])\b/i);
  if (matchSemBarra) {
    const atual = parseInt(matchSemBarra[1], 10);
    const total = parseInt(matchSemBarra[2], 10);
    if (total >= atual) {
      return { atual, total };
    }
  }
  return null;
}

export function extrairNumeroNF(texto) {
  const limpo = texto.replace(/\s+/g, ' ');
  const votos = new Map();

  const registrarVoto = (numBruto, peso) => {
    const apenasDigitos = (numBruto || '').replace(/\D/g, '');
    if (apenasDigitos.startsWith('33449988')) return;

    const semZeros = apenasDigitos.replace(/^0+/, '');
    if (semZeros.length >= 4 && semZeros.length <= 7) {
      votos.set(semZeros, (votos.get(semZeros) || 0) + peso);
    }
  };

  // 1. Chave de acesso de 44 dígitos validada estruturalmente + Módulo 11
  const nfChave = extrairChaveValidada(limpo);
  if (nfChave) {
    registrarVoto(nfChave, 25);
  }

  // 2. Padrão explícito DANFE com símbolo ordinal ("N°000410823", "Nº 000.410.823", "No 000410823")
  const regexDanfe = /N[º°o]\s*[:\-]?\s*(0{1,4}[1-9][0-9]{3,7}|[0-9]{1,3}(?:\.[0-9]{3}){1,2})/gi;
  let m;
  while ((m = regexDanfe.exec(limpo)) !== null) {
    const bruto = m[1].replace(/\D/g, '');
    const peso = (bruto.length === 9 && bruto.startsWith('00')) ? 12 : 6;
    registrarVoto(m[1], peso);
  }

  // 3. Sequência de 9 dígitos começando com "000" (ex: "000410823"), mesmo encostada em bordas
  const regexZeroPadded = /(?:^|\D)(000[1-9][0-9]{5})(?:\D|$)/g;
  while ((m = regexZeroPadded.exec(limpo)) !== null) {
    registrarVoto(m[1], 10);
  }

  // 4. Padrão imediatamente antes de SÉRIE (ex: "000410823 SÉRIE 1" ou "411574 SÉRIE 1")
  const regexSerie = /([0-9]{6,9}|[0-9]{1,3}(?:\.[0-9]{3}){1,2})\s*S[ÉE]RIE\s*[0-9]{1,3}/gi;
  while ((m = regexSerie.exec(limpo)) !== null) {
    const bruto = m[1].replace(/\D/g, '');
    if (!bruto.startsWith('00') && bruto.length > 7) continue;
    const peso = bruto.startsWith('00') ? 9 : 4;
    registrarVoto(m[1], peso);
  }

  // 5. Padrão NFS-e (Prefeitura)
  const nfseMatch = limpo.match(/N[úu]mero da Nota[^0-9]{0,25}([0-9\.]{1,15})/i);
  if (nfseMatch) {
    registrarVoto(nfseMatch[1], 5);
  }

  if (votos.size === 0) return null;

  let melhorNumero = null;
  let maiorPeso = -1;
  for (const [num, peso] of votos.entries()) {
    if (peso > maiorPeso) {
      maiorPeso = peso;
      melhorNumero = num;
    }
  }
  return melhorNumero;
}

function binarizarCanvas(ctx, width, height, limiar = 158) {
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const bin = lum < limiar ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = bin;
  }
  ctx.putImageData(imgData, 0, 0);
}

// =========================================================================
// POOL PERSISTENTE E PRÉ-AQUECIDO DE WORKERS (ELIMINA COLD-START)
// =========================================================================
let sharedWorkers = [];
let sharedWorkersPromise = null;

function getIdealPoolSize(maxPages = 4) {
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 4) : 4;
  return Math.min(4, Math.max(2, cores), maxPages);
}

async function criarWorkerOtimizado() {
  const w = await Tesseract.createWorker('eng');
  await w.setParameters({
    tessedit_pageseg_mode: '11',
    tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz°º/.:- '
  });
  return w;
}

export function preaquecerOCR(qtdPaginas = 4) {
  const alvo = getIdealPoolSize(qtdPaginas);
  if (sharedWorkers.length >= alvo) return Promise.resolve(sharedWorkers);
  if (sharedWorkersPromise) return sharedWorkersPromise;

  sharedWorkersPromise = (async () => {
    try {
      const faltam = alvo - sharedWorkers.length;
      const novos = await Promise.all(
        Array.from({ length: faltam }, () => criarWorkerOtimizado())
      );
      sharedWorkers.push(...novos);
      return sharedWorkers;
    } finally {
      sharedWorkersPromise = null;
    }
  })();

  return sharedWorkersPromise;
}

// Renderiza o cabeçalho superior direito (33% a 100% da largura, 34% da altura) em escala 2.3x
async function renderizarCabecalhoOtimizado(pdfPage, scale = 2.3) {
  const viewport = pdfPage.getViewport({ scale });
  const cropX = Math.floor(viewport.width * 0.33);
  const cropW = Math.floor(viewport.width * 0.67);
  const cropH = Math.floor(viewport.height * 0.34);

  const canvasTopo = document.createElement('canvas');
  canvasTopo.width = cropW;
  canvasTopo.height = cropH;
  const ctxTopo = canvasTopo.getContext('2d', { willReadFrequently: true });
  ctxTopo.fillStyle = '#FFFFFF';
  ctxTopo.fillRect(0, 0, cropW, cropH);

  await pdfPage.render({
    canvasContext: ctxTopo,
    viewport,
    transform: [1, 0, 0, 1, -cropX, 0]
  }).promise;

  binarizarCanvas(ctxTopo, cropW, cropH, 158);
  return { canvasTopo, viewport };
}

async function reconhecerComWorkerReutilizavel(pdfPage, worker) {
  const { canvasTopo, viewport } = await renderizarCabecalhoOtimizado(pdfPage, 2.3);

  // Passo A: Cabeçalho direito superior (34% altura x 67% largura)
  const { data: { text: textoTopo } } = await worker.recognize(canvasTopo);
  const numTopo = extrairNumeroNF(textoTopo);
  const chaveConfirmada = extrairChaveValidada(textoTopo);

  // Se a chave Módulo 11 bateu OU encontrou número completo (>= 6 dígitos), encerra na 1ª leitura!
  if (chaveConfirmada || (numTopo && numTopo.length >= 6)) {
    return textoTopo;
  }

  // Passo B (somente se Passo A não achou ou ficou curto, ex: 5 dígitos): zoom 1.4x
  const canvasZoom = document.createElement('canvas');
  canvasZoom.width = Math.floor(canvasTopo.width * 1.4);
  canvasZoom.height = Math.floor(canvasTopo.height * 1.4);
  const ctxZoom = canvasZoom.getContext('2d');
  ctxZoom.drawImage(canvasTopo, 0, 0, canvasZoom.width, canvasZoom.height);

  const { data: { text: textoZoom } } = await worker.recognize(canvasZoom);
  const textoCombinado = `${textoTopo}\n${textoZoom}`;

  if (extrairNumeroNF(textoCombinado) || extrairInfoFolha(textoCombinado)) {
    return textoCombinado;
  }

  // Passo C (Fallback): Página inteira caso esteja rotacionada/de ponta-cabeça
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = viewport.width;
  fullCanvas.height = viewport.height;
  const fullCtx = fullCanvas.getContext('2d');
  fullCtx.filter = 'grayscale(100%) contrast(155%)';
  await pdfPage.render({ canvasContext: fullCtx, viewport }).promise;

  const { data: { text: textoCompleto } } = await worker.recognize(fullCanvas);
  return textoCompleto;
}

export async function lerPaginaComOCRClassico(pdfPage) {
  const pool = await preaquecerOCR(1);
  return reconhecerComWorkerReutilizavel(pdfPage, pool[0]);
}

export async function contarPaginasPDF(arrayBuffer) {
  const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  return pdfDoc.numPages;
}

function saoNumerosCompativeis(numAnterior, numAtual, infoFolha, aguardandoFolhasRestantes = false) {
  if (!numAnterior || !numAtual) return false;
  if (numAnterior === numAtual) return true;

  const ehFolhaSeguinte = (infoFolha && infoFolha.atual > 1) || aguardandoFolhasRestantes;
  if (ehFolhaSeguinte) {
    if (numAnterior.includes(numAtual) || numAtual.includes(numAnterior)) return true;
    if (numAnterior.length === numAtual.length) {
      let diffs = 0;
      for (let i = 0; i < numAnterior.length; i++) {
        if (numAnterior[i] !== numAtual[i]) diffs++;
      }
      if (diffs <= 2) return true;
    }
  }
  return false;
}

export async function processarLotePDF(arrayBuffer, onProgress) {
  const pdfJsDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const srcPdfLibDoc = await PDFLib.PDFDocument.load(arrayBuffer.slice(0));
  const totalPages = pdfJsDoc.numPages;

  const poolSize = getIdealPoolSize(totalPages);
  let concluidas = 0;

  const pool = await preaquecerOCR(poolSize);

  const textosPorPagina = new Array(totalPages).fill('');
  let cursor = 0;

  async function executarFila(workerIndex) {
    const worker = pool[workerIndex];
    while (true) {
      const pageIdx = cursor++;
      if (pageIdx >= totalPages) break;

      const page = await pdfJsDoc.getPage(pageIdx + 1);
      const textContent = await page.getTextContent();
      let texto = textContent.items.map(item => item.str).join(' ');

      if (texto.trim().length < 15) {
        try {
          texto = await reconhecerComWorkerReutilizavel(page, worker);
        } catch (e) {
          console.warn('Falha OCR página ' + (pageIdx + 1), e);
        }
      }

      textosPorPagina[pageIdx] = texto;
      concluidas++;
      if (onProgress) {
        const pct = 20 + Math.round((concluidas / totalPages) * 65);
        onProgress(pct, 3);
      }
    }
  }

  await Promise.all(
    Array.from({ length: poolSize }, (_, idx) => executarFila(idx))
  );

  const items = [];
  let semNumeroIdx = 1;
  const usedFilenames = new Set();

  for (let i = 0; i < totalPages; i++) {
    const texto = textosPorPagina[i];
    const nfNum = extrairNumeroNF(texto);
    const infoFolha = extrairInfoFolha(texto);
    const ultimoItem = items.length > 0 ? items[items.length - 1] : null;

    // Se o número extraído é idêntico ao da página anterior, é garantidamente a mesma nota
    const mesmoNumeroExato = Boolean(ultimoItem && nfNum && ultimoItem.nfNumber === nfNum);

    // Verifica se a NF anterior declarou "FOLHA 1/3" ou "FOLHA 2/3" e ainda faltam folhas
    const aguardandoFolhasRestantes = Boolean(
      ultimoItem &&
      ultimoItem.expectedTotalPages > 1 &&
      ultimoItem.pageIndices.length < ultimoItem.expectedTotalPages
    );

    const chaveNovaValidada = extrairChaveValidada(texto);
    const ehNovaNotaConfirmada = !mesmoNumeroExato && Boolean(
      (chaveNovaValidada && ultimoItem && chaveNovaValidada !== ultimoItem.nfNumber) ||
      (infoFolha && infoFolha.atual === 1 && nfNum && ultimoItem && nfNum !== ultimoItem.nfNumber)
    );

    const ehContinuacaoMesmaNF = ultimoItem && !ehNovaNotaConfirmada && (
      mesmoNumeroExato ||
      saoNumerosCompativeis(ultimoItem.nfNumber, nfNum, infoFolha, aguardandoFolhasRestantes) ||
      (!nfNum && ultimoItem.nfNumber) ||
      (aguardandoFolhasRestantes && ultimoItem.nfNumber)
    );

    if (ehContinuacaoMesmaNF) {
      ultimoItem.pageIndices.push(i);
      if (infoFolha && infoFolha.total > (ultimoItem.expectedTotalPages || 1)) {
        ultimoItem.expectedTotalPages = infoFolha.total;
      }
    } else {
      let filename = nfNum ? `${nfNum}.pdf` : `NF_SEM_NUMERO_${semNumeroIdx++}.pdf`;
      let dup = 1;
      const base = filename.replace('.pdf', '');
      while (usedFilenames.has(filename)) {
        filename = `${base}_${dup++}.pdf`;
      }
      usedFilenames.add(filename);

      items.push({
        id: i + 1,
        pageIndices: [i],
        nfNumber: nfNum || '',
        filename,
        status: nfNum ? 'identificado' : 'nao_identificado',
        expectedTotalPages: infoFolha ? infoFolha.total : 1,
        pdfBytes: null
      });
    }
  }

  if (onProgress) onProgress(88, 4);

  await Promise.all(items.map(async (item) => {
    const newPdf = await PDFLib.PDFDocument.create();
    const copiedPages = await newPdf.copyPages(srcPdfLibDoc, item.pageIndices);
    copiedPages.forEach(p => newPdf.addPage(p));
    item.pdfBytes = await newPdf.save();
  }));

  if (onProgress) onProgress(100, 5);
  return { items, totalPages };
}

export async function reprocessarPaginaUnica(arrayBuffer, pageIndex) {
  const pdfJsDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const page = await pdfJsDoc.getPage(pageIndex + 1);
  const texto = await lerPaginaComOCRClassico(page);
  return extrairNumeroNF(texto);
}
