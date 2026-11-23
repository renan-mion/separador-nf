// Módulo de Leitura de PDF, OCR Clássico e Extração de Número de NF (Sem IA)
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Valida se uma sequência de 44 dígitos é uma Chave de Acesso NF-e legítima via Dígito Verificador (Módulo 11)
function validarChaveNFe(chave44) {
  if (!/^\d{44}$/.test(chave44)) return false;

  // Modelo 55 (NF-e) ou 65 (NFC-e) nas posições 20..22 e série/número não zerados
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

// Procura todas as chaves válidas no texto (usando janela deslizante + Módulo 11)
function extrairChaveValidada(texto) {
  // Normaliza apenas caracteres confusos dentro de blocos numéricos da chave (ex: O->0, I/l->1)
  const apenasBlocos = texto.replace(/[^0-9\s]/g, ' ').replace(/\s+/g, '');
  if (apenasBlocos.length < 44) return null;

  for (let i = 0; i <= apenasBlocos.length - 44; i++) {
    const candidata = apenasBlocos.substring(i, i + 44);
    if (validarChaveNFe(candidata)) {
      const nf = candidata.substring(25, 34).replace(/^0+/, '');
      if (nf) return nf;
    }
  }
  return null;
}

// Detecta indicador "FOLHA X/Y" (ex: "FOLHA 2/3" -> { atual: 2, total: 3 })
function extrairInfoFolha(texto) {
  const limpo = texto.replace(/\s+/g, ' ');
  const match = limpo.match(/FOLHA\s*([1-9][0-9]?)\s*[\/\\|1I]\s*([1-9][0-9]?)/i);
  if (match) {
    const atual = parseInt(match[1], 10);
    const total = parseInt(match[2], 10);
    if (atual >= 1 && total >= atual && total <= 50) {
      return { atual, total };
    }
  }
  return null;
}

export function extrairNumeroNF(texto) {
  const limpo = texto.replace(/\s+/g, ' ');
  const votos = new Map();
  const registrarVoto = (numStr, peso) => {
    const limpoNum = (numStr || '').replace(/\D/g, '').replace(/^0+/, '');
    if (limpoNum.length >= 4 && limpoNum.length <= 9) {
      votos.set(limpoNum, (votos.get(limpoNum) || 0) + peso);
    }
  };

  // 1. Chave de acesso validada matematicamente pelo Módulo 11 (peso máximo)
  const nfChave = extrairChaveValidada(limpo);
  if (nfChave) {
    registrarVoto(nfChave, 10);
  }

  // 2. Padrão explícito DANFE ABB ("N°000410823" ou "N° 000410823" antes de SÉRIE/FOLHA)
  const regexDanfe = /N[º°o\.]\s*[:\-]?\s*([0-9]{1,3}(?:\.[0-9]{3}){1,2}|[0-9]{6,9})/gi;
  let m;
  while ((m = regexDanfe.exec(limpo)) !== null) {
    registrarVoto(m[1], 5);
  }

  // 3. Padrão canhoto ou bloco central imediatamente antes de SÉRIE
  const regexSerie = /([0-9]{6,9}|[0-9]{1,3}(?:\.[0-9]{3}){1,2})\s*S[ÉE]RIE\s*[0-9]{1,3}/gi;
  while ((m = regexSerie.exec(limpo)) !== null) {
    registrarVoto(m[1], 4);
  }

  // 4. Padrão NFS-e (Prefeitura)
  const nfseMatch = limpo.match(/N[úu]mero da Nota[^0-9]{0,25}([0-9\.]{1,15})/i);
  if (nfseMatch) {
    registrarVoto(nfseMatch[1], 5);
  }

  if (votos.size === 0) return null;

  // Retorna o número com maior pontuação de consenso
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

// Binarização limpa com leve erosão/contraste para separar dígitos encostados em bordas de tabela
function binarizarCanvas(ctx, width, height, limiar = 155) {
  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const bin = lum < limiar ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = bin;
  }
  ctx.putImageData(imgData, 0, 0);
}

export async function lerPaginaComOCRClassico(pdfPage) {
  const worker = await Tesseract.createWorker('por');
  const viewport = pdfPage.getViewport({ scale: 3.2 });

  // Passo A: Cabeçalho superior completo (42% da altura) onde ficam canhoto, N° NF, FOLHA e Chave
  const cropHeight = Math.floor(viewport.height * 0.42);
  const canvasTopo = document.createElement('canvas');
  canvasTopo.width = viewport.width;
  canvasTopo.height = cropHeight;
  const ctxTopo = canvasTopo.getContext('2d');

  await pdfPage.render({ canvasContext: ctxTopo, viewport }).promise;
  binarizarCanvas(ctxTopo, canvasTopo.width, canvasTopo.height, 155);

  const { data: { text: textoTopo } } = await worker.recognize(canvasTopo);
  const numTopo = extrairNumeroNF(textoTopo);
  const folhaTopo = extrairInfoFolha(textoTopo);

  // Passo B: Recorte de alta precisão focado no quadro DANFE + Chave de Acesso (centro/direita do topo)
  // Resolve casos onde a borda vertical da caixa colou no último dígito do N° (ex: N°000411574|)
  const roiX = Math.floor(viewport.width * 0.34);
  const roiY = Math.floor(viewport.height * 0.04);
  const roiW = Math.floor(viewport.width * 0.62);
  const roiH = Math.floor(viewport.height * 0.28);

  const canvasRoi = document.createElement('canvas');
  canvasRoi.width = roiW;
  canvasRoi.height = roiH;
  const ctxRoi = canvasRoi.getContext('2d');
  ctxRoi.drawImage(canvasTopo, roiX, roiY, roiW, roiH, 0, 0, roiW, roiH);

  const { data: { text: textoRoi } } = await worker.recognize(canvasRoi);
  const textoCombinado = `${textoTopo}\n${textoRoi}`;

  if (numTopo || extrairNumeroNF(textoCombinado) || folhaTopo) {
    await worker.terminate();
    return textoCombinado;
  }

  // Passo C (Fallback): Página inteira caso o documento esteja rotacionado/desalinhado
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = viewport.width;
  fullCanvas.height = viewport.height;
  const fullCtx = fullCanvas.getContext('2d');
  fullCtx.filter = 'grayscale(100%) contrast(155%)';
  await pdfPage.render({ canvasContext: fullCtx, viewport }).promise;

  const { data: { text: textoCompleto } } = await worker.recognize(fullCanvas);
  await worker.terminate();
  return textoCompleto;
}

export async function contarPaginasPDF(arrayBuffer) {
  const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  return pdfDoc.numPages;
}

// Verifica se dois números de NF são equivalentes (iguais ou variação de 1 dígito por ruído em folha seguinte)
function saoNumerosCompativeis(numAnterior, numAtual, infoFolha) {
  if (!numAnterior || !numAtual) return false;
  if (numAnterior === numAtual) return true;

  // Se a página indica explicitamente continuação (ex: FOLHA 2/3 ou FOLHA 3/3)
  if (infoFolha && infoFolha.atual > 1) {
    // Ex: anterior "411574" e atual "41157" (perdeu o último dígito na borda) ou 1 dígito trocado
    if (numAnterior.startsWith(numAtual) || numAtual.startsWith(numAnterior)) return true;
    if (numAnterior.length === numAtual.length) {
      let diffs = 0;
      for (let i = 0; i < numAnterior.length; i++) {
        if (numAnterior[i] !== numAtual[i]) diffs++;
      }
      if (diffs <= 1) return true;
    }
  }
  return false;
}

export async function processarLotePDF(arrayBuffer, onProgress) {
  const pdfJsDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const srcPdfLibDoc = await PDFLib.PDFDocument.load(sourceArrayBufferCopy(arrayBuffer));

  const items = [];
  let semNumeroIdx = 1;
  const usedFilenames = new Set();

  for (let i = 0; i < pdfJsDoc.numPages; i++) {
    const pct = 20 + Math.round(((i + 1) / pdfJsDoc.numPages) * 60);
    if (onProgress) onProgress(pct, 3);

    const page = await pdfJsDoc.getPage(i + 1);
    const textContent = await page.getTextContent();
    let texto = textContent.items.map(item => item.str).join(' ');

    if (texto.trim().length < 15) {
      try {
        texto = await lerPaginaComOCRClassico(page);
      } catch (e) {
        console.warn('Falha OCR página ' + (i + 1), e);
      }
    }

    const nfNum = extrairNumeroNF(texto);
    const infoFolha = extrairInfoFolha(texto);
    const ultimoItem = items.length > 0 ? items[items.length - 1] : null;

    // Agrupa na nota anterior se for o mesmo número OU continuação confirmada (FOLHA 2/3, 3/3...)
    const ehContinuacaoMesmaNF = ultimoItem && (
      saoNumerosCompativeis(ultimoItem.nfNumber, nfNum, infoFolha) ||
      (!nfNum && infoFolha && infoFolha.atual > 1 && ultimoItem.nfNumber)
    );

    if (ehContinuacaoMesmaNF) {
      ultimoItem.pageIndices.push(i);
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
        pdfBytes: null
      });
    }
  }

  if (onProgress) onProgress(88, 4);

  for (const item of items) {
    const newPdf = await PDFLib.PDFDocument.create();
    const copiedPages = await newPdf.copyPages(srcPdfLibDoc, item.pageIndices);
    copiedPages.forEach(p => newPdf.addPage(p));
    item.pdfBytes = await newPdf.save();
  }

  if (onProgress) onProgress(100, 5);
  return { items, totalPages: pdfJsDoc.numPages };
}

function sourceArrayBufferCopy(buf) {
  return buf.slice(0);
}

export async function reprocessarPaginaUnica(arrayBuffer, pageIndex) {
  const pdfJsDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const page = await pdfJsDoc.getPage(pageIndex + 1);
  const texto = await lerPaginaComOCRClassico(page);
  return extrairNumeroNF(texto);
}q
