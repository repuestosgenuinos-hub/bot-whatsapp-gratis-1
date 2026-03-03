<?php
include 'include/header.php';

$archivo = 'instrucciones.txt';

// Guardar cambios
if (isset($_POST['guardar'])) {
    $nuevo_contenido = $_POST['contenido'];
    file_put_contents($archivo, $nuevo_contenido);
    echo "<div class='alert alert-success'>Instrucciones actualizadas correctamente.</div>";
}

// Leer contenido actual
$contenido = file_exists($archivo) ? file_get_contents($archivo) : "";
?>

<div class="container mt-4">
    <h2>Actualizar Entrenamiento del Asistente (Gemini)</h2>
    <form method="POST">
        <div class="mb-3">
            <label class="form-label">Instrucciones y Reglas de Negocio:</label>
            <textarea name="contenido" class="form-control" rows="20" style="font-family: monospace;"><?php echo htmlspecialchars($contenido); ?></textarea>
        </div>
        <button type="submit" name="guardar" class="btn btn-primary">Guardar Cambios</button>
    </form>
</div>
