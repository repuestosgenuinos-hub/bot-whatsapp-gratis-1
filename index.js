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

// MODULOS EXTERNOS (Asegúrate de que los archivos existan)
const cobranza = require('./cobranza');
const marketingModulo = require('./marketing'); 

// CONFIGURACION
const PORT = process.env.PORT || 10000;
const apiKey = process.env.GEMINI_API_KEY;

// MODELO SOLICITADO: gemini-2.5-flash
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    generationConfig: { temperature: 0.7, maxOutputTokens: 1000 }
});

const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

const PDF_URL = "https://www.one4cars.com/sevencorpweb/uploads/precios/Catalogo%20-%20ONE4CARS_compressed.pdf";

// ID DE ADMINISTRADOR (EL JEFE)
const ADMIN_ID = "228621243408492";

const MENU_TEXT = `📋 *MENÚ PRINCIPAL ONE4CARS*

1️⃣ *Medios de pago:* 
https://www.one4cars.com/medios_de_pago.php/

2️⃣ *Estado de cuenta:* 
https://www.one4cars.com/estado_de_cuenta.php/

3️⃣ *Lista de precios:* 
https://www.one4cars.com/lista_de_precios.php/

4️⃣ *Tomar pedido:* 
https://www.one4cars.com/tomar_pedido.php/

5️⃣ *Mis clientes/Vendedores:* 
https://www.one4cars.com/mis_clientes.php/

6️⃣ *Afiliar cliente:* 
https://www.one4cars.com/afiliar_clientes.php/

7️⃣ *Consulta de productos:* 
https://www.one4cars.com/consulta_productos.php/

8️⃣ *Seguimiento Despacho:* 
https://www.one4cars.com/despacho.php/

9️⃣ *Asesor Humano:* 
Indique su duda y un operador revisará el caso pronto.

_Escriba el número de la opción o su consulta directamente._`;

// VARIABLES GLOBALES
let qrCodeData = "Iniciando...";
let socketBot = null;
let dolarInfo = { bcv: 'Cargando...', paralelo: 'Cargando...' };

// ===== FUNCIONES DE APOYO / BASE DE DATOS =====
async function db() { return await mysql.createConnection(dbConfig); }

