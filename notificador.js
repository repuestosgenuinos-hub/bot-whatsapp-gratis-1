// notificador.js
const mysql = require('mysql2/promise');

const INTERVALO_REVISION = 60000; // 1 minuto
const DELAY_ENTRE_MENSAJES = 8000; // 8 segundos anti-ban
const LIMITE_POR_CICLO = 10;
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function formatPhone(phone) {
    if (!phone) return null;
    let clean = phone.replace(/\D/g, '');
    if (clean.length === 0) return null;
    if (clean.startsWith('580')) clean = '58' + clean.substring(3);
    else if (clean.startsWith('0')) clean = '58' + clean.substring(1);
    else if (!clean.startsWith('58')) clean = '58' + clean;
    return `${clean}@s.whatsapp.net`;
}

async function procesarFacturas(sock, pool) {
    if (!sock || !sock.user) return;

    try {
        console.log(`🔍 ${new Date().toLocaleTimeString()} - Notificador: Revisando DB...`);

        // 1. NOTIFICACIONES INMEDIATAS
        const [nuevas] = await pool.execute(
            `SELECT f.id_factura, f.nro_factura, f.total, f.id_cliente, f.id_vendedor, f.vendedor 
             FROM tab_facturas f WHERE f.pagada = 'NO'  and f.vendedor <> 'OFICINA' AND f.whatsapp_notificado = 'NO' LIMIT ?`, 
            [LIMITE_POR_CICLO]
        );

        for (const f of nuevas) {
            await enviarNotificacionInmediata(sock, pool, f);
            await sleep(DELAY_ENTRE_MENSAJES); 
        }

        // 2. NOTIFICACIONES DE MORA (30 DÍAS)
        const [morosas] = await pool.execute(
            `SELECT f.id_factura, f.nro_factura, f.total, f.id_cliente, f.id_vendedor , f.vendedor
             FROM tab_facturas f WHERE f.pagada = 'NO' and f.vendedor <> 'OFICINA' AND f.whatsapp_mora = 'NO' 
             AND DATEDIFF(CURDATE(), f.fecha_reg) >= 30 LIMIT ?`, 
            [LIMITE_POR_CICLO]
        );

        for (const f of morosas) {
            await enviarNotificacionMora(sock, pool, f);
            await sleep(DELAY_ENTRE_MENSAJES);
        }
    } catch (error) {
        console.error("❌ Error Notificador:", error.message);
    }
}

async function enviarNotificacionInmediata(sock, pool, factura) {
    try {
        const [[cliente]] = await pool.execute("SELECT nombres, celular FROM tab_clientes WHERE id_cliente = ?", [factura.id_cliente]);
        const [[vendedor]] = await pool.execute("SELECT nombre, celular_vendedor FROM tab_vendedores WHERE id_vendedor = ?", [factura.id_vendedor]);

        if (cliente && vendedor) {
            const msgCliente = `📄 *Aviso de Facturación*\n\nHola *${cliente.nombres}*, se ha generado la factura *#${factura.nro_factura}* por un monto de *$${factura.total}*.`;
            const msgVendedor = `✅ *Nueva Venta*\n\nHola *${vendedor.nombre}*, se ha emitido la factura *#${factura.nro_factura}* al cliente *${cliente.nombres}*.`;
            const jidC = formatPhone(cliente.celular);
            const jidV = formatPhone(vendedor.celular_vendedor);

            if (jidC) await sock.sendMessage(jidC, { text: msgCliente });
            if (jidV) await sock.sendMessage(jidV, { text: msgVendedor });
            await pool.execute("UPDATE tab_facturas SET whatsapp_notificado = 'SI' WHERE id_factura = ?", [factura.id_factura]);
            console.log(`[Notificador] ✅ Factura #${factura.nro_factura} enviada.`);
        }
    } catch (e) { console.error(`❌ Error Inmediata ${factura.id_factura}:`, e.message); }
}

async function enviarNotificacionMora(sock, pool, factura) {
    try {
        const [[cliente]] = await pool.execute("SELECT nombres, celular FROM tab_clientes WHERE id_cliente = ?", [factura.id_cliente]);
        const [[vendedor]] = await pool.execute("SELECT nombre, celular_vendedor FROM tab_vendedores WHERE id_vendedor = ?", [factura.id_vendedor]);

        if (cliente && vendedor) {
            const msgCliente = `⚠️ *RECORDATORIO DE PAGO*\n\nEstimado *${cliente.nombres}*, su factura *#${factura.nro_factura}* presenta un retraso de más de 30 días. Monto: *$${factura.total}*.`;
            const msgVendedor = `🚩 *ALERTA DE MORA*\n\nHola *${vendedor.nombre}*, el cliente *${cliente.nombres}* tiene la factura *#${factura.nro_factura}* vencida.`;
            const jidC = formatPhone(cliente.celular);
            const jidV = formatPhone(vendedor.celular_vendedor);

            if (jidC) await sock.sendMessage(jidC, { text: msgCliente });
            if (jidV) await sock.sendMessage(jidV, { text: msgVendedor });
            await pool.execute("UPDATE tab_facturas SET whatsapp_mora = 'SI' WHERE id_factura = ?", [factura.id_factura]);
            console.log(`[Notificador] 🚩 Mora factura #${factura.nro_factura} enviada.`);
        }
    } catch (e) { console.error(`❌ Error Mora ${factura.id_factura}:`, e.message); }
}

module.exports = { procesarFacturas, INTERVALO_REVISION };
