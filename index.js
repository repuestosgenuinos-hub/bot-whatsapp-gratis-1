--- START OF FILE text/javascript ---

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const http = require('http');
const pino = require('pino');
const fs = require('fs');
const mysql = require('mysql2/promise');
const axios = require('axios');

// CAPTURA GLOBAL DE ERRORES
process.on('unhandledRejection', (err) => {
    const msg = err?.message || err;
    console.log("[UNHANDLED] Error no capturado:", msg);
    if (msg === "Connection Closed" && socketBot) {
        setTimeout(() => startBot(), 3000);
    }
});
process.on('uncaughtException', (err) => {
    console.log("[UNCAUGHT] Error crítico:", err?.message || err);
});

// MODULOS EXTERNOS
const cobranza = require('./cobranza');
const marketingModulo = require('./marketing');
const notificador = require('./notificador_local');

// CONFIGURACION
const PORT = process.env.PORT || 10000;

// LISTA DE ADMINISTRADORES
const ADMIN_IDS = ["228621243408492", "97899534934200", "584142531553", "250370957778958", "244362214650069", "60305753296939", "1924162162820", "39058600415402", "58381658247238"];   

const pool = mysql.createPool({
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const PDF_URL_CATALOGO = "https://www.one4cars.com/sevencorpweb/uploads/precios/Catalogo%20-%20ONE4CARS_compressed.pdf";

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

const MENU_INTENTIONS = {
    '1': { keywords: ['medios de pago', 'pago movil', 'datos de pago', 'como pagar', 'datos bancarios', 'cuentas para pagar'], response: `1️⃣ *Medios de pago:* https://www.one4cars.com/medios_de_pago.php/` },
    '2': { keywords: ['estado de cuenta', 'cuanto debo', 'listado de facturas pendiente', 'mi saldo', 'facturas pendientes', 'mi deuda', 'listado de facturas', 'cuentas por cobrar'], response: `2️⃣ *Estado de cuenta:* https://www.one4cars.com/estado_de_cuenta.php/` },
    '3': { keywords: ['lista de precios', 'listado de precios', 'catalogo de precios', 'cuanto cuestan' , 'pasame la lista', 'ver precios'], response: `3️⃣ *Lista de precios:* https://www.one4cars.com/lista_de_precios.php/` },
    '4': { keywords: ['tomar pedido', 'hacer un pedido', 'quiero comprar', 'realizar pedido'], response: `4️⃣ *Tomar pedido:* https://www.one4cars.com/tomar_pedido.php/` },
    '5': { keywords: ['mis clientes', 'lista de vendedores', 'mis vendedores', 'ver mis clientes'], response: `5️⃣ *Mis clientes/Vendedores:* https://www.one4cars.com/mis_clientes.php/` },
    '6': { keywords: ['afiliar cliente', 'registrar cliente', 'dar de alta cliente', 'nuevo cliente'], response: `6️⃣ *Afiliar cliente:* https://www.one4cars.com/afiliar_clientes.php/` },
    '7': { keywords: ['consulta de productos', 'buscar en inventario', 'ver disponibilidad',  'saber de sus productos', 'buscar repuesto'], response: `7️⃣ *Consulta de productos:* https://www.one4cars.com/consulta_productos.php/` },
    '8': { keywords: ['seguimiento despacho', 'donde esta mi pedido', 'estatus del envio', 'rastrear pedido'], response: `8️⃣ *Seguimiento Despacho:* https://www.one4cars.com/despacho.php/` },
    '9': { keywords: ['asesor humano', 'hablar con un operador', 'soporte humano', 'quiero hablar con alguien', 'ayuda de un operador'], response: `9️⃣ *Asesor Humano:* Indique su duda y un operador revisará el caso pronto. 👩‍💻` }
};

let qrCodeData = "Iniciando...";
let socketBot = null;
let dolarInfo = { bcv: 'Cargando...', paralelo: 'Cargando...' };
let notificadorInterval = null;

// ===== FUNCIONES DE APOYO =====

function normalizar(texto) {
    return texto
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") 
        .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?!]/g, "") 
        .toLowerCase()
        .trim();
}