function normalizar(texto) {
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

function isBotReady() {
    return socketBot && socketBot.user && socketBot.user.id;
}

function formatWhatsApp(jid) {
    if (!jid) return null;
    if (jid.toString().includes('@')) return jid;
    let clean = jid.toString().replace(/\D/g, ''); 
    if (clean.startsWith('580')) clean = '58' + clean.substring(3);
    if (clean.length > 15) return `${clean}@lid`;
    if (clean.startsWith('0')) clean = clean.substring(1);
    if (!clean.startsWith('58')) clean = '58' + clean;
    return `${clean}@s.whatsapp.net`;
}

async function setModo(jid, modo) {
    const conn = await db();
    await conn.execute("UPDATE control_chat SET modo = ? WHERE telefono = ?", [modo, jid]);
    await conn.end();
}

// SISTEMA ANTI-BLOQUEO
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const randomDelay = async () => {
    const ms = Math.floor(Math.random() * (25000 - 15000 + 1)) + 15000;
    await sleep(ms);
};

// DETECCIÓN DE VENDEDORES
async function buscarVendedor(jid, pushName) {
    const telLimpio = jid.split('@')[0]; 
    const conn = await db();
    const [r] = await conn.execute(
        "SELECT * FROM tab_vendedores WHERE celular_vendedor LIKE ? OR telefono_vendedor LIKE ? OR nombre LIKE ? LIMIT 1", 
        [`%${telLimpio}%`, `%${telLimpio}%`, `%${pushName}%`]
    );
    await conn.end();
    return r[0] || null;
}

async function initDB() {
    let conn;
    try {
        conn = await db();
        await conn.execute(`CREATE TABLE IF NOT EXISTS control_chat (
            telefono VARCHAR(100) PRIMARY KEY, 
            usuario VARCHAR(50), 
            id_cliente_int INT,
            modo VARCHAR(20) DEFAULT 'bot', 
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`);
    } catch (e) { console.log("❌ Error DB Init:", e.message); }
    finally { if(conn) await conn.end(); }
}

async function getSesion(jid) {
    try {
        const conn = await db();
        const [r] = await conn.execute("SELECT * FROM control_chat WHERE telefono=?", [jid]);
        await conn.end();
        return r[0] || null;
    } catch (e) { return null; }
}

async function guardarUsuario(jid, usuario, id_int) {
    const conn = await db();
    await conn.execute(`
        INSERT INTO control_chat (telefono, usuario, id_cliente_int, modo) 
        VALUES (?, ?, ?, 'bot') 
        ON DUPLICATE KEY UPDATE usuario=VALUES(usuario), id_cliente_int=VALUES(id_cliente_int), modo='bot'
    `, [jid, usuario, id_int]);
    await conn.end();
}

async function buscarCliente(rifLimpio) {
    const conn = await db();
    const [r] = await conn.execute("SELECT id_cliente, nombres, celular FROM tab_clientes WHERE clave = ? OR clave LIKE ? LIMIT 1", [rifLimpio, `%${rifLimpio}%`]);
    await conn.end();
    return r[0] || null;
}

async function obtenerDetalleFacturas(id_cliente) {
    const conn = await db();
    const [facturas] = await conn.execute(
        "SELECT nro_factura, total, abono_factura, fecha_reg FROM tab_facturas WHERE id_cliente = ? AND pagada = 'NO' AND anulado = 'no'", 
        [id_cliente]
    );
    await conn.end();
    return facturas;
}

async function actualizarDolar() {
    try {
        const res = await axios.get('https://pydolarvenezuela-api.vercel.app/api/v1/dollar?monitor=enparalelovzla');
        dolarInfo.bcv = res.data.monitors?.bcv?.price || "N/D";
        dolarInfo.paralelo = res.data.monitors?.enparalelovzla?.price || "N/D";
    } catch (e) { 
        dolarInfo.bcv = "Error"; dolarInfo.paralelo = "Error";
    }
}

// ===== BOT WHATSAPP =====
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ["ONE4CARS MASTER", "Chrome", "1.0.0"]
    });

    socketBot = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) qrcode.toDataURL(qr, { scale: 10 }, (_, url) => qrCodeData = url);
        if (connection === 'open') { qrCodeData = "ONLINE ✅"; }
        if (connection === 'close') {
            const r = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (r) startBot();
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;

        // 1. NO RESPONDER MENSAJES DE GRUPOS
        if (from.includes('@g.us')) return;

        // 2. SI EL HUMANO INTERVIENE (ESCRIBE DESDE EL TELEFONO), DETENER EL BOT
        if (msg.key.fromMe) {
            await setModo(from, 'humano');
            return;
        }

        const pushName = msg.pushName || "Usuario";
        const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (!rawText) return;

        const text = normalizar(rawText);
        const isAdmin = from.includes(ADMIN_ID);
        const rifDetectado = rawText.replace(/\D/g, '');

        // CONSULTAR SESIÓN Y MODO
        const sesion = await getSesion(from);

        // SI EL CHAT ESTÁ EN MODO HUMANO, NO RESPONDER (A menos que sea el Admin)
        if (sesion && sesion.modo === 'humano' && !isAdmin) return;

        // 3. RECONOCER AL JEFE (ADMIN)
        if (isAdmin) {
            if (text === 'dolar') {
                await actualizarDolar();
                return await sock.sendMessage(from, { text: `💵 *TASAS ACTUALES*\n\nBCV: ${dolarInfo.bcv}\nParalelo: ${dolarInfo.paralelo}` });
            }
            if (text === 'activar bot') {
                await setModo(from, 'bot');
                return await sock.sendMessage(from, { text: "🤖 Bot reactivado para este chat." });
            }
            if (text === 'menu' || text === 'hola') {
                return await sock.sendMessage(from, { text: `⭐ *MODO MASTER ACTIVO*\n\n${MENU_TEXT}` });
            }
        }

        // LÓGICA DE VENDEDOR
        const vendedor = await buscarVendedor(from, pushName);
        if (vendedor && (text === 'menu' || text === 'hola')) {
            return await sock.sendMessage(from, { text: `👋 Hola Vendedor(a) *${vendedor.nombre}*.\n\n${MENU_TEXT}` });
        }

        // VINCULACIÓN DE RIF
        if (rifDetectado.length >= 6 && (!sesion || !sesion.id_cliente_int || text.includes('rif'))) {
            const c = await buscarCliente(rifDetectado);
            if (c) {
                await guardarUsuario(from, rifDetectado, c.id_cliente);
                return await sock.sendMessage(from, { text: `✅ ¡Hola ${c.nombres}! RIF vinculado.\n\n${MENU_TEXT}` });
            }
        }

        if (!sesion || !sesion.id_cliente_int) {
            if (["menu", "bot", "hola"].some(w => text.includes(w))) {
                return await sock.sendMessage(from, { text: "👋 Bienvenido a *ONE4CARS*.\n\nPor favor envíe su *RIF o Cédula* (solo números) para identificarse." });
            }
            return;
        }

        if (text === 'menu') return await sock.sendMessage(from, { text: MENU_TEXT });
        
        if (text.includes("saldo") || text === '2') {
            const facturas = await obtenerDetalleFacturas(sesion.id_cliente_int);
            if (facturas.length === 0) return await sock.sendMessage(from, { text: "✅ Usted no posee facturas pendientes de pago. ¡Gracias!" });
            let totalP = 0;
            let listado = "*📄 SUS FACTURAS PENDIENTES:*\n\n";
            facturas.forEach(f => {
                const p = f.total - f.abono_factura;
                totalP += p;
                listado += `🔸 #${f.nro_factura} | $${p.toFixed(2)}\n`;
            });
            listado += `\n💰 *TOTAL A PAGAR: $${totalP.toFixed(2)}*`;
            return await sock.sendMessage(from, { text: listado });
        }

        // 4. RESPUESTA SIEMPRE GUIADA POR INSTRUCCIONES.TXT (GEMINI 2.5 FLASH)
        try {
            const inst = fs.readFileSync('./instrucciones.txt', 'utf8');
            const prompt = `${inst}\n\nCONTEXTO:\n- Usuario: ${pushName}\n- Dólar BCV: ${dolarInfo.bcv}\n- Dólar Paralelo: ${dolarInfo.paralelo}\n\nMensaje del Cliente: ${rawText}`;
            
            const result = await model.generateContent(prompt);
            await sock.sendMessage(from, { text: result.response.text() });
        } catch (e) {
            console.error("Error en IA:", e);
        }
    });
}

