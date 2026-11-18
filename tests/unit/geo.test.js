import { describe, it, expect } from 'vitest';
import { calcularDistanciaMetros, estaDentroDeRadio } from '../../src/utils/geo.js';

describe('calcularDistanciaMetros', () => {
  it('devuelve 0 para el mismo punto', () => {
    expect(calcularDistanciaMetros(-32.86, -61.17, -32.86, -61.17)).toBe(0);
  });

  it('calcula una distancia razonable entre dos puntos cercanos', () => {
    const d = calcularDistanciaMetros(-32.8609, -61.1774, -32.8610, -61.1775);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(50);
  });

  it('es simétrica', () => {
    const a = calcularDistanciaMetros(-32.86, -61.17, -31.0, -60.0);
    const b = calcularDistanciaMetros(-31.0, -60.0, -32.86, -61.17);
    expect(a).toBe(b);
  });
});

describe('estaDentroDeRadio', () => {
  it('true si la distancia es menor o igual a la tolerancia', () => {
    expect(estaDentroDeRadio(10, 25)).toBe(true);
    expect(estaDentroDeRadio(25, 25)).toBe(true);
  });

  it('false si supera la tolerancia', () => {
    expect(estaDentroDeRadio(26, 25)).toBe(false);
  });

  it('false con valores no finitos', () => {
    expect(estaDentroDeRadio(NaN, 25)).toBe(false);
    expect(estaDentroDeRadio(10, Infinity)).toBe(false);
  });
});
