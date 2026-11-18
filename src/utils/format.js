/**
 * Utilidades de formato puras.
 */

export function obtenerIniciales(nombre) {
    if (!nombre || typeof nombre !== 'string') return 'OP';
    const partes = nombre.trim().split(/\s+/);
    return partes.map(n => n[0] || '').join('').substring(0, 2).toUpperCase() || 'OP';
}

export function formatearHora24(dateObj) {
    if (!dateObj || isNaN(dateObj.getTime())) return '—';
    return `${String(dateObj.getHours()).padStart(2, '0')}:${String(dateObj.getMinutes()).padStart(2, '0')}`;
}

export function formatearDeltaMinutos(mins) {
    const abs = Math.abs(mins);
    if (abs < 60) return `${abs} min`;
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

export function escapeHtml(valor) {
    return String(valor ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

export function obtenerFechaHoyISO(fecha = new Date()) {
    return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`;
}
