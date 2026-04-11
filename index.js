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
const marketingModulo = require('./marketing'); 

// CONFIGURACION
const PORT = process.env.PORT || 10000;
const apiKey = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    generationConfig: { temperature: 0.7, maxOutputTokens: 1000 }
});

const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

const PDF_URL = "https://www.one4cars.com/sevencorpweb/uploads/precios/Catalogo%20-%20ONE4CARS_compressed.pdf";

// TU ID DE ADMINISTRADOR
const ADMIN_ID = "228621243408492";

// MENÚ COMPLETO RESTAURADO
const MENU_TEXT = `📋 *MENÚ PRINCIPAL ONE4CARS*

1️⃣ *Medios de pago:* https://www.one4cars.com/medios_de_pago.php/

2️⃣ *Estado de cuenta:* https://www.one4cars.com/estado_de_cuenta.php/

3️⃣ *Lista de precios:* https://www.one4cars.com/lista_de_precios.php/

4️⃣ *Tomar pedido:* https://www.one4cars.com/tomar_pedido.php/

5️⃣ *Mis clientes/Vendedores:* https://www.one4cars.com/mis_clientes.php/

6️⃣ *Afiliar cliente:* https://www.one4cars.com/afiliar_clientes.php/

7️⃣ *Consulta de productos:* https://www.one4cars.com/consulta_productos.php/

8️⃣ *Seguimiento Despacho:* https://www.one4cars.com/despacho.php/

9️⃣ *Asesor Humano:* Indique su duda y un operador revisará el caso pronto.

_Escriba el número de la opción o su consulta directamente._`;

// VARIABLES GLOBALES
let qrCodeData = "Iniciando...";
let socketBot = null;
let dolarInfo = { bcv: 45.50, paralelo: 54.20 };

// ===== FUNCIONES DE APOYO =====
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
    if (clean.startsWith('580')) {
        clean = '58' + clean.substring(3);
    }
    if (clean.length > 15) return `${clean}@lid`;
    if (clean.startsWith('0')) clean = clean.substring(1);
    if (!clean.startsWith('58')) clean = '58' + clean;
    return `${clean}@s.whatsapp.net`;
}

// SISTEMA ANTI-BLOQUEO
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const randomDelay = async () => {
    const ms = Math.floor(Math.random() * (25000 - 15000 + 1)) + 15000;
    console.log(`⏳ Pausa de seguridad: ${ms/1000}s`);
    await sleep(ms);
};

// DETECCIÓN DE VENDEDORES
async function buscarVendedor(jid, pushName) {
    const telLimpio = jid.split('@')[0]; 
    const conn = await db();
    const [r] = await conn.execute(
        "SELECT * FROM tab_vendedores WHERE (celular_vendedor LIKE ? OR telefono_vendedor LIKE ? OR nombre LIKE ?) AND id_vendedor != 20 LIMIT 1", 
        [`%${telLimpio}%`, `%${telLimpio}%`, `%${pushName}%`]
    );
    await conn.end();
    return r[0] || null;
}

// ===== BASE DE DATOS =====
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
        console.log("✅ Base de Datos vinculada.");
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
    const [r] = await conn.execute("SELECT id_cliente, nombres, celular FROM tab_clientes WHERE (clave = ? OR clave LIKE ?) LIMIT 1", [rifLimpio, `%${rifLimpio}%`]);
    await conn.end();
    return r[0] || null;
}

async function obtenerDetalleFacturas(id_cliente) {
    const conn = await db();
    // Se asegura que el bot solo muestre facturas no anuladas y que no sean del vendedor 20
    const [facturas] = await conn.execute(
        "SELECT nro_factura, total, abono_factura, fecha_reg FROM tab_facturas WHERE id_cliente = ? AND pagada = 'NO' AND anulado != 'si' AND id_vendedor != 20", 
        [id_cliente]
    );
    await conn.end();
    return facturas;
}

async function actualizarDolar() {
    try {
        const resOficial = await axios.get('https://ve.dolarapi.com/v1/dolares/oficial', { timeout: 2000 });
        if (resOficial.data && resOficial.data.promedio > 0) {
            dolarInfo.bcv = resOficial.data.promedio;
        }
        const resParalelo = await axios.get('https://ve.dolarapi.com/v1/dolares/paralelo', { timeout: 2000 });
        if (resParalelo.data && resParalelo.data.promedio > 0) {
            dolarInfo.paralelo = resParalelo.data.promedio;
        }
    } catch (e) { 
        console.log("⚠️ Error en tasas.");
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
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        if (from.includes('@g.us')) return;

        const pushName = msg.pushName || "Usuario";
        const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (!rawText) return;

        const text = normalizar(rawText);
        const isAdmin = from.includes(ADMIN_ID);
        const rifDetectado = rawText.replace(/\D/g, '');

        const vendedor = await buscarVendedor(from, pushName);
        if (vendedor && (text === 'menu' || text === 'hola')) {
            return await sock.sendMessage(from, { text: `👋 Hola Vendedor(a) *${vendedor.nombre}*.\n\nBienvenido al sistema de gestión ONE4CARS.\n\n${MENU_TEXT}` });
        }

        if (isAdmin) {
            if (text === 'dolar') {
                await actualizarDolar();
                return await sock.sendMessage(from, { text: `💵 *TASAS ACTUALES*\n\nBCV: ${dolarInfo.bcv}\nParalelo: ${dolarInfo.paralelo}` });
            }
            if (text === 'menu' || text === 'hola') {
                return await sock.sendMessage(from, { text: `⭐ *MODO MASTER ACTIVO*\n\n${MENU_TEXT}` });
            }
        }

        const sesion = await getSesion(from);

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

        try {
            const inst = fs.readFileSync('./instrucciones.txt', 'utf8');
            const result = await model.generateContent(`${inst}\n\nCliente: ${rawText}`);
            await sock.sendMessage(from, { text: result.response.text() });
        } catch (e) {}
    });
}

