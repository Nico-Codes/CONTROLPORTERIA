# AGENTS.md

Guía para trabajar en este repositorio. El idioma del proyecto es **español**: nombres de funciones, variables, commits, comentarios y UI.

## Qué es

PWA estática de control de rondas de vigilancia (Meatex): escaneo de QR, validación GPS por distancia Haversine y ventanas horarias. Vanilla JS con ES modules, sin framework y sin paso de compilación para el código de `src/`; Firebase (Firestore y Messaging) se importa directo por URL desde el CDN de gstatic. Vite solo empaqueta.

- Frontend: `index.html` + `src/`
- Backend serverless de push: `api/push.js` (Vercel) y `push-sender/` (alternativa local/GitHub Actions)
- Persistencia: Firestore con reglas versionadas en `firestore.rules`
- Despliegue: Vercel sirve `dist/`; Firebase Hosting redirige a Vercel

## Comandos

```bash
npm install          # única vez
npm run dev          # Vite en http://localhost:5173
npm run build        # genera dist/
npm run preview      # sirve el build
npm test             # validación estática + contratos + unitarios
```

Verificación por partes:

```bash
node tests/validar-index.mjs    # IDs y handlers inline de index.html
node tests/validar-reglas.mjs   # contratos de reglas de negocio y firestore.rules
npx vitest run                  # tests/unit/**
```

**Antes de dar por terminado un cambio, correr `npm test`.** Si falla, arreglar la causa; no relajar la comprobación.

## Estructura

```
index.html              UI completa: markup + handlers inline (onclick="fn()")
src/main.js             Entrada y lógica de operador/encargado; Firebase por CDN
src/styles.css          Estilos propios
src/domain/rondas.js    Lógica de negocio pura (sin DOM ni Firebase)
src/utils/geo.js        Haversine y radio
src/utils/format.js     Formato de fechas, horas, iniciales, escapeHtml
public/                 Estáticos servidos en raíz (manifest, SW, iconos, 404)
api/push.js             Emisor de push serverless
push-sender/            Emisor alternativo de push para GitHub Actions
tools/generar_pdf.py    Generador de los PDF de documentación (Python + reportlab)
tests/unit/             Vitest (entorno node)
```

`src/supervisor.js` puede existir como archivo local sin seguimiento, pero no forma parte de la entrada actual y sus imports (`state.js`, `firebase.js`, `constants.js`, `ui.js`, `operator.js`) no están versionados. No asumir que el refactor está integrado.

Regla de oro: la lógica pura va a `src/domain/` o `src/utils/` y debe poder testearse sin DOM. Si una función toca DOM, Firestore o `window`, va en `main.js`/`operator.js`/`supervisor.js`.

## Convenciones de código

- **ES modules** con extensión explícita en el import (`./state.js`, no `./state`).
- **Funciones globales para el HTML**: los `onclick`/`onchange` del markup resuelven contra `window`, por eso los handlers se declaran como `function nombre()` y, si viven en un módulo, se exponen con `window.nombre = nombre;`. Si agregás un handler inline, tiene que quedar visible en `window` o moverlo a un `addEventListener`.
- **Firebase siempre por CDN fijo** (`https://www.gstatic.com/firebasejs/10.12.2/...`). No agregar `firebase` como dependencia del frontend; `firebase-admin` es solo para `api/` y `push-sender/`.
- **Tailwind por CDN con clases utilitarias en el HTML**; los estilos propios van en `src/styles.css`. La paleta se usa con hex literales (`text-[#047857]`, `bg-[#ECFDF5]`, etc.).
- **Indentación**: heredá la del archivo que editás. Los módulos nuevos en `src/` usan 4 espacios; los archivos heredados de `index.html` (incluido `supervisor.js`) conservan 8. Los tests usan 2.
- **Comentarios en español**, breves y solo para explicar el porqué.
- **Sin dependencias nuevas** salvo que sean imprescindibles y estén justificadas; el proyecto se mantiene deliberadamente sin framework.
- **No usar `innerHTML` con datos de usuario** sin pasar por `escapeHtml()`.

## Reglas de negocio que no se deben romper

Están congeladas en `tests/validar-reglas.mjs`; si cambiás una, actualizá el contrato y el README.

- Cada punto se identifica por el texto exacto de su QR.
- **Cada horario programado exige su propio escaneo válido**; uno no completa los demás.
- Severidades: `OK`, `ADVERTENCIA` (fuera de horario), `CRITICO` (fuera de rango GPS o punto no programado). Un QR desconocido se muestra crítico y **no se persiste**.
- Ruta aplicable si su día coincide con hoy o si es `"Todos"`.
- Límites: 20 puntos, 30 operadores, 2.000 registros por carga del panel, 10.000 en exportación.
- Retención de 60 días: los registros guardan `expiraEn` y la app borra en lotes al cargar (máx. 2.000 por carga).
- Operadores: desactivar los oculta; eliminar conserva el historial.

## Tests

- `vitest` con `environment: 'node'` e `include: ['tests/unit/**/*.test.js']` (ver `vitest.config.mjs`).
- Importar el módulo bajo prueba con ruta relativa (`../../src/utils/format.js`).
- Nombres de `describe`/`it` en español, describiendo el comportamiento esperado.
- `validar-index.mjs` y `validar-reglas.mjs` son scripts sin dependencias que leen el código como texto y buscan patrones. Leen `index.html` y **todos los `.js` de `src/` de forma recursiva**, así que mover handlers, IDs o constantes entre módulos no requiere tocar los validadores. Solo hay que agregar rutas nuevas si el código sale de `src/`.
- Un handler inline del HTML debe estar visible en `window` (o declarado como `function` en algún módulo de `src/`) para que `validar-index.mjs` lo acepte.

## Commits y despliegue

- Mensajes en español, descriptivos y en presente/imperativo ("Corrige…", "Agrega…"). Durante una refactorización se usa el prefijo de fase: `Fase 3: extrae …`.
- Un commit por cambio coherente; no mezclar refactor con features.
- Reglas de Firestore: `firebase deploy --only firestore:rules`.
- Hosting de Firebase solo redirige a Vercel; el sitio real se despliega en Vercel con `npm run build`.

## Limitaciones conocidas

- Sin Firebase Auth: la clave del encargado (`admin123`) está en `src/main.js` y las reglas de Firestore son abiertas. Endurecerlas requiere autenticación.
- El Service Worker cachea la navegación y recursos del mismo origen, pero no las importaciones Firebase de `gstatic.com`; no se garantiza arrancar en frío sin red. Los escaneos pueden encolarse en `localStorage` si la app ya está cargada y tiene sus catálogos disponibles.
- Sin pipeline de CI para el frontend (solo existe `.github/workflows/push-sender.yml`).
- TTL de Firestore no disponible (facturación deshabilitada); por eso la limpieza es en la app.
