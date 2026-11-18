/**
 * Lógica de negocio pura para rondas (sin DOM ni Firebase).
 */

export function registroCorrespondeARuta(reg, ruta) {
    if (!reg || !ruta || reg.severidad !== 'OK') return false;
    if (reg.rutaId && ruta.id) return reg.rutaId === ruta.id;
    return reg.codigoQR === ruta.codigoQR &&
        String(reg.horarioProgramado || '') === String(ruta.hora || '');
}

export function rutaCompletada(registros, ruta) {
    return (registros || []).some(reg => registroCorrespondeARuta(reg, ruta));
}

/**
 * Evalúa el estado de una ruta programada para un instante dado.
 * @param {object} ruta - ruta con { dia, hora, margen, codigoQR, puntoNombre, id }
 * @param {Date} ahora
 * @param {Array} registrosHoy - registros del día
 * @returns {{ estadoAgenda: 'completado'|'vencido'|'proximo'|'pendiente', diffMin: number, margen: number, regOk: object|null }}
 */
export function evaluarEstadoRuta(ruta, ahora, registrosHoy) {
    const [hh, mm] = (ruta.hora || '00:00').split(':').map(Number);
    const fechaObj = new Date(ahora);
    fechaObj.setHours(isNaN(hh) ? 0 : hh, isNaN(mm) ? 0 : mm, 0, 0);
    const margen = Number(ruta.margen) || 15;
    const diffMin = Math.round((ahora.getTime() - fechaObj.getTime()) / 60000);

    const regOk = (registrosHoy || []).find(reg => registroCorrespondeARuta(reg, ruta)) || null;

    let estadoAgenda = 'pendiente';
    if (regOk) {
        estadoAgenda = 'completado';
    } else if (diffMin > margen) {
        estadoAgenda = 'vencido';
    } else if (Math.abs(diffMin) <= margen) {
        estadoAgenda = 'proximo';
    }

    return { estadoAgenda, diffMin, margen, regOk, fechaObj };
}

export function obtenerMargenRegistro(reg, rutas) {
    const margenPropio = Number(reg && reg.margen);
    if (reg && reg.margen !== null && reg.margen !== undefined && !isNaN(margenPropio)) return margenPropio;
    const ruta = (rutas || []).find(r =>
        (reg && reg.rutaId && r.id === reg.rutaId) ||
        (r.codigoQR === (reg && reg.codigoQR) && String(r.hora || '') === String((reg && reg.horarioProgramado) || ''))
    );
    const margenRuta = Number(ruta && ruta.margen);
    return !isNaN(margenRuta) ? margenRuta : 15;
}

export function obtenerToleranciaRegistro(reg, punto) {
    const toleranciaPropia = Number(reg && reg.tolerancia);
    if (reg && reg.tolerancia !== null && reg.tolerancia !== undefined && !isNaN(toleranciaPropia)) return toleranciaPropia;
    return Number(punto && punto.tolerancia) || 25;
}
