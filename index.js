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

const PDF_URL_CATALOGO = "https://www.one4cars.com/sevencorpweb/uploads/precios/Catalogo%20-%20ONE4CARS_compressed.pdf";

// TU ID DE ADMINISTRADOR
const ADMIN_ID = "228621243408492";

// MENÚ COMPLETO RESTAURADO
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
let chatMemory = {}; 

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
    if (clean.startsWith('580')) { clean = '58' + clean.substring(3); }
    if (clean.length > 15) return `${clean}@lid`;
    if (clean.startsWith('0')) clean = clean.substring(1);
    if (!clean.startsWith('58')) clean = '58' + clean;
    return `${clean}@s.whatsapp.net`;
}

// SISTEMA ANTI-BLOQUEO
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const randomDelay = async () => {
    const ms = Math.floor(Math.random() * (25000 - 15000 + 1)) + 15000; 
    await sleep(ms);
};

// --- GESTIÓN DE HISTORIAL EN BASE DE DATOS ---
async function guardarMensaje(tel, rol, contenido) {
    try {
        const conn = await db();
        await conn.execute("INSERT INTO historial_chat (telefono, rol, contenido) VALUES (?, ?, ?)", [tel, rol, contenido]);
        await conn.end();
    } catch (e) { console.log("Error guardando historial"); }
}

async function obtenerHistorial(tel) {
    try {
        const conn = await db();
        const [rows] = await conn.execute("SELECT rol, contenido FROM historial_chat WHERE telefono = ? ORDER BY fecha ASC LIMIT 10", [tel]);
        await conn.end();
        return rows.map(r => `${r.rol === 'user' ? 'Cliente' : 'Bot'}: ${r.contenido}`).join("\n");
    } catch (e) { return ""; }
}

