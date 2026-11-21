// Módulo de Persistência na Nuvem (Supabase — Apenas Metadados, Sem PDFs)
const SUPABASE_URL = 'https://leufprzyqtghbhytplfh.supabase.co/rest/v1/';
const SUPABASE_ANON_KEY = 'sb_publishable_zabo1Rj7DS0PL09N7txqTw_61V8nnS1';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Remove os bytes pesados do PDF antes de enviar para o banco online
function sanitizarItensParaBanco(items) {
  return (items || []).map(item => ({
    id: item.id,
    pageIndices: item.pageIndices,
    nfNumber: item.nfNumber,
    filename: item.filename,
    status: item.status
  }));
}

export async function dbSalvarProcessamento(registro) {
  const payload = {
    ferramenta: registro.ferramenta,
    pdf_original: registro.pdfOriginal,
    paginas_analisadas: registro.paginasAnalisadas,
    notas_identificadas: registro.notasIdentificadas,
    arquivos_gerados: registro.arquivosGerados,
    precisam_revisao: registro.precisamRevisao,
    tempo: registro.tempo,
    status: registro.status,
    items: sanitizarItensParaBanco(registro.items)
  };

  if (registro.id) {
    const { data, error } = await supabaseClient
      .from('processamentos')
      .update(payload)
      .eq('id', registro.id)
      .select('id')
      .single();

    if (error) throw error;
    return data.id;
  } else {
    const { data, error } = await supabaseClient
      .from('processamentos')
      .insert(payload)
      .select('id, created_at')
      .single();

    if (error) throw error;
    registro.timestamp = new Date(data.created_at).getTime();
    return data.id;
  }
}

function mapearLinhaBanco(row) {
  return {
    id: row.id,
    timestamp: new Date(row.created_at).getTime(),
    ferramenta: row.ferramenta,
    pdfOriginal: row.pdf_original,
    paginasAnalisadas: row.paginas_analisadas,
    notasIdentificadas: row.notas_identificadas,
    arquivosGerados: row.arquivos_gerados,
    precisamRevisao: row.precisam_revisao,
    tempo: row.tempo,
    status: row.status,
    items: row.items || []
  };
}

export async function dbListarProcessamentos() {
  const { data, error } = await supabaseClient
    .from('processamentos')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Erro ao listar Supabase:', error);
    return [];
  }
  return (data || []).map(mapearLinhaBanco);
}

export async function dbObterPorId(id) {
  const { data, error } = await supabaseClient
    .from('processamentos')
    .select('*')
    .eq('id', id)
    .single();

  if (error) {
    console.error('Erro ao buscar registro:', error);
    return null;
  }
  return mapearLinhaBanco(data);
}

export async function dbExcluirPorId(id) {
  const { error } = await supabaseClient
    .from('processamentos')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

export async function dbLimparTudo() {
  const { error } = await supabaseClient
    .from('processamentos')
    .delete()
    .neq('id', 0);

  if (error) throw error;
}

export function formatarDataHoraBR(ts) {
  const d = new Date(ts);
  const dia = String(d.getDate()).padStart(2, '0');
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const ano = d.getFullYear();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${dia}/${mes}/${ano}, ${h}:${m}:${s}`;
}