function limpiarRIF(texto) {
    return texto.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

function esRIFReal(texto) {
    const limpio = limpiarRIF(texto);
    // Un RIF real empieza con V, E, J, G y tiene entre 8 y 10 caracteres
    return /^[VEJG]\d{8,9}$/i.test(limpio);
}

async function safeSendMessage(jid, content) {
    try {
        if (!socketBot) throw new Error("Socket no inicializado");
        await socketBot.sendMessage(jid, content);
    } catch (e) {
        console.log(`[MSG] ❌ Error enviando mensaje:`, e.message);
    }
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

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const randomDelay = async () => {
    const ms = Math.floor(Math.random() * (25000 - 15000 + 1)) + 15000; 
    await sleep(ms);
};

// ===== BASE DE DATOS =====
async function initDB() {
    try {
        await pool.execute(`CREATE TABLE IF NOT EXISTS control_chat (telefono VARCHAR(100) PRIMARY KEY, usuario VARCHAR(50), id_cliente_int INT, modo VARCHAR(20) DEFAULT 'bot', updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        await pool.execute(`CREATE TABLE IF NOT EXISTS historial_chat (id INT AUTO_INCREMENT PRIMARY KEY, telefono VARCHAR(100), rol ENUM('user', 'model'), contenido TEXT, fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        await pool.execute(`CREATE TABLE IF NOT EXISTS recordatorios_log (id INT AUTO_INCREMENT PRIMARY KEY, id_factura INT NOT NULL, nivel INT NOT NULL, fecha_envio TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uk_recordatorio (id_factura, nivel)) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        await pool.execute(`CREATE TABLE IF NOT EXISTS envio_vendedor_log (id INT AUTO_INCREMENT PRIMARY KEY, fecha_envio DATE NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_unicode_ci`);
        console.log("✅ Base de Datos vinculada.");
    } catch (e) { console.log("❌ Error DB Init:", e.message); }
}

async function getSesion(jid) {
    const [r] = await pool.execute("SELECT * FROM control_chat WHERE telefono=?", [jid]);
    return r[0] || null;
}

async function guardarUsuario(jid, usuario, id_int) {
    await pool.execute(`INSERT INTO control_chat (telefono, usuario, id_cliente_int, modo) VALUES (?, ?, ?, 'bot') ON DUPLICATE KEY UPDATE usuario=VALUES(usuario), id_cliente_int=VALUES(id_cliente_int), modo='bot'`, [jid, usuario, id_int]);
}

async function buscarCliente(rifLimpio) {
    const [r] = await pool.execute("SELECT id_cliente, nombres, celular, cedula, direccion, zona FROM tab_clientes WHERE clave = ? LIMIT 1", [rifLimpio]);
    return r[0] || null;
}

// ===== LÓGICA DE BÚSQUEDA DE PRODUCTOS INFALIBLE =====
async function buscarProductoPorTexto(texto) {
    const txtNormal = normalizar(texto);
    
    // 1. Búsqueda Exacta por Código (Si el texto es solo un código alfanumérico)
    if (/^[a-zA-Z0-9]+$/.test(txtNormal) && txtNormal.length < 15) {
        const [exacts] = await pool.execute("SELECT producto, descripcion, tipo, precio_final FROM tab_productos WHERE producto = ? AND (cantidad_existencia + cantidad_existencia_almacen > 0) LIMIT 1", [txtNormal.toUpperCase()]);
        if (exacts.length > 0) return exacts;
    }

    // 2. Búsqueda por Relevancia (Scoring)
    const stopWords = ['tienes', 'la', 'del', 'quiere', 'saber', 'cuanto', 'mide', 'venden', 'donde', 'precio', 'tienen', 'el', 'una', 'un', 'hay', 'si', 'es', 'de', 'con', 'para', 'busco', 'hola', 'buenos', 'buenas', 'dias', 'tardes', 'noches', 'como', 'estas', 'esta', 'familia', 'espero', 'encuentres', 'bien', 'queria', 'preguntarte', 'gracias', 'por', 'favor', 'ayuda', 'puedes', 'podrias', 'quisiera', 'necesito', 'saludos', 'cordial', 'muchas', 'todo', 'bienvenidos', 'bendiciones', 'exito', 'exitos', 'dia', 'tarde', 'noche', 'pregunta', 'consulta', 'atento', 'atenta', 'saludo', 'estimados', 'estimado', 'buen', 'buena', 'bueno', 'se', 'me', 'le', 'te', 'lo', 'los', 'las', 'les', 'su', 'sus', 'mi', 'mis', 'tu', 'tus', 'nos', 'os', 'que', 'cual', 'cuales', 'quien', 'quienes', 'cuando', 'porque', 'pues', 'pero', 'mas', 'muy', 'asi', 'aun', 'entre', 'sin', 'sobre', 'tras', 'durante', 'mediante', 'excepto', 'segun', 'puede', 'puedo', 'pueden', 'podemos', 'podria', 'hacer', 'hace', 'hacen', 'ser', 'estar', 'tener', 'tengo', 'tenemos', 'tiene', 'decir', 'dice', 'dicen', 'digo', 'ver', 'veo', 'ven', 'vez', 'veces', 'quiero', 'quiere', 'quieren', 'queremos', 'gustaria', 'gusta', 'gustan', 'gusto', 'necesita', 'necesitan', 'necesitamos', 'pueda', 'unid', 'unidades', 'unidad', 'puedas', 'pudiera', 'pudieras', 'listo', 'claro', 'ok', 'okey', 'vale', 'va', 'vamos', 'vaya', 'algun', 'alguna', 'algunos', 'algunas', 'ningun', 'ninguna', 'tipo', 'tipos', 'preguntar', 'disculpa', 'disculpe', 'permiso', 'ayudar', 'apoyo', 'consulta', 'consultar', 'info', 'informacion', 'decirme', 'dime', 'avísame', 'avisa', 'saber', 'sabes', 'saben', 'sabemos', 'pana', 'panas', 'brother', 'bro', 'amigo', 'amigos', 'compa', 'compadre', 'ando', 'andas', 'andan', 'andaba', 'andabas', 'andabamos', 'andaban', 'estoy', 'estas', 'esta', 'estaba', 'estabas', 'estabamos', 'estaban', 'vengo', 'vienes', 'viene', 'vienen', 'venia', 'venias', 'veniamos', 'venian', 'voy', 'vas', 'va', 'vamos', 'van', 'iba', 'ibas', 'ibamos', 'iban', 'llegando', 'pais', 'país', 'atento'];

    const palabrasBase = txtNormal.split(' ').filter(p => p.length > 2 && !stopWords.includes(p));
    if (palabrasBase.length === 0) return null;

    // Construimos una consulta que sume coincidencias
    let scoreSQL = "";
    let params = [];
    palabrasBase.forEach(pal => {
        scoreSQL += `(CASE WHEN descripcion LIKE ? THEN 1 ELSE 0 END) + `;
        params.push(`%${pal}%`);
    });
    scoreSQL = scoreSQL.slice(0, -3); // Quitar el último ' + '

    const sql = `
        SELECT producto, descripcion, tipo, precio_final, (${scoreSQL}) as relevancia 
        FROM tab_productos 
        WHERE (cantidad_existencia + cantidad_existencia_almacen > 0) 
        AND (${palabrasBase.map(() => "descripcion LIKE ?").join(" OR ")})
        ORDER BY relevancia DESC 
        LIMIT 5`;
    
    const finalParams = [...params, ...params];
    const [rows] = await pool.execute(sql, finalParams);

    if (rows.length === 0) return null;

    // FILTRO DEFINITIVO: Solo devolver los que tengan la máxima puntuación encontrada
    const maxScore = rows[0].relevancia;
    return rows.filter(r => r.relevancia === maxScore);
}

async function obtenerDetalleFacturas(id_cliente) {
    const [facturas] = await pool.execute(
        "SELECT f.id_factura, f.nro_factura, f.total, f.abono_factura, f.fecha_reg, f.porcentaje, f.descuento, f.total_desc, c.nombres, c.direccion, c.cedula, c.celular, c.telefono, c.id_cliente, c.zona, f.id_vendedor as nombre_vendedor FROM tab_facturas f JOIN tab_clientes c ON f.id_cliente = c.id_cliente WHERE f.id_cliente = ? AND f.pagada = 'NO' AND f.anulado = 'no'", 
        [id_cliente]
    );
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

// ===== NOTIFICADORES Y RECORDATORIOS (Mantenidos igual que el original) =====
let notificadorEjecutando = false;
async function checkNuevasFacturas() {
    if (!isBotReady() || notificadorEjecutando) return;
    notificadorEjecutando = true;
    try {
        const facturas = await notificador.obtenerFacturasNoNotificadas();
        for (const f of facturas) {
            const jid = formatWhatsApp(f.celular);
            if (!jid) continue;
            const fecha = new Date(f.fecha_reg).toISOString().split('T')[0];
            const msg = `🧾 *NUEVA FACTURA REGISTRADA*\n\nHola *${f.nombres}*, se ha registrado una nueva factura en nuestro sistema:\n\n🔹 *N°:* ${f.nro_factura}\n🔹 *Monto:* $${parseFloat(f.total).toFixed(2)}\n🔹 *Fecha:* ${fecha}\n\nPuede consultar su estado de cuenta en:\nhttps://www.one4cars.com/estado_de_cuenta.php/`;
            await safeSendMessage(jid, { text: msg });
            await pool.execute("UPDATE tab_facturas SET whatsapp_notificado = 'SI' WHERE id_factura = ?", [f.id_factura]);
            await sleep(1000);
        }
    } catch (e) { console.log("[NOTIFICADOR] Error:", e.message); } finally { notificadorEjecutando = false; }
}

async function checkFacturasVencidas() {
    if (!isBotReady()) return;
    try {
        const facturas = await notificador.obtenerFacturasVencidas();
        const enviados = await notificador.obtenerRecordatoriosEnviados();
        for (const f of facturas) {
            const dias = f.dias_vencida;
            const nivel = (dias >= 60) ? 60 : (dias >= 50) ? 50 : (dias >= 40) ? 40 : (dias >= 30) ? 30 : null;
            if (!nivel) continue;
            const monto = (parseFloat(f.total) - parseFloat(f.abono_factura || 0)) / (parseFloat(f.porcentaje) || 1);
            if (monto <= 0) continue;
            const yaEnviado = enviados[f.id_factura] && enviados[f.id_factura].includes(nivel);
            if (!yaEnviado) {
                const jid = formatWhatsApp(f.celular);
                if (jid) await safeSendMessage(jid, { text: `🧾 *RECORDATORIO DE PAGO*\n\nHola *${f.nombres}*, la factura *N° ${f.nro_factura}* presenta un saldo de *$${monto.toFixed(2)}*.` });
                await notificador.marcarRecordatorio(f.id_factura, nivel);
            }
        }
    } catch (e) { console.log("[RECORDATORIO] Error:", e.message); }
}

async function checkVendedoresRecordatorio() {
    if (!isBotReady()) return;
    try {
        const hoy = new Date().getDay();
        if (hoy === 0 || hoy === 6) return;
        const facturas = await notificador.obtenerFacturasVencidasAll();
        const vendedoresMap = {};
        for (const f of facturas) {
            if (f.dias_vencida < 30 || !f.celular_vendedor) continue;
            const key = f.celular_vendedor.toString().replace(/\D/g, '');
            if (!vendedoresMap[key]) vendedoresMap[key] = { nombre: f.vendedor_nombre || 'Vendedor', jid: formatWhatsApp(f.celular_vendedor), facturas: [] };
            vendedoresMap[key].facturas.push(`🔹 *#${f.nro_factura}* - ${f.nombres} - $${((parseFloat(f.total)-parseFloat(f.abono_factura || 0))/(parseFloat(f.porcentaje)||1)).toFixed(2)}`);
        }
        for (const key of Object.keys(vendedoresMap)) {
            const v = vendedoresMap[key];
            await safeSendMessage(v.jid, { text: `📢 *RESUMEN DE CLIENTES VENCIDOS*\n\nVendedor: *${v.nombre}*\n\n${v.facturas.join('\n')}` });
            await sleep(1000);
        }
        await notificador.marcarEnvioVendedor();
    } catch (e) { console.log("[VENDEDORES] Error:", e.message); }
}

// ===== BOT WHATSAPP =====
async function startBot() {
    if (socketBot) {
        try { socketBot.removeAllListeners(); socketBot.end(undefined); } catch (e) {}
        socketBot = null;
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version, auth: state, logger: pino({ level: 'silent' }),
        printQRInTerminal: false, browser: ["ONE4CARS MASTER", "Chrome", "1.0.0"]
    });

    socketBot = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (u) => {
        const { connection, lastDisconnect, qr } = u;
        if (qr) qrcode.toDataURL(qr, { scale: 10 }, (_, url) => qrCodeData = url);
        if (connection === 'open') { 
            qrCodeData = "ONLINE ✅"; 
            console.log("🚀 BOT MASTER ONLINE");
            if (!notificadorInterval) {
                notificadorInterval = setInterval(checkNuevasFacturas, 45000);
                setInterval(checkFacturasVencidas, 86400000);
                setInterval(checkVendedoresRecordatorio, 86400000);
            }
        }
        if (connection === 'close') {
            const r = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (r) setTimeout(() => startBot(), 5000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
            if (type !== 'notify') return;
            const msg = messages[0];
            if (!msg.message) return;

            const from = msg.key.remoteJid;
            if (from === 'status@broadcast' || from.includes('@g.us')) return;

            const isAdmin = ADMIN_IDS.some(id => from.includes(id));
            const pushName = msg.pushName || "Usuario";
            const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
            if (!rawText) return;

            const text = normalizar(rawText);
            const sesion = await getSesion(from);

            if (msg.key.fromMe) {
                if (text === '!bot') { await pool.execute("INSERT INTO control_chat (telefono, modo) VALUES (?, 'bot') ON DUPLICATE KEY UPDATE modo='bot'", [from]); await safeSendMessage(from, { text: "🤖 Bot reactivado." }); } 
                else { await pool.execute("INSERT INTO control_chat (telefono, modo) VALUES (?, 'humano') ON DUPLICATE KEY UPDATE modo='humano'", [from]); }
                return;
            }

            if (sesion && sesion.modo === 'humano' && !isAdmin) return;

            // --- PRIORIDAD 1: Búsqueda de Producto (Códigos y Nombres) ---
            // Si el texto es un código numérico o una búsqueda de producto, se procesa primero para TODOS
            if (/^\d+$/.test(rawText) || (text.length > 3 && !esRIFReal(rawText))) {
                const prods = await buscarProductoPorTexto(rawText);
                if (prods && prods.length > 0) {
                    const saludos = ["Saludos estimado, gracias por tu consulta puedo recomendarte este artículo: 👇", "¡Hola! He buscado en nuestro inventario y esto es lo que buscas: 👇"];
                    await safeSendMessage(from, { text: saludos[Math.floor(Math.random() * saludos.length)] });
                    await sleep(1000);

                    for (const p of prods) {
                        const precioLimpio = parseFloat(p.precio_final || 0).toFixed(2);
                        const caption = `📦 *CÓDIGO: ${p.producto}*\n💰 *Precio Final: $${precioLimpio}*\n📝 ${p.descripcion}\n🔗 Ficha: https://one4cars.com/producto_general.php?cod=${p.producto}&tipo=${encodeURIComponent(p.tipo)}`;
                        const imgUrl = `https://one4cars.com/imagen/${p.producto}.jpg`;
                        try { await socketBot.sendMessage(from, { image: { url: imgUrl }, caption: caption }); } catch (e) { await safeSendMessage(from, { text: caption }); }
                        await sleep(1000);
                    }
                    return;
                }
            }

            // --- PRIORIDAD 2: Lógica de RIF (SOLO ADMINS) ---
            if (isAdmin && esRIFReal(rawText)) {
                const rifLimpio = limpiarRIF(rawText);
                const c = await buscarCliente(rifLimpio);
                if (c) {
                    await guardarUsuario(from, rifLimpio, c.id_cliente);
                    const facturas = await obtenerDetalleFacturas(c.id_cliente);
                    let totalP = 0; 
                    let list = `⭐ *CONSULTA ADMIN*\nCliente: ${c.nombres}\nRIF: ${rifLimpio}\n\n`;
                    if (facturas.length === 0) list += `✅ Sin facturas pendientes.`;
                    else {
                        facturas.forEach(f => {
                            const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
                            totalP += monto;
                            list += `🔸 *#${f.nro_factura}* | $${monto.toFixed(2)}\n✍️ https://www.one4cars.com/uploads/notas/${f.nro_factura}.jpg\n\n`;
                        });
                        list += `💰 *TOTAL: $${totalP.toFixed(2)}*`;
                    }
                    return await safeSendMessage(from, { text: list });
                } else {
                    return await safeSendMessage(from, { text: "❌ No se encontró ningún cliente con ese RIF." });
                }
            }

            // --- PRIORIDAD 3: Menú e Intenciones ---
            const menuOption = detectarIntencionMenu(text);
            if (menuOption) {
                if (menuOption.includes('Estado de cuenta')) {
                    const targetID = sesion?.id_cliente_int;
                    if (!targetID) return await safeSendMessage(from, { text: "Para consultar su estado, por favor envíe su *RIF*." });
                    const facturas = await obtenerDetalleFacturas(targetID);
                    if (facturas.length === 0) return await safeSendMessage(from, { text: "✅ No posee facturas pendientes." });
                    let totalP = 0; let listado = "*📄 FACTURAS PENDIENTES:*\n\n";
                    facturas.forEach(f => {
                        const monto = (f.total - f.abono_factura) / (f.porcentaje || 1);
                        totalP += monto;
                        listado += `🔸 *#${f.nro_factura}* | $${monto.toFixed(2)}\n📄 PDF: https://one4cars.com/sevencorp/factura_full_reporte_web.php?id_factura=${f.id_factura}\n\n`;
                    });
                    listado += `💰 *TOTAL A PAGAR: $${totalP.toFixed(2)}*`;
                    return await safeSendMessage(from, { text: listado });
                }
                return await safeSendMessage(from, { text: menuOption });
            }

            // --- PRIORIDAD 4: Pagos y Facturación ---
            if (text.includes('pago') || text.includes('abono') || text.includes('adjunto pago')) {
                return await safeSendMessage(from, { text: `¡Hola *${pushName}*! Gracias por su mensaje. 😊 Recibido, administración validará su pago a la brevedad.\n\n${MENU_TEXT}` });
            }
            if (text.includes('factura fiscal') || text.includes('iva')) {
                return await safeSendMessage(from, { text: `¡Hola *${pushName}*! 😊 La Factura Fiscal será realizada el día que tenga disponibilidad de hacer el pago.\n\n${MENU_TEXT}` });
            }

            // --- PRIORIDAD 5: Saludos y Fallback ---
            if (['menu', 'hola', 'buen dia', 'buenos dias'].includes(text)) {
                return await safeSendMessage(from, { text: `¡Hola *${pushName}*! Es un gusto saludarte. 😊\n\n¿En qué podemos ayudarte hoy?\n\n${MENU_TEXT}` });
            }

            const conversationalShorts = ['si', 'no', 'ok', 'vale', 'gracias', 'ya', 'entendido', 'claro'];
            if (conversationalShorts.includes(text)) return;

            await safeSendMessage(from, { text: "Lo siento, no logré entender tu solicitud. 😕 ¿Podrías darme más detalles o escribir *menu*?" });

        } catch (e) { console.log("[MSG] Error:", e.message); }
    });
}

function detectarIntencionMenu(texto) {
    if (!texto) return null;
    if (/^\d$/.test(texto)) {
        const num = texto.charAt(0);
        if (MENU_INTENTIONS[num]) return MENU_INTENTIONS[num].response;
    }
    for (const key in MENU_INTENTIONS) {
        if (MENU_INTENTIONS[key].keywords.some(phrase => texto.includes(phrase))) return MENU_INTENTIONS[key].response;
    }
    return null;
}

// ===== SERVIDOR HTTP (Mantenido igual) =====
const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    const header = `<nav class="navbar navbar-dark bg-dark mb-4 shadow"><div class="container"><a class="navbar-brand fw-bold" href="/">ONE4CARS ADMIN</a></div></nav>`;
    const routename = parsedUrl.pathname;

    if (routename === '/cobranza') {
        const v = await cobranza.obtenerVendedores();
        const z = await cobranza.obtenerZonas();
        const d = await cobranza.obtenerListaDeudores(query);
        res.end(await cobranza.generarHTML(v, z, d, header, query));
    } else if (routename === '/marketing-panel') {
        const v = await marketingModulo.obtenerVendedores();
        const z = await marketingModulo.obtenerZonas();
        const c = await marketingModulo.obtenerClientesMarketing(query);
        res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
        res.end(await marketingModulo.generarHTMLMarketing(c, v, z, header, query));
    } else if (routename === '/reset-sesion') {
        if (fs.existsSync('auth_info')) fs.rmSync('auth_info', { recursive: true, force: true });
        res.end("Sesión borrada. Reinicie el bot.");
    } else {
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"><meta http-equiv="refresh" content="30"><title>Admin ONE4CARS</title></head><body style="background-color: #f4f7f6;">${header}<div class="container text-center"><div class="card shadow-lg p-4 mx-auto" style="max-width: 500px; border-radius: 15px;"><h4 class="mb-3">Estado del Bot</h4><div class="my-4">${qrCodeData.startsWith('data') ? `<img src="${qrCodeData}" class="img-fluid rounded" style="max-width: 250px;">` : `<h2 class="text-success">${qrCodeData}</h2>`}</div><p>BCV: ${dolarInfo.bcv} | Paralelo: ${dolarInfo.paralelo}</p><div class="d-grid gap-2"><a href="/cobranza" class="btn btn-primary">PANEL DE COBRANZA</a><a href="/marketing-panel" class="btn btn-info text-white">PANEL DE MARKETING</a></div></div></div></body></html>`);
    }
});

server.listen(PORT, '0.0.0.0', async () => {
    await initDB();
    startBot();
    actualizarDolar();
    setInterval(actualizarDolar, 3600000);
});