// ===== SERVIDOR HTTP =====
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const header = `<nav class="navbar navbar-dark bg-dark mb-4 shadow"><div class="container"><a class="navbar-brand fw-bold" href="/">ONE4CARS ADMIN</a></div></nav>`;

    if (parsedUrl.pathname === '/cobranza') {
        const v = await cobranza.obtenerVendedores();
        const z = await cobranza.obtenerZonas();
        const d = await cobranza.obtenerListaDeudores(parsedUrl.query);
        res.end(await cobranza.generarHTML(v, z, d, header, parsedUrl.query));

    } else if (parsedUrl.pathname === '/enviar-cobranza' && req.method === 'POST') {
        if (!isBotReady()) return res.end("⚠️ Bot no listo.");
        let b = ''; req.on('data', c => b += c);
        req.on('end', async () => {
            const data = JSON.parse(b);
            let count = 0;
            const { vendedor, zona, dias } = data.filtros || {};

            for (const id_cliente of data.facturas) {
                const conn = await db();
                // CORRECCIÓN: Se agrega DATEDIFF en la consulta para filtrar CADA factura individualmente
                let sql = `
                    SELECT f.nro_factura, f.total, f.abono_factura, f.fecha_reg, c.nombres, c.celular 
                    FROM tab_facturas f 
                    JOIN tab_clientes c ON f.id_cliente = c.id_cliente 
                    WHERE f.id_cliente = ? 
                    AND f.pagada = 'NO' 
                    AND f.anulado != 'si' 
                    AND f.id_vendedor != 20
                `;
                const params = [id_cliente];

                if (vendedor) { sql += " AND f.id_vendedor = ?"; params.push(vendedor); }
                if (zona) { sql += " AND c.zona = ?"; params.push(zona); }
                if (dias) { 
                    // Esto asegura que solo traiga facturas que tengan los días solicitados o más
                    sql += " AND DATEDIFF(CURDATE(), f.fecha_reg) >= ?"; 
                    params.push(dias); 
                }

                const [facturas] = await conn.execute(sql, params);
                await conn.end();

                for (const f of facturas) {
                    const jid = formatWhatsApp(f.celular);
                    if (!jid) continue;

                    const saldoDolar = f.total - f.abono_factura;
                    const tasaBcvNum = typeof dolarInfo.bcv === 'number' ? dolarInfo.bcv : parseFloat(dolarInfo.bcv.toString().replace(',', '.'));
                    const totalBs = isNaN(tasaBcvNum) ? "N/D" : (saldoDolar * tasaBcvNum).toLocaleString('es-VE', {minimumFractionDigits: 2});

                    const fechaFactura = new Date(f.fecha_reg);
                    const hoy = new Date();
                    const diffTime = Math.abs(hoy - fechaFactura);
                    const diasVencidos = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                    const msgCobranza = `Hola *${f.nombres}* 🚗, de *ONE4CARS*.\n\nLe Notificamos que su Nota está pendiente:\n\n*Factura:* ${f.nro_factura}\n*Saldo:* $ *${saldoDolar.toFixed(2)}*\n*Presenta:* ${diasVencidos} días vencidos y puede ser pagada a cotización BCV *${dolarInfo.bcv}* en este momento, para un total de: *Bs. ${totalBs}*\n\nPor favor, gestione su pago a la brevedad. Cuide su crédito, es valioso.`;

                    try {
                        await socketBot.sendPresenceUpdate('composing', jid);
                        await socketBot.sendMessage(jid, { text: msgCobranza });
                        count++;
                        if (count % 5 === 0) await sleep(120000);
                        else await randomDelay();
                    } catch (e) { console.log("Error en", jid); }
                }
            }
            res.end("OK");
        });

    } else if (parsedUrl.pathname === '/marketing-panel') {
        const v = await marketingModulo.obtenerVendedores();
        const z = await marketingModulo.obtenerZonas();
        const c = await marketingModulo.obtenerClientesMarketing(parsedUrl.query);
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
        res.end(await marketingModulo.generarHTMLMarketing(c, v, z, header, parsedUrl.query));

    } else if (parsedUrl.pathname === '/marketing-preview') {
        const conn = await db();
        let sql = "SELECT id_cliente, nombres, celular FROM tab_clientes WHERE celular IS NOT NULL AND celular != '' AND id_vendedor != 20";
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
                            let msg = data.subtipo === 'custom' ? data.mensaje : "Campaña ONE4CARS";
                            await socketBot.sendMessage(jid, { text: msg });
                        }
                        count++;
                        if (count % 5 === 0) await sleep(120000);
                        else await randomDelay();
                    } catch (e) { console.log("Error marketing", jid); }
                }
            }
            res.end("OK");
        });

    } else {
        const v = await cobranza.obtenerVendedores();
        const z = await cobranza.obtenerZonas();
        res.end(`<!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            <meta http-equiv="refresh" content="30">
            <title>Admin ONE4CARS</title>
            <style>
                body { background-color: #f4f7f6; }
                .card { border: none; border-radius: 15px; }
                .btn-custom { border-radius: 10px; padding: 12px; font-weight: 600; }
            </style>
        </head>
        <body>
            ${header}
            <div class="container">
                <div class="row justify-content-center">
                    <div class="col-md-6 text-center">
                        <div class="card shadow-lg p-4 mb-4">
                            <h4>Estado del Bot</h4>
                            <div class="my-3">
                                ${qrCodeData.startsWith('data') ? `<img src="${qrCodeData}" style="max-width: 250px;">` : `<h2 class="text-success">${qrCodeData}</h2>`}
                            </div>
                            <div class="p-2 bg-light rounded">
                                <strong>BCV:</strong> ${dolarInfo.bcv} | <strong>Paralelo:</strong> ${dolarInfo.paralelo}
                            </div>
                            <div class="d-grid gap-2 mt-4">
                                <a href="/cobranza" class="btn btn-primary btn-custom">PANEL DE COBRANZA</a>
                                <a href="/marketing-panel" class="btn btn-info btn-custom text-white">PANEL DE MARKETING</a>
                            </div>
                        </div>
                    </div>

                    <div class="col-md-10 col-lg-7">
                        <div class="card shadow-lg p-4">
                            <h4 class="mb-4">Marketing Rápido</h4>
                            <div class="row g-2 mb-4">
                                <div class="col-6">
                                    <select id="m_vendedor" class="form-select">
                                        <option value="">Vendedor: Todos</option>
                                        ${v.map(v => `<option value="${v.vendedor}">${v.vendedor}</option>`).join('')}
                                    </select>
                                </div>
                                <div class="col-6">
                                    <select id="m_zona" class="form-select">
                                        <option value="">Zona: Todas</option>
                                        ${z.map(z => `<option value="${z.zona}">${z.zona}</option>`).join('')}
                                    </select>
                                </div>
                                <div class="col-12">
                                    <button onclick="previewM()" class="btn btn-secondary w-100 btn-custom">VER CLIENTES</button>
                                </div>
                            </div>
                            <div id="preview_area" style="max-height:250px; overflow-y:auto;" class="mb-3 border rounded p-2 bg-white shadow-inner"></div>
                            <textarea id="m_mensaje" class="form-control mb-3" rows="3">Aquí tienes nuestro catálogo actualizado. ¡Mucho éxito comercial!</textarea>
                            <button id="btn_send" style="display:none;" onclick="enviarM()" class="btn btn-danger w-100 btn-custom shadow">ENVIAR MENSAJE + CATÁLOGO PDF</button>
                        </div>
                    </div>
                </div>
            </div>
            <script>
                function previewM() {
                    const v = document.getElementById('m_vendedor').value;
                    const z = document.getElementById('m_zona').value;
                    fetch('/marketing-preview?vendedor='+v+'&zona='+z)
                    .then(r => r.json())
                    .then(data => {
                        let html = '<table class="table table-sm align-middle"><thead><tr><th><input type="checkbox" id="sel_all" checked onclick="toggleAll()" class="form-check-input"></th><th>Nombre</th></tr></thead><tbody>';
                        data.forEach(c => {
                            html += '<tr><td><input type="checkbox" class="c_check form-check-input" value="'+c.id_cliente+'" checked></td><td class="small">'+c.nombres+'</td></tr>';
                        });
                        html += '</tbody></table>';
                        document.getElementById('preview_area').innerHTML = html;
                        document.getElementById('btn_send').style.display = 'block';
                    });
                }
                function toggleAll() {
                    const master = document.getElementById('sel_all').checked;
                    document.querySelectorAll('.c_check').forEach(c => c.checked = master);
                }
                function enviarM() {
                    const ids = Array.from(document.querySelectorAll('.c_check:checked')).map(c => c.value);
                    const msg = document.getElementById('m_mensaje').value;
                    if(ids.length === 0) return alert('Seleccione al menos un cliente');
                    if(confirm('¿Enviar campaña a '+ids.length+' clientes?')) {
                        fetch('/enviar-marketing', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ clientes: ids, mensaje: msg, tipo: 'precios' })
                        }).then(() => alert("Campaña iniciada con pausas anti-bloqueo."));
                    }
                }
            </script>
        </body></html>`);
    }
});

server.listen(PORT, '0.0.0.0', async () => {
    await initDB();
    startBot();
    actualizarDolar();
    setInterval(actualizarDolar, 3600000);
});
