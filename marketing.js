// marketing.js - ACTUALIZADO
const mysql = require('mysql2/promise');
const fs = require('fs');

const dbConfig = {
    host: 'one4cars.com',
    user: 'juant200_one4car',
    password: 'Notieneclave1*',
    database: 'juant200_venezon'
};

async function obtenerClientes() {
    const conn = await mysql.createConnection(dbConfig);
    const [rows] = await conn.execute("SELECT id_cliente, nombres, telefono, usuario FROM tab_clientes WHERE telefono IS NOT NULL AND telefono != ''");
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
            await new Promise(r => setTimeout(r, 3000));
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
        const mensaje = `*🛠️ ¡Tu Negocio, al Máximo Nivel con ONE4CARS!*...`; // (Tu mensaje original)

        try {
            await sock.sendMessage(`${c.telefono}@s.whatsapp.net`, { text: mensaje });
            await new Promise(r => setTimeout(r, 3000));
        } catch (e) { console.log("Error enviando promo a", c.telefono); }
    }
    await conn.end();
}

// NUEVA FUNCIÓN: Interfaz de Marketing
async function generarHTMLMarketing(clientes, header) {
    return `
    <html>
    <head>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        <title>Panel de Marketing - ONE4CARS</title>
    </head>
    <body class="bg-light">
        ${header}
        <div class="container mt-4">
            <div class="card shadow">
                <div class="card-header bg-primary text-white">
                    <h3 class="mb-0">🚀 Campañas de Marketing WhatsApp</h3>
                </div>
                <div class="card-body">
                    <div class="mb-3">
                        <button onclick="enviarAccion('precios')" class="btn btn-success">Enviar Catálogo PDF</button>
                        <button onclick="enviarAccion('promo')" class="btn btn-info text-white">Enviar Acceso Web (Promo)</button>
                    </div>
                    <div class="table-responsive">
                        <table class="table table-hover">
                            <thead>
                                <tr>
                                    <th><input type="checkbox" id="select-all"></th>
                                    <th>Cliente</th>
                                    <th>Teléfono</th>
                                    <th>Usuario</th>
                                </tr>
                            </thead>
                            <tbody id="lista-clientes">
                                ${clientes.map(c => `
                                    <tr>
                                        <td><input type="checkbox" class="cliente-check" value="${c.id_cliente}"></td>
                                        <td>${c.nombres}</td>
                                        <td>${c.telefono}</td>
                                        <td>${c.usuario}</td>
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
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
                if(seleccionados.length === 0) return alert('Selecciona al menos un cliente');
                
                if(!confirm('¿Estás seguro de enviar mensajes a ' + seleccionados.length + ' clientes?')) return;

                const res = await fetch('/enviar-marketing', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ tipo, clientes: seleccionados })
                });
                if(res.ok) alert('Campaña iniciada con éxito');
            }
        </script>
    </body>
    </html>`;
}

module.exports = { enviarListaPrecios, enviarPromoPersonalizada, obtenerClientes, generarHTMLMarketing };
