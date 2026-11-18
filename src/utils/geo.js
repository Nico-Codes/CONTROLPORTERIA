/**
 * Utilidades geográficas puras (sin dependencias de DOM ni Firebase).
 */

/**
 * Distancia en metros entre dos coordenadas (fórmula de Haversine).
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number}
 */
export function calcularDistanciaMetros(lat1, lon1, lat2, lon2) {
    const R = 6371000; // radio de la Tierra en metros
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
}

/**
 * Indica si una distancia medida está dentro de la tolerancia permitida.
 * @param {number} distancia
 * @param {number} tolerancia
 * @returns {boolean}
 */
export function estaDentroDeRadio(distancia, tolerancia) {
    return Number.isFinite(distancia) && Number.isFinite(tolerancia) && distancia <= tolerancia;
}