// ===== SERVIDOR HTTP (TODAS LAS FUNCIONALIDADES RESTAURADAS) =====
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const header = `<nav class="navbar navbar-dark bg-dark mb-4 shadow"><div class="container"><a class="navbar-brand fw-bold" href="/">ONE4CARS ADMIN</a></div></nav>`;

    if (parsedUrl.pathname === '/cobranza') {
        const v = await cobranza.obtenerVendedores();
        const z = await cobranza.obtenerZonas();
        const d = await cobranza.obtenerListaDeudores(parsedUrl.query);
        res.end(await cobranza.generarHTML(v, z, d, header, parsedUrl.query));

    } else if (parsedUrl.pathname === '/marketing-panel') {
        const v = await marketingModulo.obtenerVendedores();
        const z = await marketingModulo.obtenerZonas();
        const c = await marketingModulo.obtenerClientesMarketing(parsedUrl.query);
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
        res.end(await marketingModulo.generarHTMLMarketing(c, v, z, header, parsedUrl.query));

    } else if (parsedUrl.pathname === '/marketing-preview') {
        const conn = await db();
        let sql = "SELECT id_cliente, nombres, celular FROM tab_clientes WHERE celular IS NOT NULL AND celular != ''";
        const params = [];
        if (parsedUrl.query.vendedor) { sql += " AND vendedor = ?"; params.push(parsedUrl.query.vendedor); }
        if (parsedUrl.query.zona) { sql += " AND zona = ?"; params.push(parsedUrl.query.zona); }
        const [clientes] = await conn.execute(sql, params);
        await conn.end();
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(clientes));

    } else if (parsedUrl.pathname === '/enviar-marketing' && req.method === 'POST') {
        if (!isBotReady()) return res.end("⚠️ Bot no listo.");
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            const data = JSON.parse(b);
            let count = 0;
            for (const id of data.clientes) {
                const conn = await db();
                const [rows] = await conn.execute("SELECT * FROM tab_clientes WHERE id_cliente=?", [id]);
                await conn.end();
                if (rows[0]) {
                    const c = rows[0];
                    const jid = formatWhatsApp(c.celular);
                    if (!jid) continue;
                    try {
                        await socketBot.sendPresenceUpdate('composing', jid);
                        if (data.tipo === 'precios') {
                            await socketBot.sendMessage(jid, { document: { url: PDF_URL }, fileName: 'Catalogo-ONE4CARS.pdf', mimetype: 'application/pdf', caption: `¡Hola *${c.nombres}*! Aquí tienes nuestro catálogo actualizado. 🚀` });
                        } else if (data.tipo === 'promo') {
                            let msg = data.mensaje || `*🛠️ ¡Tu Negocio al Máximo Nivel!*`;
                            await socketBot.sendMessage(jid, { text: msg });
                        }
                        count++;
                        if (count % 5 === 0) await sleep(120000); else await randomDelay();
                    } catch (e) { console.log("Error marketing", jid); }
                }
            }
            res.end("OK");
        });

    } else if (parsedUrl.pathname === '/enviar-cobranza' && req.method === 'POST') {
        if (!isBotReady()) return res.end("⚠️ Bot no listo.");
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            const data = JSON.parse(b);
            let count = 0;
            for (const id_cliente of data.facturas) {
                const conn = await db();
                const [facturas] = await conn.execute(
                    "SELECT f.nro_factura, f.total, f.abono_factura, f.fecha_reg, f.porcentaje, c.nombres, c.celular FROM tab_facturas f JOIN tab_clientes c ON f.id_cliente = c.id_cliente WHERE f.id_cliente = ? AND f.pagada = 'NO' AND f.anulado = 'no'", 
                    [id_cliente]
                );
                await conn.end();
                for (const f of facturas) {
                    const jid = formatWhatsApp(f.celular);
                    if (!jid) continue;
                    const saldoBs = (f.total - f.abono_factura) / (f.porcentaje || 1);
                    const msgCobranza = `Hola *${f.nombres}* 🚗, le recordamos su factura pendiente: #${f.nro_factura} por un saldo de Bs. *${saldoBs.toLocaleString('es-VE')}*.`;
                    try {
                        await socketBot.sendMessage(jid, { text: msgCobranza });
                        count++;
                        if (count % 5 === 0) await sleep(120000); else await randomDelay();
                    } catch (e) { console.log("Error cobranza", jid); }
                }
            }
            res.end("OK");
        });

    } else {
        // PANEL PRINCIPAL
        const v = await cobranza.obtenerVendedores() || [];
        const z = await cobranza.obtenerZonas() || [];
        res.end(`<!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            <title>Admin ONE4CARS</title>
        </head>
        <body style="background:#f4f7f6">
            ${header}
            <div class="container">
                <div class="row">
                    <div class="col-md-5 mb-4">
                        <div class="card shadow p-4 text-center">
                            <h4>Estado del Bot</h4>
                            <div class="my-3">${qrCodeData.startsWith('data') ? `<img src="${qrCodeData}" width="200">` : `<h2 class="text-success">${qrCodeData}</h2>`}</div>
                            <div class="p-2 bg-light rounded">BCV: ${dolarInfo.bcv} | Paralelo: ${dolarInfo.paralelo}</div>
                            <div class="d-grid gap-2 mt-3">
                                <a href="/cobranza" class="btn btn-primary">COBRANZA</a>
                                <a href="/marketing-panel" class="btn btn-info text-white">MARKETING</a>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </body></html>`);
    }
});

server.listen(PORT, '0.0.0.0', async () => {
    await initDB();
    startBot();
    actualizarDolar();
    setInterval(actualizarDolar, 3600000);
});
