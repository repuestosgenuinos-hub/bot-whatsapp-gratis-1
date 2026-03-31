const mysql = require('mysql2/promise');
const fs = require('fs');

const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

async function obtenerClientesMarketing() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT id_cliente, nombres, telefono, usuario, clave FROM tab_clientes WHERE telefono IS NOT NULL AND telefono != ''");
    await conn.end();
    return rows;
}

async function enviarListaPrecios(sock, clientesIds) {
    const pdfPath = './sevencorpweb/uploads/precios/Catalogo - ONE4CARS_compressed.pdf';
    const conn = await mysql.createConnection(dbConfig);
    
    for (const id of clientesIds) {
        const [rows] = await conn.execute("SELECT telefono FROM tab_clientes WHERE id_cliente = ?", [id]);
        if (rows.length === 0) continue;
        const tel = rows[0].telefono;
        const jid = `${tel}@s.whatsapp.net`;
        try {
            await sock.sendMessage(jid, { 
                document: fs.readFileSync(pdfPath), 
                fileName: 'Catalogo-ONE4CARS.pdf',
                mimetype: 'application/pdf',
                caption: 'Aquí tienes nuestra lista de precios actualizada. 🚀'
            });
            await new Promise(r => setTimeout(r, 3000)); // Delay anti-spam
        } catch (e) { console.log("Error enviando PDF a", tel); }
    }
    await conn.end();
}

async function enviarPromoPersonalizada(sock, clientesIds) {
    const conn = await mysql.createConnection(dbConfig);
    
    for (const id of clientesIds) {
        const [rows] = await conn.execute("SELECT * FROM tab_clientes WHERE id_cliente = ?", [id]);
        if (rows.length === 0) continue;
        const c = rows[0];
        
        const mensaje = `*🛠️ ¡Tu Negocio, al Máximo Nivel con ONE4CARS!*

¡Hola *${c.nombres}*! 👋

Recibe un cordial saludo de la gerencia de ventas de *ONE4CARS*.

Tu negocio es muy valioso para nosotros. Somos distribuidores exclusivos de ONE4CARS:

*📦 Repuestos Clave:*
• *Filtración:* Aceite y Gasolina.
• *Motor:* Correas, Poleas, Crucetas.
• *Chasis:* Rodamientos, Tren Delantero.
• *Electricidad:* Bujías, Bombas de Gasolina.

---
*🌐 Acceso a tu Portal Mayorista:*
*Enlace:* https://one4cars.com/mayoristas
*LOGIN:* ${c.usuario}
*PASSWORD:* ${c.clave || 'Consulte con su vendedor'}

---
*🚀 Tu Página Web Personalizada:*
➡️ https://www.one4cars.com/${c.usuario}

Un abrazo grande.
El equipo de ONE4CARS.`;

        try {
            await sock.sendMessage(`${c.telefono}@s.whatsapp.net`, { text: mensaje });
            await new Promise(r => setTimeout(r, 3000));
        } catch (e) { console.log("Error enviando promo a", c.telefono); }
    }
    await conn.end();
}

async function generarHTMLMarketing(clientes, header) {
    return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Panel de Marketing - ONE4CARS</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        <style>
            .sticky-panel { position: sticky; top: 20px; }
            .table-container { max-height: 70vh; overflow-y: auto; }
        </style>
    </head>
    <body class="bg-light">
        ${header}
        <div class="container-fluid px-4">
            <div class="row">
                <div class="col-md-8">
                    <div class="card shadow-sm mb-4">
                        <div class="card-header bg-primary text-white d-flex justify-content-between align-items-center">
                            <h5 class="mb-0">Lista de Clientes para Campañas</h5>
                            <span class="badge bg-light text-dark">${clientes.length} Clientes</span>
                        </div>
                        <div class="card-body p-0">
                            <div class="table-container">
                                <table class="table table-hover mb-0">
                                    <thead class="table-dark sticky-top">
                                        <tr>
                                            <th width="40"><input type="checkbox" id="select-all" class="form-check-input"></th>
                                            <th>Cliente</th>
                                            <th>Teléfono</th>
                                            <th>Usuario</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        ${clientes.map(c => `
                                            <tr>
                                                <td><input type="checkbox" class="cliente-check form-check-input" value="${c.id_cliente}"></td>
                                                <td>${c.nombres}</td>
                                                <td>${c.telefono}</td>
                                                <td><code class="text-primary">${c.usuario}</code></td>
                                            </tr>
                                        `).join('')}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="col-md-4">
                    <div class="card shadow-sm sticky-panel">
                        <div class="card-header bg-dark text-white">
                            <h5 class="mb-0">Acciones de Campaña</h5>
                        </div>
                        <div class="card-body text-center">
                            <p class="text-muted small">Selecciona clientes en la tabla y elige una acción:</p>
                            <button onclick="enviarAccion('precios')" class="btn btn-success w-100 mb-3 py-3">
                                📄 Enviar Catálogo PDF
                            </button>
                            <button onclick="enviarAccion('promo')" class="btn btn-info w-100 py-3 text-white">
                                🔑 Enviar Accesos / Promo
                            </button>
                            <hr>
                            <div id="status-marketing" class="alert alert-secondary d-none">
                                Procesando envío...
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <script>
            document.getElementById('select-all').onclick = function() {
                document.querySelectorAll('.cliente-check').forEach(cb => cb.checked = this.checked);
            }

            async function enviarAccion(tipo) {
                const seleccionados = Array.from(document.querySelectorAll('.cliente-check:checked')).map(cb => cb.value);
                if(seleccionados.length === 0) return alert('Debe seleccionar al menos un cliente.');
                
                if(!confirm('¿Desea iniciar el envío masivo a ' + seleccionados.length + ' clientes?\\nSe aplicará un retraso de 3 segundos entre cada mensaje.')) return;

                const status = document.getElementById('status-marketing');
                status.classList.remove('d-none');
                status.innerText = "🚀 Iniciando envío...";

                try {
                    const res = await fetch('/enviar-marketing', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ tipo, clientes: seleccionados })
                    });
                    if(res.ok) {
                        alert('Campaña enviada al servidor con éxito.');
                        status.innerText = "✅ Envío completado";
                    } else {
                        alert('Error al procesar la campaña.');
                        status.innerText = "❌ Error";
                    }
                } catch (e) {
                    alert('Error de conexión');
                }
            }
        </script>
    </body>
    </html>`;
}

module.exports = { enviarListaPrecios, enviarPromoPersonalizada, obtenerClientesMarketing, generarHTMLMarketing };