// CONTROL DE MODO (BOT vs HUMANO)
async function setModo(tel, modo) {
    const conn = await db();
    await conn.execute("INSERT INTO control_chat (telefono, modo) VALUES (?, ?) ON DUPLICATE KEY UPDATE modo = VALUES(modo)", [tel, modo]);
    await conn.end();
}

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
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        
        await conn.execute(`CREATE TABLE IF NOT EXISTS historial_chat (
            id INT AUTO_INCREMENT PRIMARY KEY, 
            telefono VARCHAR(100), 
            rol ENUM('user', 'model'), 
            contenido TEXT, 
            fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        
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
    const [r] = await conn.execute("SELECT id_cliente, nombres, celular, cedula, direccion, zona FROM tab_clientes WHERE clave = ? OR clave LIKE ? LIMIT 1", [rifLimpio, `%${rifLimpio}%`]);
    await conn.end();
    return r[0] || null;
}

// --- OBTENER DETALLE DE FACTURAS CON LINKS LIMPIOS ---
async function obtenerDetalleFacturas(id_cliente) {
    const conn = await db();
    const [facturas] = await conn.execute(
        `SELECT f.id_factura, f.nro_factura, f.total, f.abono_factura, f.fecha_reg, f.porcentaje, f.descuento, f.total_desc,
                c.nombres, c.direccion, c.cedula, c.celular, c.telefono, c.id_cliente, c.zona, c.vendedor as nombre_vendedor
         FROM tab_facturas f
         JOIN tab_clientes c ON f.id_cliente = c.id_cliente
         WHERE f.id_cliente = ? AND f.pagada = 'NO' AND f.anulado = 'no'`, 
        [id_cliente]
    );
    await conn.end();
    return facturas;
}

async function actualizarDolar() {
    try {
        const resOficial = await axios.get('https://ve.dolarapi.com/v1/dolares/oficial', { timeout: 7000 });
        if (resOficial.data) dolarInfo.bcv = parseFloat(resOficial.data.promedio).toFixed(2);
        const resParalelo = await axios.get('https://ve.dolarapi.com/v1/dolares/paralelo', { timeout: 7000 });
        if (resParalelo.data) dolarInfo.paralelo = parseFloat(resParalelo.data.promedio).toFixed(2);
    } catch (e) { console.log("Error Dolar API"); }
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
        if (connection === 'open') { qrCodeData = "ONLINE ✅"; console.log("🚀 BOT MASTER ONLINE"); }
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
        if (from === 'status@broadcast' || from.includes('@g.us')) return;

        // --- DETECTAR SI EL HUMANO RESPONDE ---
        if (msg.key.fromMe) {
            const textMe = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase();
            if (textMe === '!bot') {
                await setModo(from, 'bot');
                await sock.sendMessage(from, { text: "🤖 IA Reactivada para este chat." });
            } else {
                await setModo(from, 'humano');
            }
            return;
        }

        const pushName = msg.pushName || "Usuario";
        const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (!rawText) return;

        const text = normalizar(rawText);
        const isAdmin = from.includes(ADMIN_ID);
        const rifDetectado = rawText.replace(/\D/g, '');

        // GUARDAR EN HISTORIAL
        await guardarMensaje(from, 'user', rawText);

        // VERIFICAR MODO DEL CHAT
        const sesion = await getSesion(from);
        if (sesion && sesion.modo === 'humano') return;

        // --- 1. LÓGICA DE ADMINISTRADOR MAESTRO ---
        if (isAdmin) {
            if (text === 'dolar') {
                await actualizarDolar();
                const dMsg = `💵 BCV: ${dolarInfo.bcv}\n📈 Paralelo: ${dolarInfo.paralelo}`;
                return await sock.sendMessage(from, { text: dMsg });
            }
            if (text === 'menu') {
                return await sock.sendMessage(from, { text: MENU_TEXT });
            }
            // Si el admin envía un RIF, mostrar saldo
            if (rifDetectado.length >= 6 && rawText.length < 15) {
                const c = await buscarCliente(rifDetectado);
                if (c) {
                    const facturas = await obtenerDetalleFacturas(c.id_cliente);
                    let totalP = 0; let list = `⭐ *CONSULTA MASTER*\nCliente: ${c.nombres}\n\n`;
                    facturas.forEach(f => {
                        const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
                        totalP += monto;
                        const fReg = new Date(f.fecha_reg).toISOString().split('T')[0];
                        const params = `id_factura=${f.id_factura}&nro_factura=${f.nro_factura}&fecha_reg=${fReg}&total=${f.total}&abono_factura=${f.abono_factura}&nombres=${encodeURIComponent(f.nombres.trim())}&nombre=${encodeURIComponent(f.nombre_vendedor.trim())}&direccion=${encodeURIComponent(f.direccion.trim())}&cedula=${f.cedula.trim()}&celular=${encodeURIComponent(f.celular.trim())}&telefono=${encodeURIComponent(f.telefono.trim())}&id_cliente=${f.id_cliente}&zona=${encodeURIComponent(f.zona.trim())}&descuento=${f.descuento}&total_desc=${f.total_desc}`;
                        list += `🔸 *#${f.nro_factura}* | $${monto.toFixed(2)}\n✍️ Firmada: https://www.one4cars.com/sevencorpweb/uploads/notas/${f.nro_factura}.jpg\n📄 PDF: https://one4cars.com/sevencorp/factura_full_reporte_web.php?${params}\n\n`;
                    });
                    list += `💰 *Total Pendiente: $${totalP.toFixed(2)}*`;
                    return await sock.sendMessage(from, { text: list });
                }
            }
            // Si el admin saluda, dar bienvenida pero NO retornar para que Gemini pueda responder preguntas
            if (text === 'hola' || text === 'buen dia' || text === 'buenas' || text === 'buenos dias') {
                await actualizarDolar();
                const fechaHoy = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
                const aMsg = `¡Hola Jefe! 👋 Un gusto saludarle.\n\nBienvenido de nuevo. Hoy es ${fechaHoy}.\n\n*Tasas:* BCV: ${dolarInfo.bcv} | Paralelo: ${dolarInfo.paralelo}\n\n¿En qué puedo ayudarle hoy? Puede consultar cualquier RIF o pedirme información.`;
                await guardarMensaje(from, 'model', aMsg);
                return await sock.sendMessage(from, { text: aMsg });
            }
        }

        // --- 2. LÓGICA DE BIENVENIDA CLIENTES (PRIMERA VEZ) ---
        if (!sesion && !isAdmin) {
            await actualizarDolar();
            const fechaHoy = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
            const welcomeMsg = `¡Hola! 👋 Bienvenido a *ONE4CARS*.\n\nHoy es ${fechaHoy}.\n\n*Tasas del día:*\n💵 BCV: ${dolarInfo.bcv}\n📈 Paralelo: ${dolarInfo.paralelo}\n\nPor favor, envíe su *RIF o Cédula* (solo números) para identificarse.`;
            await setModo(from, 'bot');
            return await sock.sendMessage(from, { text: welcomeMsg });
        }

        // --- 3. DETECCIÓN DE VENDEDOR ---
        const vendedor = await buscarVendedor(from, pushName);
        if (vendedor && (text === 'menu' || text === 'hola')) {
            const vMsg = `👋 Hola Vendedor(a) *${vendedor.nombre}*.\n\nBienvenido al sistema de gestión ONE4CARS.\n\n${MENU_TEXT}`;
            return await sock.sendMessage(from, { text: vMsg });
        }

        // --- 4. VINCULACIÓN DE RIF (CLIENTES) ---
        if (rifDetectado.length >= 6 && (!sesion || !sesion.id_cliente_int || text.includes('rif'))) {
            const c = await buscarCliente(rifDetectado);
            if (c) {
                await guardarUsuario(from, rifDetectado, c.id_cliente);
                const resp = `✅ ¡Hola *${c.nombres}*! RIF vinculado.\n\n¿Desea conocer nuestras opciones de atención? Escriba la palabra *menu* para ayudarle.`;
                return await sock.sendMessage(from, { text: resp });
            }
        }

        // --- 5. COMANDOS ---
        if (text === 'menu') return await sock.sendMessage(from, { text: MENU_TEXT });
        
        if (text.includes("saldo") || text === '2') {
            if (!sesion || !sesion.id_cliente_int) {
                if (isAdmin) return await sock.sendMessage(from, { text: "Jefe, por favor envíe el RIF del cliente que desea consultar." });
                return await sock.sendMessage(from, { text: "Para consultar su saldo, por favor envíe su *RIF o Cédula* (solo números)." });
            }
            const facturas = await obtenerDetalleFacturas(sesion.id_cliente_int);
            if (facturas.length === 0) return await sock.sendMessage(from, { text: "✅ Usted no posee facturas pendientes de pago. ¡Gracias!" });
            
            let totalP = 0; 
            let listado = "*📄 SUS FACTURAS PENDIENTES:*\n\n";
            
            facturas.forEach(f => {
                const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
                totalP += monto;
                const fReg = new Date(f.fecha_reg).toISOString().split('T')[0];
                const params = `id_factura=${f.id_factura}&nro_factura=${f.nro_factura}&fecha_reg=${fReg}&total=${f.total}&abono_factura=${f.abono_factura}&nombres=${encodeURIComponent(f.nombres.trim())}&nombre=${encodeURIComponent(f.nombre_vendedor.trim())}&direccion=${encodeURIComponent(f.direccion.trim())}&cedula=${f.cedula.trim()}&celular=${encodeURIComponent(f.celular.trim())}&telefono=${encodeURIComponent(f.telefono.trim())}&id_cliente=${f.id_cliente}&zona=${encodeURIComponent(f.zona.trim())}&descuento=${f.descuento}&total_desc=${f.total_desc}`;
                
                listado += `🔸 *#${f.nro_factura}* | $${monto.toFixed(2)}\n✍️ Firmada: https://www.one4cars.com/sevencorpweb/uploads/notas/${f.nro_factura}.jpg\n📄 PDF: https://one4cars.com/sevencorp/factura_full_reporte_web.php?${params}\n\n`;
            });
            
            listado += `💰 *TOTAL A PAGAR: $${totalP.toFixed(2)}*`;
            return await sock.sendMessage(from, { text: listado });
        }

        // --- 6. RESPUESTA CON IA DE GOOGLE (CON MEMORIA) ---
        try {
            let instrucciones = "Eres el asistente virtual de ONE4CARS.";
            if (fs.existsSync('./instrucciones.txt')) instrucciones = fs.readFileSync('./instrucciones.txt', 'utf8');
            
            const fechaHoy = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
            const historialDB = await obtenerHistorial(from);

            const prompt = `CONTEXTO ACTUAL:
Fecha y Hora: ${fechaHoy}
Dólar BCV: ${dolarInfo.bcv}
Dólar Paralelo: ${dolarInfo.paralelo}
Usuario es el DUEÑO/ADMINISTRADOR: ${isAdmin ? 'SI' : 'NO'}

INSTRUCCIONES:
${instrucciones}
${isAdmin ? 'IMPORTANTE: Estás hablando con el JEFE. Salúdalo con respeto. Él puede consultar cualquier saldo enviando el RIF de un cliente.' : ''}

HISTORIAL DE CONVERSACIÓN:
${historialDB}

RESPUESTA CORTA Y PROFESIONAL:`;

            const result = await model.generateContent(prompt);
            const responseIA = result.response.text();
            await guardarMensaje(from, 'model', responseIA);
            await sock.sendMessage(from, { text: responseIA });
        } catch (e) { console.error("IA Error"); }
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

    } else if (parsedUrl.pathname === '/marketing-panel') {
        const v = await marketingModulo.obtenerVendedores();
        const z = await marketingModulo.obtenerZonas();
        const c = await marketingModulo.obtenerClientesMarketing(parsedUrl.query);
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
        res.end(await marketingModulo.generarHTMLMarketing(c, v, z, header, parsedUrl.query));

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
                    try {
                        await socketBot.sendPresenceUpdate('composing', jid);
                        if (data.tipo === 'precios') {
                            await socketBot.sendMessage(jid, { document: { url: PDF_URL_CATALOGO }, fileName: 'Catalogo-ONE4CARS.pdf', mimetype: 'application/pdf', caption: `¡Hola *${c.nombres}*! Aquí tienes nuestro catálogo actualizado. 🚀` });
                        } else if (data.tipo === 'promo') {
                            let msg = data.subtipo === 'bienvenida' ? `*🛠️ ¡Tu Negocio, al Máximo Nivel con ONE4CARS!*\n\n¡Hola *${c.nombres}*! 👋\n\nRecibe un cordial saludo de la gerencia de ventas de *ONE4CARS*.\n\n*🌐 Acceso a tu Portal Mayorista:*\n*Enlace:* https://one4cars.com/mayoristas\n*LOGIN:* ${c.usuario}\n*PASSWORD:* ${c.clave}\n\n*🚀 Tu página personalizada:*\n➡️ https://www.one4cars.com/${c.usuario}` : (data.subtipo === 'satisfaccion' ? `*📊 CONSULTA DE SATISFACCIÓN - ONE4CARS*\n\n¡Hola *${c.nombres}*! 👋\n\n¿Cómo ha sido tu experiencia con la calidad de nuestros productos?` : data.mensaje);
                            await socketBot.sendMessage(jid, { text: msg });
                        }
                        count++;
                        if (count % 5 === 0) { await sleep(120000); }
                        else { await randomDelay(); }
                    } catch (e) { console.log("Error enviando a", jid); }
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
                    const saldoBs = (f.total - f.abono_factura) / (f.porcentaje || 1);
                    const diffDays = Math.ceil(Math.abs(new Date() - new Date(f.fecha_reg)) / (1000 * 60 * 60 * 24));
                    const diasVencidos = diffDays > 30 ? diffDays - 30 : 0;
                    const msgCobranza = `Hola *${f.nombres}* 🚗, de *ONE4CARS*.\n\nLe Notificamos que su Nota está pendiente:\n\n*Factura:* ${f.nro_factura}\n*Saldo:* Bs. *${saldoBs.toLocaleString('es-VE', {minimumFractionDigits: 2})}*\n*Presenta:* ${diasVencidos} días vencidos\n\nPor favor, gestione su pago a la brevedad. Cuide su crédito.`;
                    try {
                        await socketBot.sendPresenceUpdate('composing', jid);
                        await socketBot.sendMessage(jid, { text: msgCobranza });
                        count++;
                        if (count % 5 === 0) { await sleep(120000); }
                        else { await randomDelay(); }
                    } catch (e) { console.log("Error cobranza"); }
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
            <meta http-equiv="refresh" content="20">
            <title>Admin ONE4CARS</title>
            <style>
                body { background-color: #f4f7f6; }
                .card { border: none; border-radius: 15px; }
                .btn-custom { border-radius: 10px; padding: 12px; font-weight: 600; transition: 0.3s; }
            </style>
        </head>
        <body>
            ${header}
            <div class="container">
                <div class="row justify-content-center">
                    <div class="col-md-6 col-lg-5 mb-4">
                        <div class="card shadow-lg p-4 text-center">
                            <h4 class="mb-3">Estado del Bot</h4>
                            <div class="my-4">
                                ${qrCodeData.startsWith('data') ? `<img src="${qrCodeData}" class="img-fluid rounded shadow-sm" style="max-width: 250px;">` : `<h2 class="text-success">${qrCodeData}</h2>`}
                            </div>
                            <div class="p-3 bg-light rounded mb-4">
                                <strong>BCV:</strong> ${dolarInfo.bcv} | <strong>Paralelo:</strong> ${dolarInfo.paralelo}
                            </div>
                            <div class="d-grid gap-2">
                                <a href="/cobranza" class="btn btn-primary btn-custom shadow-sm">PANEL DE COBRANZA</a>
                                <a href="/marketing-panel" class="btn btn-info btn-custom text-white shadow-sm">PANEL DE MARKETING</a>
                            </div>
                        </div>
                    </div>
                    
                    <div class="col-md-10 col-lg-7">
                        <div class="card shadow-lg p-4">
                            <h4>Marketing Rápido</h4>
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
                            body: JSON.stringify({ clientes: ids, mensaje: msg })
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
