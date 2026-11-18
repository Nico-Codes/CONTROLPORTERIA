import { describe, it, expect } from 'vitest';
import { registroCorrespondeARuta, rutaCompletada, evaluarEstadoRuta, obtenerMargenRegistro, obtenerToleranciaRegistro } from '../../src/domain/rondas.js';

describe('registroCorrespondeARuta', () => {
  it('solo cuenta registros OK', () => {
    const reg = { severidad: 'ADVERTENCIA', codigoQR: 'QR1', horarioProgramado: '10:00' };
    const ruta = { codigoQR: 'QR1', hora: '10:00' };
    expect(registroCorrespondeARuta(reg, ruta)).toBe(false);
  });

  it('coincide por rutaId cuando existe', () => {
    const reg = { severidad: 'OK', rutaId: 'r1', codigoQR: 'QR1', horarioProgramado: '10:00' };
    const ruta = { id: 'r1', codigoQR: 'QR1', hora: '10:00' };
    expect(registroCorrespondeARuta(reg, ruta)).toBe(true);
  });

  it('coincide por codigoQR + horario para registros antiguos', () => {
    const reg = { severidad: 'OK', codigoQR: 'QR1', horarioProgramado: '10:00' };
    const ruta = { id: 'r2', codigoQR: 'QR1', hora: '10:00' };
    expect(registroCorrespondeARuta(reg, ruta)).toBe(true);
  });

  it('no coincide si el horario difiere', () => {
    const reg = { severidad: 'OK', codigoQR: 'QR1', horarioProgramado: '10:00' };
    const ruta = { id: 'r2', codigoQR: 'QR1', hora: '11:00' };
    expect(registroCorrespondeARuta(reg, ruta)).toBe(false);
  });
});

describe('rutaCompletada', () => {
  it('true si algún registro OK corresponde', () => {
    const regs = [{ severidad: 'OK', rutaId: 'r1' }];
    expect(rutaCompletada(regs, { id: 'r1' })).toBe(true);
  });
  it('false si no hay registros', () => {
    expect(rutaCompletada([], { id: 'r1' })).toBe(false);
  });
});

describe('evaluarEstadoRuta', () => {
  it('completado si hay registro OK', () => {
    const ahora = new Date(2026, 10, 18, 10, 5);
    const ruta = { dia: 'Miércoles', hora: '10:00', margen: 15, codigoQR: 'QR1', id: 'r1' };
    const regs = [{ severidad: 'OK', rutaId: 'r1' }];
    const res = evaluarEstadoRuta(ruta, ahora, regs);
    expect(res.estadoAgenda).toBe('completado');
  });

  it('vencido si pasó el margen', () => {
    const ahora = new Date(2026, 10, 18, 10, 30);
    const ruta = { dia: 'Miércoles', hora: '10:00', margen: 15, codigoQR: 'QR1', id: 'r1' };
    const res = evaluarEstadoRuta(ruta, ahora, []);
    expect(res.estadoAgenda).toBe('vencido');
    expect(res.diffMin).toBe(30);
  });

  it('proximo si está dentro del margen', () => {
    const ahora = new Date(2026, 10, 18, 10, 5);
    const ruta = { dia: 'Miércoles', hora: '10:00', margen: 15, codigoQR: 'QR1', id: 'r1' };
    const res = evaluarEstadoRuta(ruta, ahora, []);
    expect(res.estadoAgenda).toBe('proximo');
  });

  it('pendiente si falta mucho', () => {
    const ahora = new Date(2026, 10, 18, 9, 0);
    const ruta = { dia: 'Miércoles', hora: '10:00', margen: 15, codigoQR: 'QR1', id: 'r1' };
    const res = evaluarEstadoRuta(ruta, ahora, []);
    expect(res.estadoAgenda).toBe('pendiente');
  });
});

describe('obtenerMargenRegistro', () => {
  it('usa el margen propio si existe', () => {
    expect(obtenerMargenRegistro({ margen: 20 }, [])).toBe(20);
  });
  it('busca en rutas si no existe', () => {
    const rutas = [{ id: 'r1', margen: 10 }];
    expect(obtenerMargenRegistro({ rutaId: 'r1' }, rutas)).toBe(10);
  });
  it('default 15 si no hay datos', () => {
    expect(obtenerMargenRegistro({}, [])).toBe(15);
  });
});

describe('obtenerToleranciaRegistro', () => {
  it('usa la tolerancia propia si existe', () => {
    expect(obtenerToleranciaRegistro({ tolerancia: 30 }, { tolerancia: 25 })).toBe(30);
  });
  it('usa la del punto si no existe', () => {
    expect(obtenerToleranciaRegistro({}, { tolerancia: 25 })).toBe(25);
  });
  it('default 25 si no hay datos', () => {
    expect(obtenerToleranciaRegistro({}, null)).toBe(25);
  });
});
