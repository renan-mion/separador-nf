// Módulo de Leitura de PDF, OCR Clássico e Extração de Número de NF (Sem IA)
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

export function extrairNumeroNF(texto) {
  const limpo = texto.replace(/\s+/g, ' ');

  // 1. Chave de acesso de 44 dígitos (mesmo com espaços entre blocos de 4 dígitos)
  const chaveMatch = limpo.match(/(?:(?:\d\s*){44})/);
  if (chaveMatch) {
    const soDigitos = chaveMatch[0].replace(/\D/g, '');
    if (soDigitos.length === 44) {
      const nfChave = soDigitos.substring(25, 34).replace(/^0+/, '');
      if (nfChave) return nfChave;
    }
  }

  // 2. Padrão DANFE ABB / padrão: "N°000401361" ou "N° 000401361"
  const danfeColadoMatch = limpo.match(/N[º°o\.]\s*[:\-]?\s*([0-9]{1,3}(?:\.[0-9]{3}){1,2}|[0-9]{6,9})/i);
  if (danfeColadoMatch) {
    const num = danfeColadoMatch[1].replace(/\D/g, '').replace(/^0+/, '');
    if (num) return num;
  }

  // 3. Padrão próximo a SÉRIE / FOLHA
  const serieMatch = limpo.match(/(?:N[º°o]?\.?\s*)?([0-9]{6,9}|[0-9]{1,3}(?:\.[0-9]{3}){1,2})\s*(?:S[ÉE]RIE|FOLHA)/i);
  if (serieMatch) {
    const num = serieMatch[1].replace(/\D/g, '').replace(/^0+/, '');
    if (num) return num;
  }

  // 4. Padrão NFS-e (Prefeitura)
  const nfseMatch = limpo.match(/N[úu]mero da Nota[^0-9]{0,25}([0-9\.]{1,15})/i);
  if (nfseMatch) {
    const num = nfseMatch[1].replace(/\D/g, '').replace(/^0+/, '');
    if (num) return num;
  }

  return null;
}

export async function lerPaginaComOCRClassico(pdfPage) {
  const worker = await Tesseract.createWorker('por');

  const viewport = pdfPage.getViewport({ scale: 3.0 });
  const cropHeight = Math.floor(viewport.height * 0.45);

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = cropHeight;
  const ctx = canvas.getContext('2d');

  await pdfPage.render({ canvasContext: ctx, viewport }).promise;

  // Binarização para eliminar sombras de escaneamento/foto
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const bin = lum < 145 ? 0 : 255;
    data[i] = data[i + 1] = data[i + 2] = bin;
  }
  ctx.putImageData(imgData, 0, 0);

  const { data: { text: textoTopo } } = await worker.recognize(canvas);

  if (extrairNumeroNF(textoTopo)) {
    await worker.terminate();
    return textoTopo;
  }

  // Fallback: página inteira se não encontrou no cabeçalho
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = viewport.width;
  fullCanvas.height = viewport.height;
  const fullCtx = fullCanvas.getContext('2d');
  fullCtx.filter = 'grayscale(100%) contrast(150%)';
  await pdfPage.render({ canvasContext: fullCtx, viewport }).promise;

  const { data: { text: textoCompleto } } = await worker.recognize(fullCanvas);
  await worker.terminate();
  return textoCompleto;
}

export async function contarPaginasPDF(arrayBuffer) {
  const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  return pdfDoc.numPages;
}

export async function processarLotePDF(arrayBuffer, onProgress) {
  const pdfJsDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const srcPdfLibDoc = await PDFLib.PDFDocument.load(arrayBuffer.slice(0));

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

    if (nfNum && items.length > 0 && items[items.length - 1].nfNumber === nfNum) {
      items[items.length - 1].pageIndices.push(i);
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

export async function reprocessarPaginaUnica(arrayBuffer, pageIndex) {
  const pdfJsDoc = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  const page = await pdfJsDoc.getPage(pageIndex + 1);
  const texto = await lerPaginaComOCRClassico(page);
  return extrairNumeroNF(texto);
}