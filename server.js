/* =====================================================================
   FAMIGLIA PALAZZO — Servidor da loja + painel administrativo
   ---------------------------------------------------------------------
   Não precisa instalar nada além do Node.js.
   Para iniciar:  node server.js
   Loja:          http://localhost:3000
   Painel adm:    http://localhost:3000/admin
   ---------------------------------------------------------------------
   Configurações (senha do adm, chave PIX, cupons): config.json
   Banco de dados (produtos e pedidos):             data/db.json
   ===================================================================== */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DB_FILE = path.join(ROOT, 'data', 'db.json');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PORT = process.env.PORT || CONFIG.porta || 3000;
const SENHA_ADMIN = process.env.SENHA_ADMIN || CONFIG.senhaAdmin;

/* ---------------- banco de dados (arquivo JSON) ---------------- */
const DB_SEED = {
  seq: 1001,
  products: [
    { id: 'funghi', nome: 'Risoto de Funghi Trufado', desc: 'Funghi selecionados e aroma trufado em um risoto profundo e aveludado.', peso: '270g', serve: '3 pessoas', preco: 89.0, estoque: 48, img: '/img/jar_funghi.jpg', ativo: true },
    { id: 'shimeji', nome: 'Risoto de Shimeji Trufado com Abacaxi', desc: 'Shimeji, toque trufado e a leve doçura do abacaxi em perfeito equilíbrio.', peso: '270g', serve: '3 pessoas', preco: 89.0, estoque: 49, img: '/img/jar_shimeji.jpg', ativo: true },
    { id: 'carneseca', nome: 'Risoto de Carne Seca com Banana', desc: 'O encontro afetivo da carne seca com a doçura da banana, à moda da casa.', peso: '270g', serve: '3 pessoas', preco: 89.0, estoque: 49, img: '/img/jar_carneseca.jpg', ativo: true }
  ],
  orders: []
};
if (!fs.existsSync(DB_FILE)) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(DB_SEED, null, 2));
}
let db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  }, 60);
}

/* ---------------- sessões do painel adm ---------------- */
const sessions = new Set();
function isAdmin(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/fp_adm=([a-f0-9]+)/);
  return m && sessions.has(m[1]);
}

