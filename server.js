const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 1e8,
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const CLIENT_DIR = __dirname;
const ROOT_DIR = path.resolve(__dirname, '..');
const ADMIN_DIR = path.join(ROOT_DIR, 'adm');
const STOCK_STATE_PATH = path.join(CLIENT_DIR, 'stock-state.json');
const PRICE_STATE_PATH = path.join(CLIENT_DIR, 'price-state.json');
const ORDERS_STATE_PATH = path.join(CLIENT_DIR, 'orders-state.json');

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

function carregarJSON(caminhoArquivo, fallback) {
    try {
        if (!fs.existsSync(caminhoArquivo)) return fallback;
        const bruto = fs.readFileSync(caminhoArquivo, 'utf8').trim();
        if (!bruto) return fallback;
        return JSON.parse(bruto);
    } catch (erro) {
        console.error(`Erro ao carregar JSON em ${caminhoArquivo}:`, erro);
        return fallback;
    }
}

function salvarJSON(caminhoArquivo, dados, contexto) {
    try {
        fs.writeFileSync(caminhoArquivo, JSON.stringify(dados, null, 2), 'utf8');
    } catch (erro) {
        console.error(`Erro ao salvar ${contexto}:`, erro);
    }
}

function carregarEstadoEstoque() {
    return carregarJSON(STOCK_STATE_PATH, {});
}

function salvarEstadoEstoque(estado) {
    salvarJSON(STOCK_STATE_PATH, estado, 'o estoque persistido');
}

function carregarEstadoPrecos() {
    return carregarJSON(PRICE_STATE_PATH, {});
}

function salvarEstadoPrecos(estado) {
    salvarJSON(PRICE_STATE_PATH, estado, 'os preços persistidos');
}

function carregarPedidosPendentes() {
    return carregarJSON(ORDERS_STATE_PATH, []);
}

function salvarPedidosPendentes(pedidos) {
    salvarJSON(ORDERS_STATE_PATH, pedidos, 'os pedidos pendentes');
}

function normalizarStatusDisponivel(valor) {
    if (typeof valor === 'boolean') return valor;
    if (typeof valor === 'string') {
        const texto = valor.trim().toLowerCase();
        if (['disponivel', 'ativo', 'true', '1', 'on', 'online'].includes(texto)) return true;
        if (['indisponivel', 'inativo', 'false', '0', 'off', 'offline', 'esgotado'].includes(texto)) return false;
    }
    return valor !== false;
}

function normalizarValorNumerico(valor, fallback = 0) {
    if (typeof valor === 'number' && Number.isFinite(valor)) return valor;
    if (typeof valor === 'string') {
        const normalizado = Number(valor.replace(',', '.').replace(/[^\d.-]/g, ''));
        if (Number.isFinite(normalizado)) return normalizado;
    }
    return fallback;
}

function normalizarTextoPreco(valor) {
    return String(valor || '').trim();
}

let estadoEstoque = carregarEstadoEstoque();
let estadoPrecos = carregarEstadoPrecos();
let pedidosPendentes = carregarPedidosPendentes();

app.get('/', (req, res) => {
    res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(ADMIN_DIR, 'ADMIN.html'));
});

app.get('/admin.html', (req, res) => {
    res.redirect('/admin');
});

app.get('/admin-persistence.js', (req, res) => {
    res.sendFile(path.join(ADMIN_DIR, 'admin-persistence.js'));
});

app.get('/imagens-base64.js', (req, res) => {
    res.sendFile(path.join(CLIENT_DIR, 'imagens-base64.js'));
});

app.get('/ADMIN-imagens-base64.js', (req, res) => {
    res.sendFile(path.join(CLIENT_DIR, 'imagens-base64.js'));
});

app.use('/adm', express.static(ADMIN_DIR));
app.use(express.static(CLIENT_DIR));

io.on('connection', (socket) => {
    const role = String(socket.handshake.query.role || 'client').toLowerCase();
    const salaRole = role === 'admin' ? 'admins' : 'clients';

    socket.join(salaRole);
    socket.emit('stock-state-sync', estadoEstoque);
    socket.emit('price-state-sync', estadoPrecos);

    if (salaRole === 'admins') {
        socket.emit('admin-orders-sync', pedidosPendentes);
    }

    const room = socket.handshake.query.room;
    const username = socket.handshake.query.username;

    if (room) {
        socket.join(room);

        socket.on('chat message', (msg) => {
            msg.username = username;
            io.to(room).emit('chat message', msg);
        });

        socket.on('request clear', (roomToClear) => {
            io.to(roomToClear).emit('clear messages');
        });
    }

    socket.on('admin-update-product', (data = {}) => {
        if (salaRole !== 'admins') return;
        if (!data.id) return;
        const disponivel = normalizarStatusDisponivel(data.status ?? data.disponivel);
        estadoEstoque[data.id] = disponivel;
        salvarEstadoEstoque(estadoEstoque);

        const payload = { id: data.id, disponivel, status: disponivel ? 'disponivel' : 'indisponivel' };
        io.to('clients').emit('client-update-stock', payload);
        io.to('admins').emit('admin-stock-updated', payload);
    });

    socket.on('admin-update-price', (data = {}) => {
        if (salaRole !== 'admins') return;
        if (!data.id) return;

        const precoAtual = estadoPrecos[data.id] || {};
        const valorNum = normalizarValorNumerico(data.valorNum, normalizarValorNumerico(precoAtual.valorNum, 0));
        const valorTex = normalizarTextoPreco(data.valorTex) || normalizarTextoPreco(precoAtual.valorTex);

        const payload = { id: data.id, valorNum, valorTex };
        estadoPrecos[data.id] = payload;
        salvarEstadoPrecos(estadoPrecos);

        io.to('clients').emit('client-update-price', payload);
        io.to('admins').emit('admin-price-updated', payload);
    });

    socket.on('client-new-order', (orderData = {}) => {
        if (salaRole !== 'clients') return;
        const payload = {
            id: orderData.id || `pedido-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            numero: orderData.numero || '',
            cliente: orderData.cliente || 'Cliente sem nome',
            telefone: orderData.telefone || '',
            endereco: orderData.endereco || '',
            formaPagamento: orderData.formaPagamento || 'Não informado',
            total: orderData.total || '',
            itens: Array.isArray(orderData.itens) ? orderData.itens : [],
            criadoEm: orderData.criadoEm || new Date().toISOString()
        };

        pedidosPendentes = [payload, ...pedidosPendentes.filter(item => item.id !== payload.id)];
        salvarPedidosPendentes(pedidosPendentes);
        io.to('admins').emit('new-order-to-admin', payload);
    });

    socket.on('admin-complete-order', (data = {}) => {
        if (salaRole !== 'admins' || !data.id) return;

        pedidosPendentes = pedidosPendentes.filter(item => item.id !== data.id);
        salvarPedidosPendentes(pedidosPendentes);
        io.to('admins').emit('admin-order-completed', { id: data.id });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Hub Petit Buffet online na porta ${PORT}`);
});
