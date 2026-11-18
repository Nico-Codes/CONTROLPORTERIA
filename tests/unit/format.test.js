import { describe, it, expect } from 'vitest';
import { obtenerIniciales, formatearHora24, formatearDeltaMinutos, escapeHtml, obtenerFechaHoyISO } from '../../src/utils/format.js';

describe('obtenerIniciales', () => {
  it('devuelve las iniciales en mayúsculas', () => {
    expect(obtenerIniciales('Gabriel Vega')).toBe('GV');
    expect(obtenerIniciales('Guillermo Marrone')).toBe('GM');
  });
  it('maneja un solo nombre', () => {
    expect(obtenerIniciales('Nico')).toBe('N');
  });
  it('devuelve OP para valores vacíos', () => {
    expect(obtenerIniciales('')).toBe('OP');
    expect(obtenerIniciales(null)).toBe('OP');
  });
});

describe('formatearHora24', () => {
  it('formatea con cero a la izquierda', () => {
    const d = new Date(2026, 0, 1, 5, 7);
    expect(formatearHora24(d)).toBe('05:07');
  });
  it('devuelve — para fecha inválida', () => {
    expect(formatearHora24(null)).toBe('—');
    expect(formatearHora24(new Date('invalid'))).toBe('—');
  });
});

describe('formatearDeltaMinutos', () => {
  it('minutos simples', () => {
    expect(formatearDeltaMinutos(5)).toBe('5 min');
    expect(formatearDeltaMinutos(-5)).toBe('5 min');
  });
  it('horas y minutos', () => {
    expect(formatearDeltaMinutos(90)).toBe('1 h 30 min');
    expect(formatearDeltaMinutos(120)).toBe('2 h');
  });
});

describe('escapeHtml', () => {
  it('escapa caracteres peligrosos', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
  it('maneja null/undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('obtenerFechaHoyISO', () => {
  it('devuelve YYYY-MM-DD', () => {
    const d = new Date(2026, 10, 18);
    expect(obtenerFechaHoyISO(d)).toBe('2026-11-18');
  });
});