/* ---------------- utilidades ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('JSON inválido')); } });
  });
}
function novoNumeroPedido() {
  db.seq = (db.seq || 1000) + 1; save();
  return 'FP-' + db.seq;
}

const STATUS_VALIDOS = ['novo', 'aguardando_pagamento', 'pago', 'em_preparo', 'enviado', 'entregue', 'cancelado'];

/* ---------------- servidor ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    /* ============ API PÚBLICA (loja) ============ */

    if (p === '/api/products' && req.method === 'GET') {
      return json(res, 200, db.products.filter(x => x.ativo));
    }

    if (p === '/api/cupom' && req.method === 'POST') {
      const { codigo } = await readBody(req);
      const c = (CONFIG.cupons || {})[String(codigo || '').trim().toUpperCase()];
      if (!c) return json(res, 404, { erro: 'Cupom não encontrado' });
      return json(res, 200, { codigo: String(codigo).trim().toUpperCase(), percentual: c });
    }

    if (p === '/api/orders' && req.method === 'POST') {
      const b = await readBody(req);
      // validação
      const obrig = ['nome', 'telefone', 'email', 'cpf', 'endereco', 'cep', 'numero', 'cidade', 'estado', 'pagamento'];
      for (const f of obrig) if (!b[f] || !String(b[f]).trim()) return json(res, 400, { erro: `Campo obrigatório: ${f}` });
      if (!['pix', 'credito', 'debito'].includes(b.pagamento)) return json(res, 400, { erro: 'Forma de pagamento inválida' });
      if (!Array.isArray(b.itens) || !b.itens.length) return json(res, 400, { erro: 'Carrinho vazio' });

      // total calculado no servidor (nunca confie no valor vindo do navegador)
      let subtotal = 0; const itens = [];
      for (const it of b.itens) {
        const prod = db.products.find(x => x.id === it.id && x.ativo);
        if (!prod) return json(res, 400, { erro: 'Produto indisponível' });
        const qtd = Math.max(1, Math.min(99, parseInt(it.qtd) || 1));
        if (prod.estoque < qtd) return json(res, 400, { erro: `Estoque insuficiente de "${prod.nome}" (restam ${prod.estoque})` });
        subtotal += prod.preco * qtd;
        itens.push({ id: prod.id, nome: prod.nome, preco: prod.preco, qtd });
      }
      let percDesc = 0, cupom = null;
      if (b.cupom) {
        const c = (CONFIG.cupons || {})[String(b.cupom).trim().toUpperCase()];
        if (c) { percDesc = c; cupom = String(b.cupom).trim().toUpperCase(); }
      }
      const total = +(subtotal * (1 - percDesc)).toFixed(2);

      // baixa de estoque
      for (const it of itens) {
        const prod = db.products.find(x => x.id === it.id);
        prod.estoque -= it.qtd;
      }

      const pedido = {
        id: crypto.randomUUID(),
        numero: novoNumeroPedido(),
        criadoEm: new Date().toISOString(),
        status: 'aguardando_pagamento',
        cliente: {
          nome: b.nome, telefone: b.telefone, email: b.email, cpf: b.cpf,
          endereco: b.endereco, cep: b.cep, numero: b.numero,
          complemento: b.complemento || '', cidade: b.cidade, estado: b.estado
        },
        observacoes: b.observacoes || '',
        itens, subtotal: +subtotal.toFixed(2), cupom, desconto: +(subtotal * percDesc).toFixed(2),
        total, pagamento: b.pagamento,
        historico: [{ em: new Date().toISOString(), status: 'aguardando_pagamento' }]
      };
      db.orders.unshift(pedido); save();

      /* -------------------------------------------------------------
         PONTO DE INTEGRAÇÃO DE PAGAMENTO
         Para cartão de crédito/débito e PIX automático, conecte aqui o
         seu gateway (Mercado Pago, Pagar.me, Stripe...). Exemplo com
         Mercado Pago Checkout Pro: crie uma "preference" com `total` e
         devolva `init_point` para redirecionar o cliente.
         Enquanto não houver gateway, o pedido fica "aguardando
         pagamento" e você confirma manualmente no painel adm.
         ------------------------------------------------------------- */
      const resposta = { numero: pedido.numero, total, pagamento: pedido.pagamento };
      if (pedido.pagamento === 'pix') {
        resposta.pix = { chave: CONFIG.pix.chave, favorecido: CONFIG.pix.favorecido, banco: CONFIG.pix.banco };
      }
      return json(res, 201, resposta);
    }

    /* ============ API DO PAINEL ADM ============ */

    if (p === '/api/admin/login' && req.method === 'POST') {
      const { senha } = await readBody(req);
      if (senha !== SENHA_ADMIN) return json(res, 401, { erro: 'Senha incorreta' });
      const token = crypto.randomBytes(24).toString('hex');
      sessions.add(token);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `fp_adm=${token}; HttpOnly; Path=/; Max-Age=43200; SameSite=Strict`
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return json(res, 401, { erro: 'Faça login no painel' });

      if (p === '/api/admin/logout' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'fp_adm=; Path=/; Max-Age=0' });
        return res.end(JSON.stringify({ ok: true }));
      }

      /* ---- pedidos ---- */
      if (p === '/api/admin/orders' && req.method === 'GET') return json(res, 200, db.orders);

      const mOrder = p.match(/^\/api\/admin\/orders\/([\w-]+)$/);
      if (mOrder && req.method === 'PATCH') {
        const pedido = db.orders.find(x => x.id === mOrder[1]);
        if (!pedido) return json(res, 404, { erro: 'Pedido não encontrado' });
        const { status } = await readBody(req);
        if (!STATUS_VALIDOS.includes(status)) return json(res, 400, { erro: 'Status inválido' });
        // cancelamento devolve o estoque
        if (status === 'cancelado' && pedido.status !== 'cancelado') {
          for (const it of pedido.itens) {
            const prod = db.products.find(x => x.id === it.id);
            if (prod) prod.estoque += it.qtd;
          }
        }
        pedido.status = status;
        pedido.historico.push({ em: new Date().toISOString(), status });
        save();
        return json(res, 200, pedido);
      }

      /* ---- produtos ---- */
      if (p === '/api/admin/products' && req.method === 'GET') return json(res, 200, db.products);

      if (p === '/api/admin/products' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b.nome || b.preco == null) return json(res, 400, { erro: 'Nome e preço são obrigatórios' });
        const prod = {
          id: crypto.randomUUID().slice(0, 8),
          nome: String(b.nome), desc: String(b.desc || ''),
          peso: String(b.peso || '270g'), serve: String(b.serve || '3 pessoas'),
          preco: Math.max(0, +b.preco || 0), estoque: Math.max(0, parseInt(b.estoque) || 0),
          img: String(b.img || ''), ativo: b.ativo !== false
        };
        db.products.push(prod); save();
        return json(res, 201, prod);
      }

      const mProd = p.match(/^\/api\/admin\/products\/([\w-]+)$/);
      if (mProd) {
        const prod = db.products.find(x => x.id === mProd[1]);
        if (!prod) return json(res, 404, { erro: 'Produto não encontrado' });
        if (req.method === 'PUT') {
          const b = await readBody(req);
          if (b.nome != null) prod.nome = String(b.nome);
          if (b.desc != null) prod.desc = String(b.desc);
          if (b.peso != null) prod.peso = String(b.peso);
          if (b.serve != null) prod.serve = String(b.serve);
          if (b.preco != null) prod.preco = Math.max(0, +b.preco || 0);
          if (b.estoque != null) prod.estoque = Math.max(0, parseInt(b.estoque) || 0);
          if (b.img != null) prod.img = String(b.img);
          if (b.ativo != null) prod.ativo = !!b.ativo;
          save();
          return json(res, 200, prod);
        }
        if (req.method === 'DELETE') {
          db.products = db.products.filter(x => x.id !== prod.id); save();
          return json(res, 200, { ok: true });
        }
      }

      /* ---- upload de imagem (base64) ---- */
      if (p === '/api/admin/upload' && req.method === 'POST') {
        const { nome, dataUrl } = await readBody(req);
        const m = /^data:image\/(jpe?g|png|webp);base64,(.+)$/.exec(dataUrl || '');
        if (!m) return json(res, 400, { erro: 'Envie uma imagem JPG, PNG ou WEBP' });
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const file = Date.now() + '-' + String(nome || 'img').replace(/[^\w.-]/g, '_').slice(0, 40) + '.' + ext;
        fs.writeFileSync(path.join(PUBLIC, 'uploads', file), Buffer.from(m[2], 'base64'));
        return json(res, 201, { url: '/uploads/' + file });
      }

      /* ---- relatório simples ---- */
      if (p === '/api/admin/report' && req.method === 'GET') {
        const validos = db.orders.filter(o => o.status !== 'cancelado');
        const porProduto = {};
        for (const o of validos) for (const it of o.itens) {
          porProduto[it.nome] = porProduto[it.nome] || { qtd: 0, receita: 0 };
          porProduto[it.nome].qtd += it.qtd;
          porProduto[it.nome].receita += it.preco * it.qtd;
        }
        const porStatus = {};
        for (const o of db.orders) porStatus[o.status] = (porStatus[o.status] || 0) + 1;
        return json(res, 200, {
          totalPedidos: db.orders.length,
          receitaTotal: +validos.reduce((s, o) => s + o.total, 0).toFixed(2),
          ticketMedio: validos.length ? +(validos.reduce((s, o) => s + o.total, 0) / validos.length).toFixed(2) : 0,
          porStatus, porProduto
        });
      }

      return json(res, 404, { erro: 'Rota não encontrada' });
    }

    /* ============ ARQUIVOS ESTÁTICOS ============ */
    let file = p === '/' ? '/index.html' : p === '/admin' ? '/admin.html' : p;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC, file);
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Página não encontrada'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    });

  } catch (e) {
    json(res, 500, { erro: e.message });
  }
});

server.listen(PORT, () => {
  console.log('──────────────────────────────────────────────');
  console.log('  FAMIGLIA PALAZZO — sistema no ar!');
  console.log(`  Loja:        http://localhost:${PORT}`);
  console.log(`  Painel adm:  http://localhost:${PORT}/admin`);
  console.log('  (para parar, pressione Ctrl + C)');
  console.log('──────────────────────────────────────────────');
});
