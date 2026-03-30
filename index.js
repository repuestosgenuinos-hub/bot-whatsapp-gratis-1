const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const http = require('http');
const url = require('url');
const pino = require('pino');
const fs = require('fs');
const mysql = require('mysql2/promise');
const axios = require('axios');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// MODULOS EXTERNOS
const cobranza = require('./cobranza');

const PORT = process.env.PORT || 10000;
const apiKey = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

let qrCodeData = "Iniciando...";
let socketBot = null;
let dolarInfo = { bcv: 'Cargando...', paralelo: 'Cargando...' };

async function db() { return await mysql.createConnection(dbConfig); }

async function getSesion(tel) {
    try {
        const conn = await db();
        const [r] = await conn.execute("SELECT * FROM control_chat WHERE telefono=?", [tel]);
        await conn.end();
        return r[0] || null;
    } catch (e) { return null; }
}

async function setModo(tel, modo) {
    try {
        const conn = await db();
        await conn.execute("INSERT INTO control_chat (telefono, modo) VALUES (?,?) ON DUPLICATE KEY UPDATE modo=VALUES(modo)", [tel, modo]);
        await conn.end();
    } catch (e) { console.log("Error DB setModo"); }
}

async function guardarUsuario(tel, usuario) {
    try {
        const conn = await db();
        await conn.execute("INSERT INTO control_chat (telefono, usuario, modo) VALUES (?,?, 'bot') ON DUPLICATE KEY UPDATE usuario=VALUES(usuario)", [tel, usuario]);
        await conn.end();
    } catch (e) { console.log("Error DB guardarUsuario"); }
}

async function buscarCliente(usuario) {
    const conn = await db();
    const [r] = await conn.execute("SELECT * FROM tab_clientes WHERE usuario=? LIMIT 1", [usuario]);
    await conn.end();
    return r[0] || null;
}

async function obtenerSaldo(id) {
    const conn = await db();
    const [r] = await conn.execute("SELECT SUM(total - abono_factura) saldo FROM tab_facturas WHERE id_cliente=? AND pagada='NO'", [id]);
    await conn.end();
    return r[0].saldo || 0;
}

async function actualizarDolar() {
    try {
        // URL actualizada de la API
        const res = await axios.get('https://pydolarvenezuela-api.vercel.app/api/v1/dollar?monitor=enparalelovzla');
        dolarInfo.bcv = res.data.monitors?.bcv?.price || "N/A";
        dolarInfo.paralelo = res.data.monitors?.enparalelovzla?.price || "N/A";
    } catch (e) { console.error("Error Dolar API"); }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false
    });

    socketBot = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) qrcode.toDataURL(qr, { scale: 10 }, (_, url) => qrCodeData = url);
        if (connection === 'open') { qrCodeData = "ONLINE ✅"; console.log("Bot Conectado"); }
        if (connection === 'close') {
            const r = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (r) startBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
        const from = msg.key.remoteJid;
        if (from.includes('@g.us')) return;
        const tel = from.split('@')[0];

        if (msg.key.fromMe) { await setModo(tel, 'humano'); return; }
        const sesion = await getSesion(tel);
        if (sesion && sesion.modo === 'humano') return;

        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (!text) return;

        if (!sesion || !sesion.usuario) {
            const cedula = text.replace(/\D/g, '');
            if (cedula.length >= 6) {
                const c = await buscarCliente(cedula);
                if (c) {
                    await guardarUsuario(tel, cedula);
                    await sock.sendMessage(from, { text: `Hola ${c.nombres} 👋. RIF vinculado.\nEscriba *saldo* o su duda.` });
                    return;
                }
            }
            await sock.sendMessage(from, { text: "Bienvenido a ONE4CARS. Por favor envíe su RIF o Cédula." });
            return;
        }

        if (text.toLowerCase().includes("saldo")) {
            const c = await buscarCliente(sesion.usuario);
            const s = await obtenerSaldo(c.id_cliente);
            await sock.sendMessage(from, { text: `💰 Su saldo es: $${s.toFixed(2)}` });
            return;
        }

        try {
            const inst = fs.readFileSync('./instrucciones.txt', 'utf8');
            const result = await model.generateContent(`${inst}\n\nCliente: ${text}`);
            await sock.sendMessage(from, { text: result.response.text() });
        } catch (e) { console.log("IA Error"); }
    });
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const header = `<nav class="navbar navbar-dark bg-dark mb-4"><div class="container"><a class="navbar-brand">ONE4CARS ADMIN</a></div></nav>`;

    if (parsedUrl.pathname === '/cobranza') {
        try {
            const v = await cobranza.obtenerVendedores();
            const z = await cobranza.obtenerZonas();
            const d = await cobranza.obtenerListaDeDeudores(parsedUrl.query);
            res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
            res.end(await cobranza.generarHTML(v, z, d, header, parsedUrl.query));
        } catch (e) { res.end(`Error en Panel: ${e.message}`); }
    } else {
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
        res.end(`<html><head><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><meta http-equiv="refresh" content="30"></head><body class="bg-light text-center">${header}<div class="container"><div class="card shadow p-4 mx-auto" style="max-width:400px;">
        <h4>Bot Status</h4>
        <div class="my-4">${qrCodeData.startsWith('data') ? `<img src="${qrCodeData}" width="250">` : `<h2 class="text-success">${qrCodeData}</h2>`}</div>
        <p class="small">Dolar BCV: ${dolarInfo.bcv} | Paralelo: ${dolarInfo.paralelo}</p>
        <a href="/cobranza" class="btn btn-primary w-100">IR AL PANEL DE COBRANZA</a>
        </div></div></body></html>`);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor activo en puerto ${PORT}`);
    startBot();
    actualizarDolar();
    setInterval(actualizarDolar, 3600000);
});
