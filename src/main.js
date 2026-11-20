import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
        import { getFirestore, collection, addDoc, setDoc, getDocs, deleteDoc, updateDoc, doc, query, where, orderBy, limit, onSnapshot, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
        import { getMessaging, getToken, onMessage, isSupported as isMessagingSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { calcularDistanciaMetros, estaDentroDeRadio } from "./utils/geo.js";
import { obtenerIniciales, formatearHora24, formatearDeltaMinutos, escapeHtml, obtenerFechaHoyISO } from "./utils/format.js";
import { registroCorrespondeARuta, rutaCompletada, evaluarEstadoRuta, obtenerMargenRegistro, obtenerToleranciaRegistro } from "./domain/rondas.js";

        const firebaseConfig = {
            apiKey: "AIzaSyAl9AqfZzwojhuB_7QPFS0kfMbw5dfdI-4",
            authDomain: "control-rondas-porteria-7ecc7.firebaseapp.com",
            projectId: "control-rondas-porteria-7ecc7",
            storageBucket: "control-rondas-porteria-7ecc7.firebasestorage.app",
            messagingSenderId: "873679139344",
            appId: "1:873679139344:web:cdf54b69a8eb7582959095"
        };

        const DIAS_SEMANA = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
        const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
        const PASSWORD_ENCARGADO = "admin123";

        // Límites operativos y de retención
        const MAX_OPERADORES = 30;
        const MAX_PUNTOS = 20;
        const DIAS_RETENCION = 60;
        const RETENCION_MS = DIAS_RETENCION * 24 * 60 * 60 * 1000;
        const LIMITE_REGISTROS_DIA = 2000;
        const LIMITE_EXPORTACION = 10000;

        // Clave VAPID de Web Push. Si se deja vacía se mantiene el comportamiento actual.
        const VAPID_KEY = "";

        const app = initializeApp(firebaseConfig);
        const db = getFirestore(app);

        let swRegistration = null;
        let fcmMessaging = null;
        let unsubscribeIncidenciasSupervisor = null;
        let fcmTokenActual = localStorage.getItem('fcm_token_guardado') || null;

        let operadorActivo = localStorage.getItem('operador_seleccionado') || "";
        let operadorPreseleccionadoSheet = operadorActivo;
        let html5QrCode = null;
        let linternaActiva = false;
        let ultimaPrecisionGPS = null;
        let puntosCache = {};
        let rutasCache = [];
        let registrosCache = [];          // Registros de HOY (vista operador y motor de alertas)
        let registrosAdminCache = [];      // Registros del día seleccionado en el panel
        let operadoresCache = [];
        let qrActualTexto = "", qrActualNombre = "", qrActualDataUrl = "";
        let diasSeleccionadosForm = [];
        let turnoOpSeleccionado = "Mañana";
        let filtroEstadoActual = "todos";
        let offsetDiasFiltro = 0;
        let timerAutocierreAlerta = null;
        let timerAvisoPanel = null;
        let escaneoEnProceso = false;
        let mapaPuntosRutas = null;
        let capaPuntosRutas = null;
        let codigosMapaRutaPendientes = new Set();
        let mapaPuntos = null;
        let capaPuntos = null;

        function generarCodigoPuntoUnico() {
            let codigo;
            do {
                codigo = "QR-" + Math.random().toString(36).substring(2, 8).toUpperCase();
            } while (puntosCache[codigo]);
            return codigo;
        }

        function existePuntoConNombre(nombre, codigoExcluir = "") {
            const buscado = String(nombre || '').trim().toLowerCase();
            return Object.values(puntosCache).some(p => p.codigo !== codigoExcluir && String(p.nombre || '').trim().toLowerCase() === buscado);
        }

        function mostrarAvisoPanel(texto, tipo = "ok") {
            const el = document.getElementById('aviso-panel');
            if (!el) return;
            const estilos = {
                ok: 'border-[#059669]/30 bg-[#ECFDF5] text-[#047857]',
                warn: 'border-[#D97706]/30 bg-[#FFFBEB] text-[#92400E]',
                error: 'border-[#DC2626]/30 bg-[#FEF2F2] text-[#B91C1C]'
            };
            el.textContent = texto;
            el.className = `rounded-lg border px-4 py-3 text-sm font-medium ${estilos[tipo] || estilos.ok}`;
            if (timerAvisoPanel) clearTimeout(timerAvisoPanel);
            timerAvisoPanel = setTimeout(() => el.classList.add('hidden'), 6000);
        }

        function mostrarMensajeForm(id, texto, tipo = "ok") {
            const el = document.getElementById(id);
            if (!el) return mostrarAvisoPanel(texto, tipo);
            const estilos = {
                ok: 'text-[#047857]',
                warn: 'text-[#92400E]',
                error: 'text-[#B91C1C]'
            };
            el.textContent = texto;
            el.className = `text-[11px] font-medium leading-snug ${estilos[tipo] || estilos.ok}`;
            setTimeout(() => el.classList.add('hidden'), 5000);
        }

        function formatearHoraDeMs(ms) {
            if (!ms) return "—";
            return formatearHora24(new Date(ms));
        }

        window.addEventListener('online', () => {
            actualizarEstadoRed();
            sincronizarColaOffline();
        });
        window.addEventListener('offline', actualizarEstadoRed);

        window.addEventListener('DOMContentLoaded', async () => {
            actualizarRelojYFechaHeader();
            setInterval(actualizarRelojYFechaHeader, 15000);
            actualizarEstadoRed();
            iniciarMonitorGPSHeader();
            await inicializarServiceWorkerYNotificaciones();

            actualizarInterfazSegunRol();
            
            await Promise.all([
                cargarOperadores(),
                cargarPuntos(),
                cargarRutas(),
                cargarRegistrosHoy()
            ]);
            await sincronizarColaOffline();
            // Limpieza silenciosa de registros con más de 60 días.
            limpiarRegistrosAntiguos();

            if (sessionStorage.getItem('sesion_encargado') === 'activa') {
                await cargarDatosPanelAdmin();
                renderizarTodoAdmin();
            }

            document.getElementById('op-skeleton').classList.add('hidden');
            document.getElementById('op-contenido').classList.remove('hidden');

            refrescarVistaOperador();
            iniciarMotorAlertasOperador();
        });

        function refrescarVistaOperador() {
            renderizarProgresoYProximoOperador();
            renderizarAgendaOperador();
            renderizarRecientesOperador();
        }

        function iniciarMonitorGPSHeader() {
            if (!navigator.geolocation) {
                actualizarPastillaGPS('error', null);
                return;
            }
            navigator.geolocation.watchPosition(
                (pos) => {
                    ultimaPrecisionGPS = Math.round(pos.coords.accuracy);
                    actualizarPastillaGPS('ok', ultimaPrecisionGPS);
                },
                () => {
                    actualizarPastillaGPS('error', null);
                },
                { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
            );
        }

        function actualizarPastillaGPS(estado, precision) {
            const dot = document.getElementById('pill-gps-dot');
            const txt = document.getElementById('pill-gps-text');
            const escIcon = document.getElementById('escaner-gps-icon');
            const escTxt = document.getElementById('escaner-gps-texto');

            if (estado === 'ok') {
                const prec = precision !== null && !isNaN(precision) ? `±${precision}m` : 'OK';
                if (dot) dot.className = "w-1.5 h-1.5 rounded-full bg-[#059669] shrink-0";
                if (txt) txt.textContent = `GPS ${prec}`;
                if (escIcon) escIcon.className = "fa-solid fa-location-dot text-[#34D399]";
                if (escTxt) escTxt.textContent = `Ubicación lista · ${prec}`;
            } else if (estado === 'buscando') {
                if (dot) dot.className = "w-1.5 h-1.5 rounded-full bg-[#D97706] animate-pulse shrink-0";
                if (txt) txt.textContent = "GPS…";
                if (escIcon) escIcon.className = "fa-solid fa-location-dot text-[#FBBF24] animate-pulse";
                if (escTxt) escTxt.textContent = "Buscando ubicación…";
            } else {
                if (dot) dot.className = "w-1.5 h-1.5 rounded-full bg-[#DC2626] shrink-0";
                if (txt) txt.textContent = "Sin GPS";
                if (escIcon) escIcon.className = "fa-solid fa-location-dot text-[#F87171]";
                if (escTxt) escTxt.textContent = "Sin señal GPS";
            }
        }

        window.abrirSelectorOperador = () => {
            const activos = operadoresCache.filter(op => op.activo !== false);
            if (!operadorPreseleccionadoSheet || !activos.some(op => op.nombre === operadorPreseleccionadoSheet)) {
                operadorPreseleccionadoSheet = activos.length > 0 ? activos[0].nombre : "";
            }
            document.getElementById('input-buscar-operador').value = '';
            renderizarListaOperadoresSheet();
            actualizarBotonConfirmarOperador();

            document.getElementById('sheet-operador-overlay').classList.remove('hidden');
            requestAnimationFrame(() => {
                document.getElementById('sheet-operador').classList.remove('translate-y-full');
            });
        };

        window.cerrarSelectorOperador = () => {
            document.getElementById('sheet-operador').classList.add('translate-y-full');
            setTimeout(() => {
                document.getElementById('sheet-operador-overlay').classList.add('hidden');
            }, 250);
        };

        window.filtrarListaOperadoresSheet = () => {
            renderizarListaOperadoresSheet();
        };

        function obtenerUltimoEscaneoOperador(nombreOp, registros = registrosCache) {
            const reg = registros.find(r => r.operador === nombreOp);
            if (!reg) return "sin escaneos";
            if (reg.timestampMs) {
                return `último escaneo ${formatearHora24(new Date(reg.timestampMs))}`;
            }
            if (reg.fechaTexto && reg.fechaTexto.includes(' ')) {
                return `último escaneo ${reg.fechaTexto.split(' ')[1]}`;
            }
            return "sin escaneos";
        }

        function renderizarListaOperadoresSheet() {
            const contenedor = document.getElementById('lista-operadores-sheet');
            const filtro = (document.getElementById('input-buscar-operador').value || '').toLowerCase().trim();
            const activos = operadoresCache.filter(op => op.activo !== false && (op.nombre || '').toLowerCase().includes(filtro));

            contenedor.innerHTML = '';
            if (activos.length === 0) {
                contenedor.innerHTML = `<div class="py-8 px-4 text-center text-[13px] text-[#64748B]">No se encontró ese nombre.</div>`;
                return;
            }

            activos.forEach(op => {
                const seleccionado = op.nombre === operadorPreseleccionadoSheet;
                const iniciales = escapeHtml(obtenerIniciales(op.nombre));
                const turno = escapeHtml((op.turno || "Mañana").toLowerCase());
                const ultEsc = obtenerUltimoEscaneoOperador(op.nombre);

                const fila = document.createElement('button');
                fila.type = 'button';
                fila.onclick = () => {
                    operadorPreseleccionadoSheet = op.nombre;
                    renderizarListaOperadoresSheet();
                    actualizarBotonConfirmarOperador();
                };
                fila.className = "w-full min-h-[64px] px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-[#F8FAFC] active:bg-[#F1F5F9] transition";
                fila.innerHTML = `
                    <div class="flex items-center gap-3 min-w-0">
                        <div class="w-10 h-10 rounded-full ${seleccionado ? 'bg-[#0F172A] text-white' : 'bg-[#F1F5F9] text-[#0F172A]'} font-semibold text-[13px] flex items-center justify-center shrink-0 transition-colors">
                            ${iniciales}
                        </div>
                        <div class="min-w-0">
                            <p class="text-[15px] font-medium text-[#0F172A] truncate">${escapeHtml(op.nombre)}</p>
                            <p class="text-[12px] text-[#64748B] truncate">Turno ${turno} · <span class="font-mono-val">${ultEsc}</span></p>
                        </div>
                    </div>
                    <div class="w-5 h-5 rounded-full ${seleccionado ? 'bg-[#0F172A] text-white' : 'border-[1.5px] border-[#CBD5E1] bg-white'} flex items-center justify-center shrink-0">
                        ${seleccionado ? '<i class="fa-solid fa-check text-[10px]"></i>' : ''}
                    </div>
                `;
                contenedor.appendChild(fila);
            });
        }

        function actualizarBotonConfirmarOperador() {
            const btn = document.getElementById('btn-confirmar-operador');
            const txt = document.getElementById('btn-confirmar-operador-txt');
            if (operadorPreseleccionadoSheet) {
                btn.disabled = false;
                txt.textContent = `Abrir cámara como ${operadorPreseleccionadoSheet}`;
            } else {
                btn.disabled = true;
                txt.textContent = "Seleccioná un operador";
            }
        }

        window.confirmarOperadorYAbrirCamara = () => {
            if (!operadorPreseleccionadoSheet) return;
            operadorActivo = operadorPreseleccionadoSheet;
            localStorage.setItem('operador_seleccionado', operadorActivo);
            if ("Notification" in window && Notification.permission === "granted") {
                registrarTokenFCM('operador');
            }
            cerrarSelectorOperador();
            setTimeout(() => {
                iniciarCamara();
            }, 180);
        };

        window.cambiarOperadorDesdeEscaner = () => {
            detenerCamara();
            abrirSelectorOperador();
        };

        function evaluarEstadoRutasHoy() {
            const ahora = new Date();
            const hoyISO = obtenerFechaHoyISO();
            const hoyNombre = DIAS_SEMANA[ahora.getDay()];
            const regsHoy = registrosCache.filter(r => r.fechaISO === hoyISO);

            const rutasHoy = rutasCache
                .filter(r => r.dia === hoyNombre || r.dia === "Todos")
                .map(r => {
                    const [hh, mm] = (r.hora || "00:00").split(':').map(Number);
                    const fechaObj = new Date(ahora);
                    fechaObj.setHours(isNaN(hh) ? 0 : hh, isNaN(mm) ? 0 : mm, 0, 0);
                    const margen = Number(r.margen) || 15;
                    const diffMin = Math.round((ahora.getTime() - fechaObj.getTime()) / 60000);

                    const regOk = regsHoy.find(reg => registroCorrespondeARuta(reg, r));

                    let estadoAgenda = "pendiente";
                    if (regOk) {
                        estadoAgenda = "completado";
                    } else if (diffMin > margen) {
                        estadoAgenda = "vencido";
                    } else if (Math.abs(diffMin) <= margen) {
                        estadoAgenda = "proximo";
                    }

                    return {
                        ...r,
                        margen,
                        fechaObj,
                        minutosDia: (isNaN(hh) ? 0 : hh) * 60 + (isNaN(mm) ? 0 : mm),
                        diffMin,
                        regOk,
                        estadoAgenda
                    };
                })
                .sort((a, b) => a.minutosDia - b.minutosDia);

            return rutasHoy;
        }

        function renderizarProgresoYProximoOperador() {
            const rutas = evaluarEstadoRutasHoy();
            const total = rutas.length;
            const completadas = rutas.filter(r => r.estadoAgenda === "completado").length;
            const vencidas = rutas.filter(r => r.estadoAgenda === "vencido").length;
            const pendientes = Math.max(0, total - completadas - vencidas);

            document.getElementById('prog-completadas-num').textContent = completadas;
            document.getElementById('prog-total-num').textContent = total;
            document.getElementById('prog-txt-ok').textContent = `${completadas} ${completadas === 1 ? 'completada' : 'completadas'}`;
            document.getElementById('prog-txt-venc').textContent = `${vencidas} ${vencidas === 1 ? 'vencida' : 'vencidas'}`;
            document.getElementById('prog-txt-pend').textContent = `${pendientes} ${pendientes === 1 ? 'pendiente' : 'pendientes'}`;

            const pctOk = total > 0 ? Math.round((completadas / total) * 100) : 0;
            const pctVenc = total > 0 ? Math.round((vencidas / total) * 100) : 0;
            document.getElementById('prog-bar-ok').style.width = `${pctOk}%`;
            document.getElementById('prog-bar-venc').style.width = `${pctVenc}%`;

            const prox = rutas.find(r => r.estadoAgenda === "proximo") || rutas.find(r => r.estadoAgenda === "pendiente");
            const badgeEl = document.getElementById('prox-badge');
            const nombreEl = document.getElementById('prox-nombre');
            const codEl = document.getElementById('prox-codigo');
            const horaEl = document.getElementById('prox-hora');
            const margenEl = document.getElementById('prox-margen');
            const radioEl = document.getElementById('prox-radio');

            if (!prox) {
                badgeEl.className = "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-white/10 text-white/80";
                badgeEl.innerHTML = total > 0 ? "Turno al día" : "Sin agenda";
                nombreEl.textContent = total > 0 ? "Todos los puntos cubiertos" : "Sin puntos programados hoy";
                codEl.textContent = "—";
                horaEl.textContent = "—";
                margenEl.textContent = "";
                radioEl.textContent = "radio 25m";
                return;
            }

            const ptInfo = puntosCache[prox.codigoQR] || {};
            const enMargen = Math.abs(prox.diffMin) <= prox.margen;

            if (enMargen) {
                badgeEl.className = "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-[#059669]/15 text-[#6EE7B7]";
                badgeEl.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-[#6EE7B7] animate-pulse"></span> Ahora`;
            } else {
                const falta = Math.max(1, -prox.diffMin);
                badgeEl.className = "inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-mono-val font-medium bg-white/10 text-white/85";
                badgeEl.textContent = `en ${formatearDeltaMinutos(falta)}`;
            }

            nombreEl.textContent = prox.puntoNombre || ptInfo.nombre || "Punto de control";
            codEl.textContent = prox.codigoQR || "—";
            horaEl.textContent = prox.hora || "—";
            margenEl.textContent = `±${prox.margen} min`;
            radioEl.textContent = `radio ${ptInfo.tolerancia || 25}m`;
        }

        function renderizarAgendaOperador() {
            const rutasHoy = evaluarEstadoRutasHoy();
            document.getElementById('contador-ruta-hoy').textContent = `${rutasHoy.length} ${rutasHoy.length === 1 ? 'punto' : 'puntos'}`;

            const contenedor = document.getElementById('lista-ruta-hoy');
            contenedor.innerHTML = '';

            if (rutasHoy.length === 0) {
                contenedor.innerHTML = '<div class="py-8 px-4 text-center text-[13px] text-[#64748B]">Sin puntos programados para hoy.</div>';
                return;
            }

            rutasHoy.forEach(ruta => {
                let rowClass = "min-h-[64px] px-4 py-3 flex items-center justify-between gap-3";
                let nombreClass = "text-[15px] font-medium text-[#0F172A] truncate";
                let subHtml = "";
                let iconoDerHtml = "";

                if (ruta.estadoAgenda === "completado") {
                    nombreClass = "text-[15px] font-medium text-[#64748B] truncate";
                    const horaEsc = ruta.regOk.timestampMs
                        ? formatearHora24(new Date(ruta.regOk.timestampMs))
                        : (ruta.regOk.fechaTexto ? ruta.regOk.fechaTexto.split(' ')[1] : "—");
                    const dist = ruta.regOk.distancia !== undefined ? ruta.regOk.distancia : ruta.regOk.gpsDist;
                    const distTxt = (dist !== undefined && dist !== null && !isNaN(dist)) ? ` · ${dist} m` : "";
                    subHtml = `<p class="text-[12px] text-[#047857] font-mono-val truncate">Escaneado ${horaEsc}${distTxt}</p>`;
                    iconoDerHtml = `<div class="w-7 h-7 rounded-full bg-[#ECFDF5] text-[#059669] flex items-center justify-center shrink-0"><i class="fa-solid fa-check text-xs"></i></div>`;
                } else if (ruta.estadoAgenda === "vencido") {
                    subHtml = `<p class="text-[12px] text-[#B91C1C] truncate">Vencido · sin escanear</p>`;
                    iconoDerHtml = `<div class="w-7 h-7 rounded-full bg-[#FEF2F2] text-[#DC2626] flex items-center justify-center shrink-0"><i class="fa-solid fa-triangle-exclamation text-xs"></i></div>`;
                } else if (ruta.estadoAgenda === "proximo" && Math.abs(ruta.diffMin) <= ruta.margen) {
                    rowClass += " bg-[#F8FAFC] border-l-[3px] border-l-[#0F172A]";
                    subHtml = `<p class="text-[12px] text-[#334155] font-medium truncate">Dentro del horario · escaneá ahora</p>`;
                    iconoDerHtml = `<div class="w-7 h-7 rounded-full border-[1.5px] border-[#0F172A] flex items-center justify-center shrink-0"><span class="w-2 h-2 rounded-full bg-[#0F172A]"></span></div>`;
                } else {
                    const falta = Math.max(1, -ruta.diffMin);
                    const esProx = ruta.estadoAgenda === "proximo";
                    subHtml = `<p class="text-[12px] text-[#64748B] truncate">Pendiente · en ${formatearDeltaMinutos(falta)}</p>`;
                    iconoDerHtml = esProx
                        ? `<div class="w-7 h-7 rounded-full border-[1.5px] border-[#0F172A] flex items-center justify-center shrink-0"><span class="w-2 h-2 rounded-full bg-[#0F172A]"></span></div>`
                        : `<div class="w-7 h-7 rounded-full border-[1.5px] border-[#CBD5E1] shrink-0"></div>`;
                }

                contenedor.innerHTML += `
                    <div class="${rowClass}">
                        <div class="w-[52px] shrink-0">
                            <span class="block text-[15px] font-mono-val font-medium text-[#0F172A] leading-tight">${escapeHtml(ruta.hora || "—")}</span>
                            <span class="block text-[11px] font-mono-val text-[#94A3B8]">±${ruta.margen}′</span>
                        </div>
                        <div class="flex-1 min-w-0">
                            <p class="${nombreClass}">${escapeHtml(ruta.puntoNombre || "Punto")}</p>
                            ${subHtml}
                        </div>
                        ${iconoDerHtml}
                    </div>
                `;
            });
        }

        function obtenerMotivoCortoCritico(estado) {
            const e = (estado || "").toLowerCase();
            if (e.includes("rango") || e.includes("gps")) return "Fuera de rango";
            if (e.includes("programado")) return "No programado";
            if (e.includes("desconocido") || e.includes("registrado")) return "QR desconocido";
            return "Crítico";
        }

        function renderizarRecientesOperador() {
            const contenedor = document.getElementById('lista-recientes');
            contenedor.innerHTML = '';
            const rec = registrosCache.slice(0, 6);

            if (rec.length === 0) {
                contenedor.innerHTML = '<div class="py-8 px-4 text-center text-[13px] text-[#64748B]">Sin registros recientes.</div>';
                return;
            }

            rec.forEach(r => {
                const horaTxt = r.timestampMs
                    ? formatearHora24(new Date(r.timestampMs))
                    : (r.fechaTexto && r.fechaTexto.includes(' ') ? r.fechaTexto.split(' ')[1] : "—");
                const opNombre = r.operador || "Operador";
                const iniciales = obtenerIniciales(opNombre);
                let badgeHtml = '';
                if (r.severidad === 'OK') {
                    badgeHtml = `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-[6px] text-[11px] font-medium bg-[#ECFDF5] text-[#047857] ring-1 ring-inset ring-[#059669]/20 shrink-0"><i class="fa-solid fa-circle-check text-[9px]"></i> Válido</span>`;
                } else if (r.severidad === 'ADVERTENCIA') {
                    badgeHtml = `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-[6px] text-[11px] font-medium bg-[#FFFBEB] text-[#92400E] ring-1 ring-inset ring-[#D97706]/25 shrink-0"><i class="fa-solid fa-clock text-[9px]"></i> Fuera de horario</span>`;
                } else {
                    const motivo = obtenerMotivoCortoCritico(r.estado);
                    badgeHtml = `<span class="inline-flex items-center gap-1 px-2 py-1 rounded-[6px] text-[11px] font-medium bg-[#FEF2F2] text-[#B91C1C] ring-1 ring-inset ring-[#DC2626]/20 shrink-0"><i class="fa-solid fa-triangle-exclamation text-[9px]"></i> ${motivo}</span>`;
                }

                contenedor.innerHTML += `
                    <div class="px-4 py-3 flex items-center justify-between gap-3">
                        <div class="flex items-center gap-3 min-w-0">
                            <div class="w-9 h-9 rounded-full bg-[#F1F5F9] text-[#0F172A] font-semibold text-[12px] flex items-center justify-center shrink-0">
                                ${escapeHtml(iniciales)}
                            </div>
                            <div class="min-w-0">
                                <p class="text-[14px] font-medium text-[#0F172A] truncate">${escapeHtml(r.puntoNombre || "Punto QR")}</p>
                                <p class="text-[12px] text-[#64748B] truncate">${escapeHtml(opNombre)} · <span class="font-mono-val">${horaTxt}</span></p>
                            </div>
                        </div>
                        ${badgeHtml}
                    </div>
                `;
            });
        }

        window.iniciarCamara = () => {
            if (!operadorActivo) {
                abrirSelectorOperador();
                return;
            }

            document.getElementById('chip-op-iniciales').textContent = obtenerIniciales(operadorActivo);
            document.getElementById('chip-op-nombre').textContent = operadorActivo;
            document.getElementById('caja-camara').classList.remove('hidden');

            document.querySelectorAll('.esquina-qr').forEach(el => {
                el.classList.remove('border-[#34D399]');
                el.classList.add('border-white');
            });

            html5QrCode = new Html5Qrcode("reader");
            html5QrCode.start(
                { facingMode: "environment" },
                {
                    fps: 15,
                    qrbox: (viewfinderWidth, viewfinderHeight) => {
                        const size = Math.min(240, Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.7));
                        return { width: size, height: size };
                    },
                    aspectRatio: window.innerHeight / window.innerWidth
                },
                onScanSuccess
            ).then(() => {
                verificarSoporteLinterna();
            }).catch(() => {
                detenerCamara();
                mostrarSheetPermiso('camara');
            });
        };

        function verificarSoporteLinterna() {
            const btn = document.getElementById('btn-linterna');
            linternaActiva = false;
            btn.className = "invisible w-[44px] h-[44px] rounded-full bg-white/15 active:scale-[0.98] text-white flex items-center justify-center backdrop-blur-xs transition";
            try {
                const caps = html5QrCode.getRunningTrackCameraCapabilities();
                if (caps && caps.torchFeature && caps.torchFeature().isSupported()) {
                    btn.classList.remove('invisible');
                }
            } catch (e) {}
        }

        window.toggleLinterna = async () => {
            if (!html5QrCode) return;
            try {
                const caps = html5QrCode.getRunningTrackCameraCapabilities();
                if (caps && caps.torchFeature && caps.torchFeature().isSupported()) {
                    linternaActiva = !linternaActiva;
                    await caps.torchFeature().apply(linternaActiva);
                    const btn = document.getElementById('btn-linterna');
                    if (linternaActiva) {
                        btn.className = "w-[44px] h-[44px] rounded-full bg-white text-[#0F172A] active:scale-[0.98] flex items-center justify-center transition";
                    } else {
                        btn.className = "w-[44px] h-[44px] rounded-full bg-white/15 text-white active:scale-[0.98] flex items-center justify-center backdrop-blur-xs transition";
                    }
                }
            } catch (e) {}
        };

        window.detenerCamara = () => {
            linternaActiva = false;
            if (html5QrCode) {
                try {
                    if (html5QrCode.isScanning) {
                        html5QrCode.stop().then(() => html5QrCode.clear()).catch(() => {});
                    }
                } catch (e) {}
            }
            document.getElementById('caja-camara').classList.add('hidden');
        };

        function mostrarPantallaValidando() {
            ['qr', 'gps', 'hora'].forEach(step => {
                const el = document.getElementById(`val-step-${step}`);
                el.className = "w-5 h-5 rounded-full border-2 border-[#CBD5E1] flex items-center justify-center text-xs";
                el.innerHTML = "";
            });
            document.getElementById('pantalla-validando').classList.remove('hidden');
            setTimeout(() => marcarPasoValidando('qr'), 150);
        }

        function marcarPasoValidando(step) {
            const el = document.getElementById(`val-step-${step}`);
            if (!el) return;
            el.className = "w-5 h-5 rounded-full bg-[#ECFDF5] text-[#059669] flex items-center justify-center text-xs";
            el.innerHTML = '<i class="fa-solid fa-check text-[10px]"></i>';
        }

        function ocultarPantallaValidando() {
            document.getElementById('pantalla-validando').classList.add('hidden');
        }

        async function onScanSuccess(codigoLeido) {
            // Evita registros duplicados si el lector dispara el callback más de una vez.
            if (escaneoEnProceso) return;
            escaneoEnProceso = true;

            document.querySelectorAll('.esquina-qr').forEach(el => {
                el.classList.remove('border-white');
                el.classList.add('border-[#34D399]');
            });
            if (navigator.vibrate) navigator.vibrate(60);

            await new Promise(res => setTimeout(res, 300));
            detenerCamara();

            const inicioValMs = Date.now();
            mostrarPantallaValidando();

            const punto = puntosCache[codigoLeido];
            if (!punto) {
                const restante = Math.max(0, 600 - (Date.now() - inicioValMs));
                setTimeout(() => {
                    ocultarPantallaValidando();
                    mostrarAlertaPantallaCompleta({
                        severidad: "CRITICO",
                        motivoCritico: "qr_desconocido",
                        puntoNombre: "QR no reconocido",
                        codigoQR: codigoLeido,
                        horaStr: formatearHora24(new Date()),
                        operador: operadorActivo,
                        qrValido: false,
                        progHoy: null,
                        distancia: null,
                        tolerancia: null,
                        desvioMin: null,
                        margen: null
                    });
                    escaneoEnProceso = false;
                }, restante);
                return;
            }

            if (!navigator.geolocation) {
                ocultarPantallaValidando();
                mostrarSheetPermiso('gps');
                escaneoEnProceso = false;
                return;
            }

            navigator.geolocation.getCurrentPosition(async (pos) => {
                marcarPasoValidando('gps');

                const distancia = calcularDistanciaMetros(punto.lat, punto.lng, pos.coords.latitude, pos.coords.longitude);
                const tolerancia = punto.tolerancia || 25;
                const gpsValido = distancia <= tolerancia;
                const ahora = new Date();
                const hoyNombre = DIAS_SEMANA[ahora.getDay()];
                const rutasPunto = rutasCache.filter(r => (r.dia === hoyNombre || r.dia === "Todos") && r.codigoQR === codigoLeido);

                let estado = "Válido", severidad = "OK", motivoCritico = "";
                let mejor = null;
                let desvioMin = null;
                let margen = 15;
                let menorDiff = Infinity;

                if (rutasPunto.length === 0) {
                    estado = "QR no programado hoy";
                    severidad = "CRITICO";
                    motivoCritico = "no_programado";
                } else {
                    const hoyISO = obtenerFechaHoyISO();
                    const regsHoy = registrosCache.filter(r => r.fechaISO === hoyISO);
                    const pendientes = rutasPunto.filter(r => !rutaCompletada(regsHoy, r));
                    const candidatas = pendientes.length > 0 ? pendientes : rutasPunto;

                    // Prioriza la ruta pendiente más temprana que esté dentro de su margen.
                    // Así, si un punto tiene varios horarios el mismo día, cada escaneo
                    // completa una ruta distinta y no se repite siempre la más cercana.
                    let dentroDeMargen = null;
                    candidatas.forEach(r => {
                        const [hh, mm] = (r.hora || "00:00").split(':').map(Number);
                        const obj = new Date(ahora);
                        obj.setHours(isNaN(hh) ? 0 : hh, isNaN(mm) ? 0 : mm, 0, 0);
                        const diffMin = Math.round((ahora.getTime() - obj.getTime()) / 60000);
                        const margenRuta = Number(r.margen) || 15;
                        if (Math.abs(diffMin) <= margenRuta) {
                            if (!dentroDeMargen || obj.getTime() < dentroDeMargen.obj.getTime()) {
                                dentroDeMargen = { ruta: r, obj, diffMin, margen: margenRuta };
                            }
                        }
                    });

                    if (dentroDeMargen) {
                        mejor = dentroDeMargen.ruta;
                        desvioMin = dentroDeMargen.diffMin;
                        margen = dentroDeMargen.margen;
                        menorDiff = Math.abs(desvioMin) * 60000;
                    } else {
                        candidatas.forEach(r => {
                            const [hh, mm] = (r.hora || "00:00").split(':').map(Number);
                            const obj = new Date(ahora);
                            obj.setHours(isNaN(hh) ? 0 : hh, isNaN(mm) ? 0 : mm, 0, 0);
                            const diff = Math.abs(ahora.getTime() - obj.getTime());
                            if (diff < menorDiff) {
                                menorDiff = diff;
                                mejor = r;
                                desvioMin = Math.round((ahora.getTime() - obj.getTime()) / 60000);
                            }
                        });
                        margen = mejor ? (Number(mejor.margen) || 15) : 15;
                    }

                    if (!gpsValido) {
                        estado = "Fuera de rango GPS";
                        severidad = "CRITICO";
                        motivoCritico = "fuera_rango";
                    } else if (!dentroDeMargen) {
                        estado = "Fuera de horario";
                        severidad = "ADVERTENCIA";
                    }
                }

                marcarPasoValidando('hora');

                const hora24 = formatearHora24(ahora);
                const nuevoReg = {
                    operador: operadorActivo,
                    puntoNombre: punto.nombre,
                    codigoQR: codigoLeido,
                    rutaId: mejor && mejor.id ? mejor.id : null,
                    diaRuta: mejor ? mejor.dia : null,
                    fechaTexto: `${ahora.toLocaleDateString('es-AR')} ${hora24}`,
                    fechaISO: `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`,
                    timestampMs: ahora.getTime(),
                    horarioProgramado: mejor ? mejor.hora : "Sin agenda",
                    margen: mejor ? margen : null,
                    tolerancia: tolerancia,
                    latReal: pos.coords.latitude,
                    lngReal: pos.coords.longitude,
                    distancia,
                    gpsDist: distancia,
                    estado,
                    severidad,
                    creadoEn: new Date(ahora.getTime()),
                    expiraEn: new Date(ahora.getTime() + RETENCION_MS)
                };

                try {
                    if (!navigator.onLine) throw new Error();
                    await addDoc(collection(db, "registros_ronda"), nuevoReg);
                } catch (e) {
                    const cola = JSON.parse(localStorage.getItem('cola_rondas_offline') || '[]');
                    cola.push(nuevoReg);
                    localStorage.setItem('cola_rondas_offline', JSON.stringify(cola));
                }

                await cargarRegistrosHoy();
                refrescarVistaOperador();

                const restante = Math.max(0, 600 - (Date.now() - inicioValMs));
                setTimeout(() => {
                    ocultarPantallaValidando();
                    mostrarAlertaPantallaCompleta({
                        severidad,
                        motivoCritico,
                        puntoNombre: punto.nombre,
                        codigoQR: codigoLeido,
                        horaStr: hora24,
                        operador: operadorActivo,
                        qrValido: true,
                        progHoy: mejor ? mejor.hora : null,
                        distancia,
                        tolerancia,
                        desvioMin,
                        margen
                    });
                }, restante);
            }, () => {
                ocultarPantallaValidando();
                mostrarSheetPermiso('gps');
                escaneoEnProceso = false;
            }, { enableHighAccuracy: true, timeout: 10000 });
        }

        function setFilaDetalleAlerta(clave, estadoIcono, textoValor, enRojo = false) {
            const iconEl = document.getElementById(`res-icon-${clave}`);
            const valEl = document.getElementById(`res-val-${clave}`);

            if (estadoIcono === 'ok') {
                iconEl.className = "fa-solid fa-check text-[#059669] w-4 text-center";
            } else if (estadoIcono === 'fail') {
                iconEl.className = "fa-solid fa-xmark text-[#DC2626] w-4 text-center";
            } else {
                iconEl.className = "fa-solid fa-minus text-[#94A3B8] w-4 text-center";
            }

            valEl.textContent = textoValor || "—";
            valEl.className = `font-mono-val text-[13px] ${enRojo ? 'text-[#B91C1C] font-medium' : 'text-[#0F172A]'}`;
        }

        function mostrarAlertaPantallaCompleta(data) {
            cancelarAutocierreAlerta();

            const modal = document.getElementById('modal-alerta-fullscreen');
            const zonaSup = document.getElementById('alerta-zona-superior');
            const icono = document.getElementById('icono-alerta-fs');
            const titleEl = document.getElementById('titulo-alerta-fs');
            const textEl = document.getElementById('texto-alerta-fs');
            const metaEl = document.getElementById('meta-alerta-fs');
            const accionesEl = document.getElementById('alerta-acciones-footer');
            const barraWrap = document.getElementById('alerta-barra-tiempo-wrap');
            const barra = document.getElementById('alerta-barra-tiempo');

            const opCorto = data.operador ? `${data.operador.split(' ')[0][0]}. ${data.operador.split(' ').slice(1).join(' ') || data.operador}` : "Operador";
            metaEl.textContent = `${data.puntoNombre} · ${data.horaStr} · ${opCorto.trim()}`;

            setFilaDetalleAlerta('qr', data.qrValido ? 'ok' : 'fail', data.codigoQR || "—", !data.qrValido);

            if (data.progHoy) {
                setFilaDetalleAlerta('prog', 'ok', data.progHoy, false);
            } else {
                setFilaDetalleAlerta('prog', data.qrValido ? 'fail' : 'neutral', data.qrValido ? "No programado" : "—", data.qrValido);
            }

            if (data.distancia !== null && data.tolerancia !== null) {
                const gpsOk = data.distancia <= data.tolerancia;
                setFilaDetalleAlerta('gps', gpsOk ? 'ok' : 'fail', `${data.distancia} m de ${data.tolerancia} m permitidos`, !gpsOk);
            } else {
                setFilaDetalleAlerta('gps', 'neutral', "—", false);
            }

            if (data.desvioMin !== null && data.margen !== null) {
                const horaOk = Math.abs(data.desvioMin) <= data.margen;
                const signo = data.desvioMin > 0 ? `+${data.desvioMin}` : `${data.desvioMin}`;
                setFilaDetalleAlerta('hora', horaOk ? 'ok' : 'fail', `${signo} min (margen ±${data.margen})`, !horaOk);
            } else {
                setFilaDetalleAlerta('hora', 'neutral', "—", false);
            }

            barraWrap.classList.add('hidden');

            if (data.severidad === "OK") {
                zonaSup.className = "h-[52%] min-h-[300px] px-6 pt-safe pb-6 flex flex-col items-center justify-center text-center text-white relative bg-[#059669]";
                icono.className = "fa-solid fa-circle-check text-[44px]";
                titleEl.textContent = "Escaneo registrado";
                textEl.textContent = "Todo en orden. Podés seguir con tu ronda.";

                accionesEl.innerHTML = `
                    <button onclick="cerrarAlertaResultado()" class="w-full h-[56px] rounded-[10px] bg-[#0F172A] hover:bg-[#1E293B] active:scale-[0.98] text-white font-semibold text-[16px] transition">
                        Continuar
                    </button>
                `;

                barraWrap.classList.remove('hidden');
                barra.style.transition = 'none';
                barra.style.width = '100%';
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        barra.style.transition = 'width 4000ms linear';
                        barra.style.width = '0%';
                    });
                });
                timerAutocierreAlerta = setTimeout(() => {
                    cerrarAlertaResultado();
                }, 4000);

            } else if (data.severidad === "ADVERTENCIA") {
                zonaSup.className = "h-[52%] min-h-[300px] px-6 pt-safe pb-6 flex flex-col items-center justify-center text-center text-white relative bg-[#D97706]";
                icono.className = "fa-solid fa-clock text-[44px]";
                titleEl.textContent = "Registrado fuera de horario";
                textEl.textContent = "Tu ubicación es correcta, pero el escaneo quedó fuera del margen. El encargado lo va a revisar.";

                accionesEl.innerHTML = `
                    <button onclick="cerrarAlertaResultado()" class="w-full h-[56px] rounded-[10px] bg-[#0F172A] hover:bg-[#1E293B] active:scale-[0.98] text-white font-semibold text-[16px] transition">
                        Entendido
                    </button>
                `;
            } else {
                zonaSup.className = "h-[52%] min-h-[300px] px-6 pt-safe pb-6 flex flex-col items-center justify-center text-center text-white relative bg-[#DC2626]";
                icono.className = "fa-solid fa-triangle-exclamation text-[44px]";
                if (navigator.vibrate) navigator.vibrate([80, 60, 80]);

                if (data.motivoCritico === "fuera_rango") {
                    titleEl.textContent = "Estás fuera del área del punto";
                    textEl.textContent = `Estás a ${data.distancia} m de ${data.puntoNombre}. Acercate a menos de ${data.tolerancia} m y volvé a escanear.`;
                } else if (data.motivoCritico === "no_programado") {
                    titleEl.textContent = "Este punto no está programado hoy";
                    textEl.textContent = "El escaneo quedó registrado como crítico.";
                } else {
                    titleEl.textContent = "Código QR no reconocido";
                    textEl.textContent = "Este código no pertenece a ningún punto registrado.";
                }

                accionesEl.innerHTML = `
                    <button onclick="reintentarEscaneoMismoOperador()" class="w-full h-[56px] rounded-[10px] bg-[#0F172A] hover:bg-[#1E293B] active:scale-[0.98] text-white font-semibold text-[16px] flex items-center justify-center gap-2 transition">
                        <i class="fa-solid fa-qrcode"></i>
                        <span>Volver a escanear</span>
                    </button>
                    <button onclick="cerrarAlertaResultado()" class="w-full h-[56px] rounded-[10px] bg-white border border-[#E2E8F0] hover:bg-[#F8FAFC] active:bg-[#F1F5F9] text-[#0F172A] font-semibold text-[16px] transition">
                        Cerrar
                    </button>
                `;
            }

            modal.classList.remove('hidden');
        }

        window.cancelarAutocierreAlerta = () => {
            if (timerAutocierreAlerta) {
                clearTimeout(timerAutocierreAlerta);
                timerAutocierreAlerta = null;
                document.getElementById('alerta-barra-tiempo-wrap').classList.add('hidden');
            }
        };

        window.cerrarAlertaResultado = () => {
            cancelarAutocierreAlerta();
            document.getElementById('modal-alerta-fullscreen').classList.add('hidden');
            escaneoEnProceso = false;
            refrescarVistaOperador();
        };

        window.reintentarEscaneoMismoOperador = () => {
            cancelarAutocierreAlerta();
            document.getElementById('modal-alerta-fullscreen').classList.add('hidden');
            escaneoEnProceso = false;
            iniciarCamara();
        };

        function mostrarSheetPermiso(tipo) {
            const icon = document.getElementById('sheet-permiso-icon');
            const titulo = document.getElementById('sheet-permiso-titulo');
            const texto = document.getElementById('sheet-permiso-texto');
            const btnReintentar = document.getElementById('sheet-permiso-reintentar');

            if (tipo === 'camara') {
                icon.className = "fa-solid fa-camera text-2xl";
                titulo.textContent = "Necesitamos la cámara";
                texto.textContent = "Habilitá el permiso de cámara en tu navegador para poder leer el código QR del punto.";
                btnReintentar.onclick = () => { cerrarSheetPermiso(); iniciarCamara(); };
            } else {
                icon.className = "fa-solid fa-location-dot text-2xl";
                titulo.textContent = "Necesitamos tu ubicación";
                texto.textContent = "Activá el permiso de ubicación en tu navegador para verificar que estás en el punto de ronda.";
                btnReintentar.onclick = () => { cerrarSheetPermiso(); iniciarMonitorGPSHeader(); };
            }

            document.getElementById('sheet-permiso-overlay').classList.remove('hidden');
            requestAnimationFrame(() => {
                document.getElementById('sheet-permiso').classList.remove('translate-y-full');
            });
        }

        window.cerrarSheetPermiso = () => {
            document.getElementById('sheet-permiso').classList.add('translate-y-full');
            setTimeout(() => {
                document.getElementById('sheet-permiso-overlay').classList.add('hidden');
            }, 250);
        };

        window.abrirLoginEncargado = () => {
            const input = document.getElementById('input-password-encargado');
            const err = document.getElementById('error-login-encargado');
            input.value = '';
            input.type = 'password';
            document.getElementById('icono-ojo-clave').className = "fa-regular fa-eye text-sm";
            input.classList.remove('border-[#DC2626]');
            err.classList.add('hidden');

            document.getElementById('modal-login-encargado').classList.remove('hidden');
            requestAnimationFrame(() => {
                document.getElementById('sheet-login-encargado').classList.remove('scale-95', 'opacity-0');
                setTimeout(() => input.focus(), 260);
            });
        };

        window.cerrarModalLoginEncargado = () => {
            document.getElementById('sheet-login-encargado').classList.add('scale-95', 'opacity-0');
            setTimeout(() => {
                document.getElementById('modal-login-encargado').classList.add('hidden');
            }, 250);
        };

        window.toggleVerClaveEncargado = () => {
            const input = document.getElementById('input-password-encargado');
            const icon = document.getElementById('icono-ojo-clave');
            if (input.type === 'password') {
                input.type = 'text';
                icon.className = "fa-regular fa-eye-slash text-sm";
            } else {
                input.type = 'password';
                icon.className = "fa-regular fa-eye text-sm";
            }
        };

        window.intentarLoginEncargado = async (e) => {
            e.preventDefault();
            const input = document.getElementById('input-password-encargado');
            const err = document.getElementById('error-login-encargado');

            if (input.value === PASSWORD_ENCARGADO) {
                sessionStorage.setItem('sesion_encargado', 'activa');
                cerrarModalLoginEncargado();
                actualizarInterfazSegunRol();
                actualizarEstadoVisualNotificaciones();
                iniciarListenerIncidenciasSupervisor();
                if ("Notification" in window && Notification.permission === "granted") {
                    registrarTokenFCM('encargado');
                }
                // Cargar todos los datos frescos antes de renderizar el panel
                await cargarDatosPanelAdmin();
                renderizarTodoAdmin();
            } else {
                input.classList.add('border-[#DC2626]', 'animar-sacudida');
                err.classList.remove('hidden');
                setTimeout(() => input.classList.remove('animar-sacudida'), 300);
            }
        };

        window.cerrarSesionEncargado = () => {
            detenerListenerIncidenciasSupervisor();
            sessionStorage.removeItem('sesion_encargado');
            actualizarInterfazSegunRol();
            actualizarEstadoVisualNotificaciones();
            if ("Notification" in window && Notification.permission === "granted") {
                registrarTokenFCM('operador');
            }
            refrescarVistaOperador();
        };

        function actualizarInterfazSegunRol() {
            const esEncargado = sessionStorage.getItem('sesion_encargado') === 'activa';
            document.getElementById('vista-operador').classList.toggle('hidden', esEncargado);
            document.getElementById('header-operador').classList.toggle('hidden', esEncargado);
            document.getElementById('barra-inferior-operador').classList.toggle('hidden', esEncargado);

            document.getElementById('vista-encargado').classList.toggle('hidden', !esEncargado);
            document.getElementById('header-encargado').classList.toggle('hidden', !esEncargado);
            document.getElementById('footer-encargado').classList.toggle('hidden', !esEncargado);

            actualizarEstadoVisualNotificaciones();
            if (esEncargado) {
                iniciarListenerIncidenciasSupervisor();
            } else {
                detenerListenerIncidenciasSupervisor();
            }
        }

        window.solicitarPermisoNotificaciones = async (rolManual) => {
            if (!("Notification" in window)) {
                actualizarEstadoVisualNotificaciones();
                return;
            }

            try {
                const permiso = await Notification.requestPermission();
                actualizarEstadoVisualNotificaciones();

                if (permiso === "granted") {
                    await registrarTokenFCM(rolManual);
                }
            } catch (err) {
                console.error('[Notif] Error al solicitar permiso:', err);
            }
        };

        function actualizarEstadoVisualNotificaciones() {
            const perm = ("Notification" in window) ? Notification.permission : "unsupported";

            // Botón/pastilla en cabecera de Operador
            const dotOp = document.getElementById('pill-notif-dot');
            const textOp = document.getElementById('pill-notif-text');
            const btnOp = document.getElementById('pill-notif-op');

            if (dotOp && textOp && btnOp) {
                if (perm === 'granted') {
                    dotOp.className = "w-1.5 h-1.5 rounded-full bg-[#059669]";
                    textOp.textContent = "Alertas";
                    btnOp.classList.remove('animate-pulse', 'border-amber-300', 'bg-amber-50');
                    btnOp.title = "Alertas nativas activas en este dispositivo";
                } else if (perm === 'denied') {
                    dotOp.className = "w-1.5 h-1.5 rounded-full bg-[#DC2626]";
                    textOp.textContent = "Bloqueadas";
                    btnOp.classList.remove('animate-pulse');
                    btnOp.title = "Notificaciones bloqueadas por el usuario";
                } else if (perm === 'unsupported') {
                    dotOp.className = "w-1.5 h-1.5 rounded-full bg-[#DC2626]";
                    textOp.textContent = "No soportado";
                    btnOp.classList.remove('animate-pulse');
                    btnOp.title = "Este navegador no admite notificaciones nativas";
                } else {
                    dotOp.className = "w-1.5 h-1.5 rounded-full bg-[#D97706]";
                    textOp.textContent = "Activar";
                    btnOp.classList.add('animate-pulse', 'border-amber-300', 'bg-amber-50');
                    btnOp.title = "Toca para habilitar alertas nativas en Android";
                }
            }

            // Botón en cabecera de Supervisor / Encargado
            const dotAdmin = document.getElementById('dot-notif-admin');
            const textAdmin = document.getElementById('text-notif-admin');
            const btnAdmin = document.getElementById('btn-notif-admin');

            if (dotAdmin && btnAdmin) {
                if (perm === 'granted') {
                    dotAdmin.className = "w-2 h-2 rounded-full bg-[#059669]";
                    if (textAdmin) textAdmin.textContent = "Alertas ON";
                    btnAdmin.title = "Alertas de supervisión en tiempo real activas";
                } else if (perm === 'denied') {
                    dotAdmin.className = "w-2 h-2 rounded-full bg-[#DC2626]";
                    if (textAdmin) textAdmin.textContent = "Bloqueadas";
                    btnAdmin.title = "Notificaciones bloqueadas";
                } else if (perm === 'unsupported') {
                    dotAdmin.className = "w-2 h-2 rounded-full bg-[#DC2626]";
                    if (textAdmin) textAdmin.textContent = "No soportado";
                    btnAdmin.title = "Este navegador no admite notificaciones nativas";
                } else {
                    dotAdmin.className = "w-2 h-2 rounded-full bg-[#D97706]";
                    if (textAdmin) textAdmin.textContent = "Activar";
                    btnAdmin.title = "Toca para activar alertas nativas en este dispositivo";
                }
            }
        }

        async function inicializarServiceWorkerYNotificaciones() {
            if (!('serviceWorker' in navigator)) {
                console.warn('[SW] Service Worker no soportado en este navegador.');
                return;
            }

            try {
                swRegistration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
                console.log('[SW] Service Worker registrado:', swRegistration.scope);

                // Soporte FCM Web
                const fcmSoportado = await isMessagingSupported().catch(() => false);
                if (fcmSoportado) {
                    try {
                        fcmMessaging = getMessaging(app);
                        onMessage(fcmMessaging, (payload) => {
                            console.log('[FCM] Mensaje recibido en primer plano:', payload);
                            const tit = payload.notification?.title || payload.data?.title || "Control de Rondas";
                            const msg = payload.notification?.body || payload.data?.body || "";
                            const sev = payload.data?.severidad || "info";
                                // Notificacion suprimida: las alertas push se gestionan solo por el emisor externo (Vercel + cron).
                        });
                    } catch (errFCM) {
                        console.warn('[FCM] Error inicializando messaging:', errFCM);
                    }
                }

                actualizarEstadoVisualNotificaciones();

                if ("Notification" in window && Notification.permission === "granted") {
                    await registrarTokenFCM();
                }
            } catch (err) {
                console.error('[SW] Error al inicializar Service Worker / FCM:', err);
            }
        }

        async function registrarTokenFCM(rolManual) {
            const esAdmin = sessionStorage.getItem('sesion_encargado') === 'activa';
            const rol = rolManual || (esAdmin ? 'encargado' : 'operador');

            if (!fcmMessaging || !swRegistration) return;

            try {
                let token = null;
                try {
                    const opcionesToken = { serviceWorkerRegistration: swRegistration };
                    if (VAPID_KEY) opcionesToken.vapidKey = VAPID_KEY;
                    token = await getToken(fcmMessaging, opcionesToken);
                } catch (eToken) {
                    console.warn('[FCM] No se pudo obtener el token:', eToken.message);
                }

                if (token) {
                    fcmTokenActual = token;
                    localStorage.setItem('fcm_token_guardado', token);
                    const tokenSafeId = btoa(token.slice(-32)).replace(/[/+=]/g, '_');
                    await setDoc(doc(db, "dispositivos_notificaciones", tokenSafeId), {
                        token: token,
                        rol: rol,
                        operador: operadorActivo || (rol === 'encargado' ? 'Supervisor' : 'Sin asignar'),
                        actualizadoEn: new Date().toISOString(),
                        timestampMs: Date.now(),
                        userAgent: navigator.userAgent,
                        plataforma: /android/i.test(navigator.userAgent) ? "Android" : "Web",
                        activo: true
                    }, { merge: true });
                    console.log(`[FCM] Dispositivo registrado como [${rol}]:`, tokenSafeId);
                }
            } catch (err) {
                console.warn('[FCM] Error registrando token en Firestore:', err);
            }
        }

        function iniciarListenerIncidenciasSupervisor() {
            // Deshabilitado: las notificaciones push se envían únicamente mediante
            // el emisor externo (Vercel + cron-job.org) para que solo lleguen con la
            // app cerrada y no se dupliquen con el motor interno.
            return;
        }

        function detenerListenerIncidenciasSupervisor() {
            if (unsubscribeIncidenciasSupervisor) {
                unsubscribeIncidenciasSupervisor();
                unsubscribeIncidenciasSupervisor = null;
            }
        }

        const historialAlertasOperador = {};

        function debeEmitirAlerta(clave, intervaloMs) {
            const ahoraMs = Date.now();
            const ultimoMs = historialAlertasOperador[clave] || 0;
            if (ahoraMs - ultimoMs >= intervaloMs) {
                historialAlertasOperador[clave] = ahoraMs;
                return true;
            }
            return false;
        }

        function iniciarMotorAlertasOperador() {
            // Deshabilitado: las notificaciones push se envían únicamente mediante
            // el emisor externo (Vercel + cron-job.org). El motor interno solo
            // generaba notificaciones duplicadas con el cron.
            return;
        }

        async function lanzarNotificacionSistema(titulo, texto, severidad = "info", tagPersonalizado = null) {
            if (!("Notification" in window) || Notification.permission !== "granted") return;

            const notifOptions = {
                body: texto,
                icon: "/icon-192.png",
                badge: "/badge-72.png",
                vibrate: severidad === "CRITICO" ? [300, 100, 300, 100, 400] : [200, 100, 200],
                tag: tagPersonalizado || (severidad === "CRITICO" ? `ronda-crit-${Date.now()}` : 'ronda-alerta'),
                renotify: true,
                requireInteraction: severidad === "CRITICO",
                data: {
                    timestamp: Date.now(),
                    severidad: severidad
                }
            };

            // En Android Chrome la notificación debe emitirse desde el Service Worker.
            try {
                let reg = swRegistration;
                if (!reg && navigator.serviceWorker && navigator.serviceWorker.ready) {
                    reg = await navigator.serviceWorker.ready;
                }
                if (reg && reg.showNotification) {
                    await reg.showNotification(titulo, notifOptions);
                    return;
                }
            } catch (swErr) {
                console.warn('[Notif] Falló emisión vía Service Worker:', swErr);
            }

            // Fallback para navegadores de escritorio compatibles con new Notification()
            try {
                new Notification(titulo, notifOptions);
            } catch (e) {}
        }

        function obtenerFechaFiltroISO() {
            const d = new Date();
            d.setDate(d.getDate() + offsetDiasFiltro);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        }

        function obtenerNombreDiaFiltro() {
            const d = new Date();
            d.setDate(d.getDate() + offsetDiasFiltro);
            return DIAS_SEMANA[d.getDay()];
        }

        function actualizarRelojYFechaHeader() {
            const ahora = new Date();
            const horaStr = formatearHora24(ahora);

            const relojEl = document.getElementById('reloj-actual');
            if (relojEl) relojEl.textContent = horaStr;

            const fechaLargaHoy = `${DIAS_SEMANA[ahora.getDay()]}, ${ahora.getDate()} ${MESES_CORTOS[ahora.getMonth()]} ${ahora.getFullYear()}`;
            const opFechaLarga = document.getElementById('op-fecha-larga');
            if (opFechaLarga) opFechaLarga.textContent = fechaLargaHoy;

            const opFechaCorta = document.getElementById('op-fecha-corta');
            if (opFechaCorta) opFechaCorta.textContent = `${String(ahora.getDate()).padStart(2, '0')}/${String(ahora.getMonth() + 1).padStart(2, '0')}/${ahora.getFullYear()}`;

            const dFiltroHeader = new Date();
            dFiltroHeader.setDate(dFiltroHeader.getDate() + offsetDiasFiltro);
            const fechaStr = `${DIAS_SEMANA[dFiltroHeader.getDay()]}, ${dFiltroHeader.getDate()} ${MESES_CORTOS[dFiltroHeader.getMonth()]} ${dFiltroHeader.getFullYear()}`;
            const headerFechaLarga = document.getElementById('header-fecha-larga');
            if (headerFechaLarga) headerFechaLarga.textContent = fechaStr;

            const btnFechaSig = document.getElementById('btn-fecha-sig');
            if (btnFechaSig) {
                btnFechaSig.disabled = (offsetDiasFiltro >= 0);
                btnFechaSig.style.opacity = (offsetDiasFiltro >= 0) ? "0.4" : "1";
            }
        }

        window.cambiarFechaFiltro = async (delta) => {
            offsetDiasFiltro += delta;
            if (offsetDiasFiltro > 0) offsetDiasFiltro = 0;
            actualizarRelojYFechaHeader();
            await cargarRegistrosAdmin();
            renderizarTodoAdmin();
        };

        function actualizarEstadoRed() {
            const ind = document.getElementById('indicador-red');
            if (ind) ind.className = `w-1.5 h-1.5 rounded-full ${navigator.onLine ? 'bg-[#10B981]' : 'bg-amber-500 animate-ping'}`;
        }

        async function sincronizarColaOffline() {
            if (!navigator.onLine) return;
            const cola = JSON.parse(localStorage.getItem('cola_rondas_offline') || '[]');
            if (cola.length === 0) return;
            const restantes = [];
            for (const item of cola) {
                try {
                    // La cola se serializa a JSON: hay que reconstruir las fechas antes de enviarlas.
                    const itemFs = { ...item };
                    if (itemFs.creadoEn) itemFs.creadoEn = new Date(itemFs.creadoEn);
                    if (itemFs.expiraEn) itemFs.expiraEn = new Date(itemFs.expiraEn);
                    else if (itemFs.timestampMs) itemFs.expiraEn = new Date(Number(itemFs.timestampMs) + RETENCION_MS);
                    await addDoc(collection(db, "registros_ronda"), itemFs);
                } catch (e) {
                    restantes.push(item);
                }
            }
            localStorage.setItem('cola_rondas_offline', JSON.stringify(restantes));
            const tareas = [cargarRegistrosHoy()];
            if (offsetDiasFiltro !== 0) tareas.push(cargarRegistrosAdmin());
            await Promise.all(tareas);
        }

        // Retención efectiva sin Cloud Functions: elimina en lotes los registros
        // con más de DIAS_RETENCION días. La política TTL de Firestore queda como
        // alternativa si el proyecto pasa a un plan con facturación habilitada.
        async function limpiarRegistrosAntiguos() {
            if (!navigator.onLine) return 0;
            const corte = Date.now() - RETENCION_MS;
            let eliminados = 0;

            try {
                for (let lote = 0; lote < 5; lote++) {
                    const snap = await getDocs(query(
                        collection(db, "registros_ronda"),
                        where("timestampMs", "<", corte),
                        orderBy("timestampMs", "asc"),
                        limit(400)
                    ));
                    if (snap.empty) break;

                    const batch = writeBatch(db);
                    snap.forEach(d => batch.delete(d.ref));
                    await batch.commit();
                    eliminados += snap.size;
                    if (snap.size < 400) break;
                }
                if (eliminados > 0) console.info(`[Retención] ${eliminados} registros antiguos eliminados.`);
            } catch (e) {
                console.warn('[Retención] No se pudieron eliminar registros antiguos:', e);
            }

            return eliminados;
        }

        window.cambiarTabAdmin = (tab) => {
            ['auditoria', 'puntos', 'rutas', 'personal'].forEach(t => {
                const sec = document.getElementById(`seccion-${t}`);
                const btn = document.getElementById(`tab-${t}`);
                if (t === tab) {
                    sec.classList.remove('hidden');
                    btn.className = "pb-3 text-sm font-medium border-b-2 border-[#0F172A] text-[#0F172A] flex items-center gap-2.5 whitespace-nowrap transition";
                } else {
                    sec.classList.add('hidden');
                    btn.className = "pb-3 text-sm font-medium border-b-2 border-transparent text-[#64748B] hover:text-[#1E293B] flex items-center gap-2.5 whitespace-nowrap transition";
                }
            });
            const nombresTab = { auditoria: "Auditoría", puntos: "Puntos de control", rutas: "Programación de horarios", personal: "Personal" };
            document.getElementById('breadcrumb-actual').textContent = nombresTab[tab];
        };

        window.actualizarDatosPanel = async () => {
            const icono = document.getElementById('icono-actualizar');
            if (icono) icono.classList.add('spinning');
            try {
                await cargarDatosPanelAdmin();
                renderizarTodoAdmin();
            } catch (e) {
                console.error('[Panel] Error al actualizar datos:', e);
                mostrarAvisoPanel('No se pudieron actualizar los datos. Revisá la conexión y las reglas de Firestore.', 'error');
            } finally {
                setTimeout(() => { if (icono) icono.classList.remove('spinning'); }, 700);
            }
        };

        async function cargarDatosPanelAdmin() {
            const tareas = [
                cargarOperadores(),
                cargarPuntos(),
                cargarRutas(),
                cargarRegistrosAdmin()
            ];
            if (offsetDiasFiltro !== 0) tareas.push(cargarRegistrosHoy());
            await Promise.all(tareas);
        }

        async function cargarOperadores() {
            try {
                const snap = await getDocs(collection(db, "operadores"));
                operadoresCache = [];
                snap.forEach(d => operadoresCache.push({ id: d.id, ...d.data() }));

                const filtroOp = document.getElementById('filtro-operador');
                if (filtroOp) {
                    const valAnt = filtroOp.value;
                    filtroOp.innerHTML = '<option value="">Todos los operadores</option>';
                    operadoresCache.forEach(op => {
                        const opt = document.createElement('option');
                        opt.value = op.nombre; opt.textContent = op.nombre;
                        filtroOp.appendChild(opt);
                    });
                    filtroOp.value = valAnt;
                }

                const activos = operadoresCache.filter(op => op.activo !== false);
                document.getElementById('lbl-total-operadores').textContent = `${operadoresCache.length} de ${MAX_OPERADORES} · ${activos.length} activos`;
                document.getElementById('badge-personal-tab').textContent = operadoresCache.length;

                if (operadorActivo && !activos.some(op => op.nombre === operadorActivo)) {
                    operadorActivo = "";
                    operadorPreseleccionadoSheet = "";
                    localStorage.removeItem('operador_seleccionado');
                }
            } catch (e) {
                console.error('[Datos] Error al cargar operadores:', e);
            }
        }

        async function cargarPuntos() {
            try {
                const snap = await getDocs(collection(db, "puntos_control"));
                const pts = [];
                snap.forEach(d => pts.push({ id: d.id, ...d.data() }));
                puntosCache = {};
                pts.forEach(p => puntosCache[p.codigo] = p);

                document.getElementById('lbl-total-puntos-activos').textContent = `${pts.length} de ${MAX_PUNTOS}`;
                document.getElementById('badge-puntos-tab').textContent = pts.length;

                const selectRuta = document.getElementById('ruta-punto');
                if (selectRuta) {
                    const codigosSeleccionados = selectRuta.value.split(',').filter(Boolean);
                    const seleccionValida = codigosSeleccionados.filter(codigo => puntosCache[codigo]);
                    if (seleccionValida.length > 0) {
                        selectRuta.value = seleccionValida.join(',');
                        const elegido = document.getElementById('ruta-punto-seleccionado');
                        elegido.textContent = `${seleccionValida.length} punto(s): ${seleccionValida.map(codigo => puntosCache[codigo].nombre).join(', ')}`;
                        elegido.className = 'text-xs font-semibold text-[#0F172A]';
                    } else {
                        selectRuta.value = '';
                        const elegido = document.getElementById('ruta-punto-seleccionado');
                        elegido.textContent = 'Elegí puntos en el mapa';
                        elegido.className = 'text-xs text-[#64748B]';
                    }
                }
                actualizarPuntosMapaRuta();
            } catch (e) {
                console.error('[Datos] Error al cargar puntos:', e);
            }
        }

        async function cargarRutas() {
            try {
                const snap = await getDocs(collection(db, "rutas_horarias"));
                rutasCache = [];
                snap.forEach(d => rutasCache.push({ id: d.id, ...d.data() }));
            } catch (e) {
                console.error('[Datos] Error al cargar rutas:', e);
            }
        }

        async function cargarRegistrosHoy() {
            try {
                const fecha = obtenerFechaHoyISO();
                const snap = await getDocs(query(
                    collection(db, "registros_ronda"),
                    where("fechaISO", "==", fecha),
                    limit(LIMITE_REGISTROS_DIA)
                ));
                registrosCache = snap.docs
                    .map(d => d.data())
                    .sort((a, b) => (Number(b.timestampMs) || 0) - (Number(a.timestampMs) || 0));
                if (offsetDiasFiltro === 0) registrosAdminCache = registrosCache;
            } catch (e) {
                console.error('[Datos] Error al cargar registros de hoy:', e);
            }
        }

        async function cargarRegistrosAdmin() {
            const fecha = obtenerFechaFiltroISO();
            try {
                const snap = await getDocs(query(
                    collection(db, "registros_ronda"),
                    where("fechaISO", "==", fecha),
                    limit(LIMITE_REGISTROS_DIA)
                ));
                registrosAdminCache = snap.docs
                    .map(d => d.data())
                    .sort((a, b) => (Number(b.timestampMs) || 0) - (Number(a.timestampMs) || 0));
                if (offsetDiasFiltro === 0) registrosCache = registrosAdminCache;
                if (snap.size >= LIMITE_REGISTROS_DIA) {
                    mostrarAvisoPanel(`Se alcanzó el límite de ${LIMITE_REGISTROS_DIA} registros para este día.`, 'warn');
                }
            } catch (e) {
                console.error('[Datos] Error al cargar registros del día:', e);
                registrosAdminCache = [];
                mostrarAvisoPanel('No se pudieron cargar los registros del día. Revisá la conexión y las reglas de Firestore.', 'error');
            }
        }

        function renderizarTodoAdmin() {
            // Cada bloque se renderiza de forma independiente: un error en uno no debe
            // impedir que se muestren las demás secciones del panel.
            [
                ['auditoría', renderizarTablaAuditoria],
                ['KPIs', renderizarKPIs],
                ['resúmenes', renderizarResumenesAuditoria],
                ['puntos', renderizarPuntosAdmin],
                ['rutas', renderizarRutasAdmin],
                ['personal', renderizarPersonalAdmin]
            ].forEach(([nombre, fn]) => {
                try {
                    fn();
                } catch (e) {
                    console.error(`[Panel] Error al renderizar ${nombre}:`, e);
                }
            });
        }

        function renderizarKPIs() {
            const fechaFiltro = obtenerFechaFiltroISO();
            const regsDia = registrosAdminCache.filter(r => r.fechaISO === fechaFiltro);

            const total = regsDia.length;
            const validos = regsDia.filter(r => r.severidad === "OK").length;
            const advs = regsDia.filter(r => r.severidad === "ADVERTENCIA").length;
            const crits = regsDia.filter(r => r.severidad === "CRITICO").length;

            const setTexto = (id, valor) => {
                const el = document.getElementById(id);
                if (el) el.textContent = valor;
            };
            const setAncho = (id, valor) => {
                const el = document.getElementById(id);
                if (el) el.style.width = `${valor}%`;
            };

            setTexto('kpi-total', total);
            setTexto('kpi-validos', validos);
            setTexto('kpi-advertencias', advs);
            setTexto('kpi-criticos', crits);
            setTexto('kpi-periodo', offsetDiasFiltro === 0 ? 'Hoy' : 'Día seleccionado');

            const pctV = total > 0 ? Math.round((validos / total) * 100) : 0;
            const pctA = total > 0 ? Math.round((advs / total) * 100) : 0;
            const pctC = total > 0 ? Math.round((crits / total) * 100) : 0;

            setTexto('kpi-validos-pct', pctV + '%');
            setTexto('kpi-adv-pct', pctA + '%');
            setTexto('kpi-crit-text', `${pctC}% · requieren revisión`);

            setAncho('bar-kpi-val', pctV);
            setAncho('bar-kpi-adv', pctA);
            setAncho('bar-kpi-crit', pctC);
        }

        window.filtrarEstadoTabla = (estado) => {
            filtroEstadoActual = estado;
            ['todos', 'valido', 'advertencia', 'critico'].forEach(st => {
                const btn = document.getElementById(`filtro-btn-${st}`);
                btn.className = st === estado
                    ? "px-3 py-1.5 rounded bg-white text-[#0F172A] shadow-xs transition font-medium"
                    : "px-3 py-1.5 rounded text-[#475569] hover:text-[#0F172A] transition font-medium";
            });
            renderizarTablaAuditoria();
        };

        window.aplicarFiltrosTabla = () => renderizarTablaAuditoria();

        function renderizarTablaAuditoria() {
            const fechaFiltro = obtenerFechaFiltroISO();
            const opFiltro = document.getElementById('filtro-operador').value;
            const busqueda = document.getElementById('filtro-busqueda').value.toLowerCase().trim();

            let regs = registrosAdminCache.filter(r => r.fechaISO === fechaFiltro);

            const cnts = { todos: regs.length, valido: 0, advertencia: 0, critico: 0 };
            regs.forEach(r => {
                if (r.severidad === "OK") cnts.valido++;
                else if (r.severidad === "ADVERTENCIA") cnts.advertencia++;
                else if (r.severidad === "CRITICO") cnts.critico++;
            });
            document.getElementById('cnt-todos').textContent = cnts.todos;
            document.getElementById('cnt-valido').textContent = cnts.valido;
            document.getElementById('cnt-advertencia').textContent = cnts.advertencia;
            document.getElementById('cnt-critico').textContent = cnts.critico;

            if (filtroEstadoActual === 'valido') regs = regs.filter(r => r.severidad === "OK");
            if (filtroEstadoActual === 'advertencia') regs = regs.filter(r => r.severidad === "ADVERTENCIA");
            if (filtroEstadoActual === 'critico') regs = regs.filter(r => r.severidad === "CRITICO");
            if (opFiltro) regs = regs.filter(r => r.operador === opFiltro);
            if (busqueda) {
                regs = regs.filter(r => (r.puntoNombre && r.puntoNombre.toLowerCase().includes(busqueda)) || (r.codigoQR && r.codigoQR.toLowerCase().includes(busqueda)) || (r.operador && r.operador.toLowerCase().includes(busqueda)));
            }

            const tbody = document.getElementById('tabla-auditoria-body');
            const tablaVacia = document.getElementById('tabla-vacia');
            tbody.innerHTML = '';

            if (regs.length === 0) {
                tablaVacia.classList.remove('hidden');
                document.getElementById('footer-contador-registros').textContent = `Mostrando 0 de ${registrosAdminCache.filter(r => r.fechaISO === fechaFiltro).length} registros`;
                return;
            }
            tablaVacia.classList.add('hidden');

            regs.forEach((r) => {
                const pt = puntosCache[r.codigoQR];
                const codigoPt = pt ? pt.codigo : (r.codigoQR || "—");
                const iniciales = obtenerIniciales(r.operador);
                const [fechaTxt, horaTxt] = r.fechaTexto ? r.fechaTexto.split(' ') : ["", r.fechaTexto || "00:00"];
                const margenReg = obtenerMargenRegistro(r, rutasCache);

                let progHtml = `<span class="text-[#94A3B8]">Sin agenda</span>`;
                let desvioHtml = `<span class="text-[#CBD5E1]">—</span>`;

                if (r.horarioProgramado && r.horarioProgramado !== "Sin agenda") {
                    progHtml = `<span class="font-mono-val">${escapeHtml(r.horarioProgramado)}</span> <span class="text-[12px] text-[#64748B]">±${margenReg}′</span>`;
                    if (r.timestampMs) {
                        const [hP, mP] = r.horarioProgramado.split(':').map(Number);
                        if (!isNaN(hP) && !isNaN(mP)) {
                            const dProg = new Date(r.timestampMs);
                            dProg.setHours(hP, mP, 0, 0);
                            const diffMin = Math.round((r.timestampMs - dProg.getTime()) / 60000);
                            if (!isNaN(diffMin)) {
                                if (diffMin === 0) desvioHtml = `<span class="font-mono-val text-[#475569]">0 min</span>`;
                                else if (diffMin > 0) desvioHtml = `<span class="font-mono-val ${diffMin > margenReg ? 'text-[#B45309] font-semibold' : 'text-[#475569]'}">+${diffMin} min</span>`;
                                else desvioHtml = `<span class="font-mono-val text-[#475569]">${diffMin} min</span>`;
                            }
                        }
                    }
                }

                let distHtml = `<span class="text-[#CBD5E1]">—</span>`;
                const distanciaMedida = r.distancia !== undefined ? r.distancia : r.gpsDist;
                if (distanciaMedida !== undefined && distanciaMedida !== null && !isNaN(distanciaMedida)) {
                    const tolerancia = obtenerToleranciaRegistro(r, pt);
                    const supera = distanciaMedida > tolerancia;
                    distHtml = `<span class="font-mono-val ${supera ? 'text-[#B91C1C] font-medium' : 'text-[#334155]'}">${distanciaMedida} m</span> <span class="text-[12px] text-[#94A3B8]">/ ${tolerancia} m</span>`;
                }

                const est = r.estado || "Válido";
                let badgeHtml = '';
                if (r.severidad === "OK") {
                    badgeHtml = `<span class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[12px] font-medium bg-[#ECFDF5] text-[#047857] ring-1 ring-[#059669]/20"><i class="fa-solid fa-circle-check text-[10px]"></i> Válido</span>`;
                } else if (r.severidad === "ADVERTENCIA") {
                    badgeHtml = `<span class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[12px] font-medium bg-[#FFFBEB] text-[#92400E] ring-1 ring-[#D97706]/25"><i class="fa-solid fa-clock text-[10px]"></i> Fuera de horario</span>`;
                } else {
                    badgeHtml = `<span class="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[12px] font-medium bg-[#FEF2F2] text-[#B91C1C] ring-1 ring-[#DC2626]/20"><i class="fa-solid fa-triangle-exclamation text-[10px]"></i> ${escapeHtml(est)}</span>`;
                }

                const tr = document.createElement('tr');
                tr.className = "hover:bg-[#F8FAFC] cursor-pointer transition h-[56px]";
                tr.onclick = () => abrirDrawerDetalle(r);
                tr.innerHTML = `
                    <td class="py-3.5 px-5">
                        <div class="flex items-baseline gap-2">
                            <span class="font-mono-val font-medium text-[#0F172A]">${escapeHtml(horaTxt || "—")}</span>
                            <span class="text-[12px] text-[#94A3B8] font-mono-val">${escapeHtml(fechaTxt || r.fechaISO || "—")}</span>
                        </div>
                    </td>
                    <td class="py-3.5 px-5">
                        <strong class="font-medium text-[#0F172A] block text-[14px]">${escapeHtml(r.puntoNombre || 'Punto QR')}</strong>
                        <span class="text-[12px] text-[#94A3B8] font-mono-val block truncate max-w-[160px]">${escapeHtml(codigoPt)}</span>
                    </td>
                    <td class="py-3.5 px-5">
                        <div class="flex items-center gap-2.5">
                            <div class="w-7 h-7 rounded-full bg-[#F1F5F9] text-[#475569] text-[11px] font-semibold flex items-center justify-center">${escapeHtml(iniciales)}</div>
                            <span class="text-[#334155] font-normal text-[14px]">${escapeHtml(r.operador || 'Operador')}</span>
                        </div>
                    </td>
                    <td class="py-3.5 px-5">${progHtml}</td>
                    <td class="py-3.5 px-5">${desvioHtml}</td>
                    <td class="py-3.5 px-5">${distHtml}</td>
                    <td class="py-3.5 px-5">${badgeHtml}</td>
                    <td class="py-3.5 px-2 text-right text-[#CBD5E1]"><i class="fa-solid fa-chevron-right text-xs"></i></td>
                `;
                tbody.appendChild(tr);
            });

            document.getElementById('footer-contador-registros').textContent = `Mostrando ${regs.length} de ${registrosAdminCache.filter(r => r.fechaISO === fechaFiltro).length} registros`;
            document.getElementById('lbl-ultima-act').textContent = formatearHora24(new Date());
        }

        function renderizarResumenesAuditoria() {
            const fechaFiltro = obtenerFechaFiltroISO();
            const hoyNombre = obtenerNombreDiaFiltro();
            const hoyISO = obtenerFechaHoyISO();
            const esDiaPasado = fechaFiltro < hoyISO;
            const regsDia = registrosAdminCache.filter(r => r.fechaISO === fechaFiltro);

            const lblAgendaTitulo = document.getElementById('resumen-agenda-titulo');
            if (lblAgendaTitulo) lblAgendaTitulo.textContent = offsetDiasFiltro === 0 ? 'Agenda de hoy' : 'Agenda del día';
            const lblOpsPeriodo = document.getElementById('resumen-ops-periodo');
            if (lblOpsPeriodo) lblOpsPeriodo.textContent = offsetDiasFiltro === 0 ? 'Hoy' : 'Día seleccionado';

            const baseFecha = new Date();
            baseFecha.setDate(baseFecha.getDate() + offsetDiasFiltro);

            const rutasHoy = rutasCache.filter(r => r.dia === hoyNombre || r.dia === "Todos");
            const totalAgenda = rutasHoy.length;
            document.getElementById('resumen-agenda-total').textContent = `${totalAgenda} controles`;

            let completados = 0;
            let vencidos = 0;
            let pendientes = 0;

            const detalleRutas = rutasHoy.map(ruta => {
                const [hh, mm] = (ruta.hora || "00:00").split(':').map(Number);
                const margen = Number(ruta.margen) || 15;
                const limite = new Date(baseFecha);
                limite.setHours(isNaN(hh) ? 0 : hh, (isNaN(mm) ? 0 : mm) + margen, 0, 0);

                const completada = rutaCompletada(regsDia, ruta);
                const vencida = !completada && (esDiaPasado || new Date() > limite);

                if (completada) completados++;
                else if (vencida) vencidos++;
                else pendientes++;

                return { ruta, completada, vencida };
            }).sort((a, b) => String(a.ruta.hora || '').localeCompare(String(b.ruta.hora || '')));

            document.getElementById('num-agenda-completados').textContent = completados;
            document.getElementById('num-agenda-vencidos').textContent = vencidos;
            document.getElementById('num-agenda-pendientes').textContent = pendientes;

            const pctComp = totalAgenda > 0 ? Math.round((completados / totalAgenda) * 100) : 0;
            const pctVenc = totalAgenda > 0 ? Math.round((vencidos / totalAgenda) * 100) : 0;
            document.getElementById('bar-agenda-completados').style.width = `${pctComp}%`;
            document.getElementById('bar-agenda-vencidos').style.width = `${pctVenc}%`;

            const listaAgenda = document.getElementById('lista-agenda-resumen');
            listaAgenda.innerHTML = '';
            if (rutasHoy.length === 0) {
                listaAgenda.innerHTML = '<p class="text-xs text-slate-400 py-2">Sin agenda programada para este día.</p>';
            } else {
                detalleRutas.slice(0, 4).forEach(({ ruta, completada, vencida }) => {
                    const estadoHtml = completada
                        ? '<span class="text-[#059669] font-semibold">Completado</span>'
                        : vencida
                            ? '<span class="text-[#DC2626] font-semibold">Vencido</span>'
                            : '<span class="text-[#64748B]">Pendiente</span>';
                    listaAgenda.innerHTML += `
                        <div class="py-2 flex justify-between items-center text-xs">
                            <div class="flex items-center gap-2 min-w-0">
                                <span class="font-mono-val text-[#64748B] w-11 shrink-0">${escapeHtml(ruta.hora)}</span>
                                <span class="font-medium text-[#0F172A] truncate">${escapeHtml(ruta.puntoNombre || 'Punto')}</span>
                            </div>
                            <div class="shrink-0">${estadoHtml}</div>
                        </div>
                    `;
                });
            }

            const motivoConteo = { "Fuera de horario": 0, "Fuera de rango GPS": 0, "QR no programado hoy": 0 };
            regsDia.forEach(r => {
                if (r.severidad === "OK") return;
                const estKey = r.estado || "";
                if (motivoConteo[estKey] !== undefined) motivoConteo[estKey]++;
                else if (r.severidad === "CRITICO") motivoConteo["QR no programado hoy"]++;
            });
            const totalIncidencias = Object.values(motivoConteo).reduce((a, b) => a + b, 0);
            document.getElementById('resumen-motivos-total').textContent = `${totalIncidencias} incidencias`;

            const containerMotivos = document.getElementById('lista-motivos-alerta');
            containerMotivos.innerHTML = '';
            for (const [motivo, cant] of Object.entries(motivoConteo)) {
                const pct = totalIncidencias > 0 ? Math.round((cant / totalIncidencias) * 100) : 0;
                containerMotivos.innerHTML += `
                    <div class="space-y-1">
                        <div class="flex justify-between text-xs">
                            <span class="text-[#334155]">${motivo}</span>
                            <strong class="font-mono-val text-[#0F172A]">${cant}</strong>
                        </div>
                        <div class="w-full h-1.5 bg-[#F1F5F9] rounded-full overflow-hidden">
                            <div class="h-full bg-[#DC2626]" style="width:${pct}%"></div>
                        </div>
                    </div>
                `;
            }

            const operadoresActivos = operadoresCache.filter(op => op.activo !== false);
            const containerOps = document.getElementById('lista-cumplimiento-operadores');
            containerOps.innerHTML = '';
            if (operadoresActivos.length === 0) {
                containerOps.innerHTML = '<p class="text-xs text-slate-400 py-2">Sin operadores activos.</p>';
            } else {
                operadoresActivos.forEach(op => {
                    const escaneosOp = regsDia.filter(r => r.operador === op.nombre);
                    const validosOp = escaneosOp.filter(r => r.severidad === "OK").length;
                    const criticosOp = escaneosOp.filter(r => r.severidad === "CRITICO").length;
                    const totalOp = escaneosOp.length;
                    const pctOp = totalOp > 0 ? Math.round((validosOp / totalOp) * 100) : 0;

                    containerOps.innerHTML += `
                        <div class="space-y-1.5">
                            <div class="flex justify-between items-center text-xs">
                                <div class="flex items-center gap-2 min-w-0">
                                    <div class="w-7 h-7 rounded-full bg-[#F1F5F9] text-[#0F172A] font-semibold text-[10px] flex items-center justify-center shrink-0">${escapeHtml(obtenerIniciales(op.nombre))}</div>
                                    <span class="font-medium text-[#0F172A] truncate">${escapeHtml(op.nombre)}</span>
                                </div>
                                <span class="font-mono-val font-semibold text-[#0F172A]">${pctOp}%</span>
                            </div>
                            <div class="w-full h-1.5 bg-[#F1F5F9] rounded-full overflow-hidden">
                                <div class="h-full bg-[#0F172A]" style="width:${pctOp}%"></div>
                            </div>
                            <div class="flex justify-between text-[11px] text-[#64748B]">
                                <span>${validosOp} válidos · <span class="text-[#B91C1C]">${criticosOp} críticos</span></span>
                                <span class="font-mono-val">${totalOp} total</span>
                            </div>
                        </div>
                    `;
                });
            }
        }

        window.abrirDrawerDetalle = (r) => {
            document.getElementById('drawer-titulo-punto').textContent = r.puntoNombre || "Punto de Control";
            const pt = puntosCache[r.codigoQR];
            const codigoPt = pt ? pt.codigo : (r.codigoQR || "—");
            document.getElementById('drawer-subtitulo-meta').textContent = `${codigoPt} · ${r.operador || 'Operador'} · ${r.fechaTexto || r.fechaISO || '—'}`;

            const banner = document.getElementById('drawer-banner-estado');
            const iconFs = document.getElementById('drawer-banner-icono');
            const titFs = document.getElementById('drawer-banner-titulo');
            const txtFs = document.getElementById('drawer-banner-texto');

            if (r.severidad === "OK") {
                banner.className = "p-3.5 rounded-md border bg-[#ECFDF5] border-[#059669]/30 text-[#047857] flex items-start gap-3";
                iconFs.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
                titFs.textContent = "Escaneo válido";
                txtFs.textContent = "Se cumplieron todas las condiciones horarias y de ubicación GPS.";
            } else if (r.severidad === "ADVERTENCIA") {
                banner.className = "p-3.5 rounded-md border bg-[#FFFBEB] border-[#D97706]/30 text-[#92400E] flex items-start gap-3";
                iconFs.innerHTML = '<i class="fa-solid fa-clock"></i>';
                titFs.textContent = "Fuera de horario";
                txtFs.textContent = "Ubicación GPS correcta, pero el escaneo está fuera del margen de tiempo permitido.";
            } else {
                banner.className = "p-3.5 rounded-md border bg-[#FEF2F2] border-[#DC2626]/30 text-[#B91C1C] flex items-start gap-3";
                iconFs.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
                titFs.textContent = `Crítico · ${r.estado || 'Revisar'}`;
                txtFs.textContent = "Se detectó una incidencia que requiere revisión de supervisión.";
            }

            const listaValidacion = document.getElementById('drawer-lista-validaciones');
            const qrReg = !!pt;
            const progHoy = r.horarioProgramado && r.horarioProgramado !== "Sin agenda";
            const toler = obtenerToleranciaRegistro(r, pt);
            const distanciaMedida = r.distancia !== undefined ? r.distancia : r.gpsDist;
            const gpsOk = distanciaMedida !== undefined && distanciaMedida !== null && !isNaN(distanciaMedida) && distanciaMedida <= toler;
            const horaOk = r.severidad !== "ADVERTENCIA";

            listaValidacion.innerHTML = `
                <div class="p-3 flex justify-between items-center">
                    <span class="flex items-center gap-2 text-[#334155]"><i class="fa-solid ${qrReg ? 'fa-check text-[#059669]' : 'fa-xmark text-[#DC2626]'}"></i> QR registrado en el sistema</span>
                    <span class="text-[#64748B]">${qrReg ? 'Correcto' : 'Falló'}</span>
                </div>
                <div class="p-3 flex justify-between items-center">
                    <span class="flex items-center gap-2 text-[#334155]"><i class="fa-solid ${progHoy ? 'fa-check text-[#059669]' : 'fa-minus text-[#94A3B8]'}"></i> Programado para hoy</span>
                    <span class="text-[#64748B]">${progHoy ? 'Correcto' : 'No aplica'}</span>
                </div>
                <div class="p-3 flex justify-between items-center">
                    <span class="flex items-center gap-2 text-[#334155]"><i class="fa-solid ${gpsOk ? 'fa-check text-[#059669]' : 'fa-xmark text-[#DC2626]'}"></i> Dentro del radio GPS</span>
                    <span class="text-[#64748B]">${gpsOk ? 'Correcto' : 'Falló'}</span>
                </div>
                <div class="p-3 flex justify-between items-center">
                    <span class="flex items-center gap-2 text-[#334155]"><i class="fa-solid ${horaOk ? 'fa-check text-[#059669]' : 'fa-xmark text-[#DC2626]'}"></i> Dentro del margen horario</span>
                    <span class="text-[#64748B]">${horaOk ? 'Correcto' : 'Falló'}</span>
                </div>
            `;

            const [_, horaEsc] = r.fechaTexto ? r.fechaTexto.split(' ') : ["", "—"];
            document.getElementById('drawer-tech-hora').textContent = horaEsc || "—";
            document.getElementById('drawer-tech-prog').textContent = r.horarioProgramado || "—";
            document.getElementById('drawer-tech-dist').textContent = distanciaMedida !== undefined && distanciaMedida !== null && !isNaN(distanciaMedida) ? `${distanciaMedida} m / ${toler} m` : "—";
            document.getElementById('drawer-tech-coords').textContent = pt ? `${pt.lat}, ${pt.lng}` : "—";

            const mapPuntoGps = document.getElementById('drawer-punto-gps-mapa');
            const dist = distanciaMedida || 0;
            const offsetPx = Math.min(70, Math.round((dist / toler) * 35));
            mapPuntoGps.style.transform = `translate(${offsetPx}px, -${offsetPx}px)`;
            mapPuntoGps.className = `absolute w-3 h-3 rounded-full ${gpsOk ? 'bg-emerald-600' : 'bg-red-600'} ring-4 ring-white shadow-sm transition-all`;

            document.getElementById('drawer-overlay').classList.remove('hidden');
            document.getElementById('drawer-detalle').classList.remove('translate-x-full');
        };

        window.cerrarDrawerDetalle = () => {
            document.getElementById('drawer-overlay').classList.add('hidden');
            document.getElementById('drawer-detalle').classList.add('translate-x-full');
        };

        function agregarCapasBase(mapa) {
            if (!window.L) return;
            const satelite = window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 20,
                attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
            });
            const etiquetas = window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 20,
                attribution: 'Labels &copy; Esri'
            });
            const calles = window.L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
                maxZoom: 19,
                attribution: 'Tiles &copy; Esri'
            });
            const osm = window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
            });
            satelite.addTo(mapa);
            etiquetas.addTo(mapa);
            window.L.control.layers(
                { 'Satélite': satelite, 'Calles (Esri)': calles, 'OpenStreetMap': osm },
                { 'Etiquetas': etiquetas },
                { position: 'topright', collapsed: true }
            ).addTo(mapa);
        }

        window.abrirModalMapaRuta = () => {
            const modal = document.getElementById('modal-mapa-ruta');
            if (Object.keys(puntosCache).length === 0) {
                return mostrarMensajeForm('msg-ruta', 'Primero creá al menos un punto de control.', 'error');
            }

            const seleccionActual = document.getElementById('ruta-punto').value;
            codigosMapaRutaPendientes = new Set(seleccionActual ? seleccionActual.split(',').filter(Boolean) : []);
            modal.classList.remove('hidden');
            actualizarPuntosMapaRuta();
            if (!window.L) {
                document.getElementById('mapa-puntos-aviso').textContent = 'No se pudo cargar el mapa. Podés elegir el punto desde la lista.';
                document.getElementById('mapa-puntos-aviso').classList.remove('hidden');
                return;
            }

            const contenedor = document.getElementById('mapa-puntos-ruta');
            if (!mapaPuntosRutas) {
                mapaPuntosRutas = window.L.map(contenedor, { scrollWheelZoom: true });
                agregarCapasBase(mapaPuntosRutas);
                capaPuntosRutas = window.L.featureGroup().addTo(mapaPuntosRutas);
            }

            actualizarPuntosMapaRuta();
            actualizarSeleccionMapaRuta();
            requestAnimationFrame(() => {
                mapaPuntosRutas.invalidateSize();
                const bounds = capaPuntosRutas.getBounds();
                if (bounds.isValid()) mapaPuntosRutas.fitBounds(bounds, { padding: [24, 24], maxZoom: 18 });
                else mapaPuntosRutas.setView([-32.851, -61.154], 13);
            });
        };

        window.cerrarModalMapaRuta = () => {
            document.getElementById('modal-mapa-ruta').classList.add('hidden');
        };

        document.getElementById('modal-mapa-ruta').addEventListener('click', evento => {
            if (evento.target === evento.currentTarget) cerrarModalMapaRuta();
        });
        const modalMapaPuntos = document.getElementById('modal-mapa-puntos');
        if (modalMapaPuntos) {
            modalMapaPuntos.addEventListener('click', evento => {
                if (evento.target === evento.currentTarget) cerrarModalMapaPuntos();
            });
        }

        window.confirmarPuntoMapaRuta = () => {
            const puntos = [...codigosMapaRutaPendientes].map(codigo => puntosCache[codigo]).filter(Boolean);
            if (puntos.length === 0) return;
            document.getElementById('ruta-punto').value = puntos.map(punto => punto.codigo).join(',');
            const elegido = document.getElementById('ruta-punto-seleccionado');
            elegido.textContent = `${puntos.length} punto(s): ${puntos.map(punto => punto.nombre).join(', ')}`;
            elegido.className = 'text-xs font-semibold text-[#0F172A]';
            cerrarModalMapaRuta();
        };

        window.abrirModalMapaPuntos = () => {
            const modal = document.getElementById('modal-mapa-puntos');
            if (!modal) return;
            if (Object.keys(puntosCache).length === 0) {
                return mostrarAvisoPanel('Primero creá al menos un punto de control.', 'warn');
            }
            modal.classList.remove('hidden');
            actualizarMapaPuntos();
            if (!window.L) {
                const aviso = document.getElementById('mapa-puntos-admin-aviso');
                if (aviso) {
                    aviso.textContent = 'No se pudo cargar el mapa. Podés ver la lista de puntos en la tabla.';
                    aviso.classList.remove('hidden');
                }
                return;
            }
            const contenedor = document.getElementById('mapa-puntos');
            if (!mapaPuntos) {
                mapaPuntos = window.L.map(contenedor, { scrollWheelZoom: true });
                agregarCapasBase(mapaPuntos);
                capaPuntos = window.L.featureGroup().addTo(mapaPuntos);
            }
            actualizarMapaPuntos();
            requestAnimationFrame(() => {
                if (!mapaPuntos) return;
                mapaPuntos.invalidateSize();
                if (capaPuntos && capaPuntos.getLayers().length > 0) {
                    mapaPuntos.fitBounds(capaPuntos.getBounds(), { padding: [24, 24], maxZoom: 18 });
                } else {
                    mapaPuntos.setView([-32.851, -61.154], 13);
                }
            });
        };

        window.cerrarModalMapaPuntos = () => {
            const modal = document.getElementById('modal-mapa-puntos');
            if (modal) modal.classList.add('hidden');
        };

        function iconoPuntoMapa() {
            return window.L.divIcon({
                className: 'marcador-ruta-contenedor',
                html: '<span class="marcador-ruta"></span>',
                iconSize: [23, 23],
                iconAnchor: [11, 23]
            });
        }

        window.editarUbicacionPunto = async (id) => {
            const p = Object.values(puntosCache).find(x => x.id === id);
            if (!p) return mostrarAvisoPanel('No se encontró el punto de control.', 'error');
            const lat = prompt(`Nueva latitud para ${p.nombre} (actual: ${p.lat}):`, p.lat);
            if (lat === null) return;
            const lng = prompt(`Nueva longitud para ${p.nombre} (actual: ${p.lng}):`, p.lng);
            if (lng === null) return;
            const tol = prompt(`Radio permitido en metros (actual: ${p.tolerancia || 25}):`, p.tolerancia || 25);
            if (tol === null) return;
            const latNum = Number(lat);
            const lngNum = Number(lng);
            const tolNum = Number(tol);
            if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90) return mostrarAvisoPanel('Latitud inválida.', 'error');
            if (!Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180) return mostrarAvisoPanel('Longitud inválida.', 'error');
            if (!Number.isFinite(tolNum) || tolNum < 10 || tolNum > 100) return mostrarAvisoPanel('El radio debe estar entre 10 y 100 m.', 'error');
            try {
                await updateDoc(doc(db, 'puntos_control', id), { lat: latNum, lng: lngNum, tolerancia: tolNum });
                await cargarPuntos();
                renderizarPuntosAdmin();
                if (mapaPuntos) actualizarMapaPuntos();
                mostrarAvisoPanel(`Ubicación de "${p.nombre}" actualizada.`, 'ok');
            } catch (e) {
                console.error('[Puntos] Error al editar la ubicación:', e);
                mostrarAvisoPanel('No se pudo actualizar la ubicación. Revisá la conexión y las reglas de Firestore.', 'error');
            }
        };

        function actualizarMapaPuntos() {
            const lista = document.getElementById('lista-puntos-mapa-admin');
            if (capaPuntos) capaPuntos.clearLayers();
            if (lista) lista.replaceChildren();
            const puntos = Object.values(puntosCache).sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));
            const sinCoordenadas = [];
            puntos.forEach(p => {
                const boton = document.createElement('button');
                boton.type = 'button';
                boton.className = 'w-full text-left px-2.5 py-2 rounded-md border border-[#E2E8F0] hover:border-[#0F172A] hover:bg-slate-50 text-xs transition';
                boton.textContent = `${p.nombre || 'Punto'} (${p.codigo})${coordenadasValidasPunto(p) ? '' : ' · sin coordenadas'}`;
                boton.addEventListener('click', () => {
                    if (!coordenadasValidasPunto(p) || !mapaPuntos || !capaPuntos) return;
                    const marcador = capaPuntos.getLayers().find(m => m.options.codigoPunto === p.codigo);
                    if (marcador) {
                        mapaPuntos.setView(marcador.getLatLng(), Math.max(mapaPuntos.getZoom(), 16));
                        marcador.openPopup();
                    }
                });
                if (lista) lista.appendChild(boton);

                if (!coordenadasValidasPunto(p)) {
                    sinCoordenadas.push(p.nombre || p.codigo);
                    return;
                }
                if (!capaPuntos || !window.L) return;
                const lat = Number(p.lat);
                const lng = Number(p.lng);
                const contenido = document.createElement('div');
                contenido.className = 'space-y-2 text-xs';
                const titulo = document.createElement('strong');
                titulo.textContent = p.nombre || 'Punto de control';
                titulo.className = 'block text-sm text-[#0F172A]';
                const codigo = document.createElement('div');
                codigo.className = 'text-slate-500 font-mono-val';
                codigo.textContent = p.codigo;
                const coords = document.createElement('div');
                coords.textContent = `${lat}, ${lng} · radio ${Number(p.tolerancia) || 25} m`;
                const rutasPt = rutasCache.filter(r => r.codigoQR === p.codigo);
                const horarios = document.createElement('div');
                horarios.className = 'text-slate-500';
                horarios.textContent = rutasPt.length ? `Horarios: ${rutasPt.map(r => `${r.dia} ${r.hora}`).join(', ')}` : 'Sin horarios programados (ronda libre)';
                const acciones = document.createElement('div');
                acciones.className = 'flex flex-wrap gap-1.5 pt-1';
                function botonAccion(texto, clase, onClick) {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'h-7 px-2 rounded border text-xs font-semibold transition ' + clase;
                    b.textContent = texto;
                    b.addEventListener('click', onClick);
                    return b;
                }
                acciones.append(
                    botonAccion('Editar nombre', 'border-[#E2E8F0] bg-white hover:bg-slate-50 text-[#334155]', () => editarNombrePunto(p.id)),
                    botonAccion('Editar ubicación', 'border-[#E2E8F0] bg-white hover:bg-slate-50 text-[#334155]', () => editarUbicacionPunto(p.id)),
                    botonAccion('QR', 'border-[#E2E8F0] bg-white hover:bg-slate-50 text-[#334155]', () => abrirModalQRPorId(p.id)),
                    botonAccion('Eliminar', 'border-red-200 bg-white hover:bg-red-50 text-red-600', () => eliminarPunto(p.id))
                );
                contenido.append(titulo, codigo, coords, horarios, acciones);

                const marcador = window.L.marker([lat, lng], {
                    title: `${p.nombre || 'Punto'} (${p.codigo})`,
                    alt: `Punto ${p.nombre || p.codigo}`,
                    codigoPunto: p.codigo
                });
                marcador.options.codigoPunto = p.codigo;
                marcador.setIcon(iconoPuntoMapa());
                marcador.bindPopup(contenido, { maxWidth: 260 });
                capaPuntos.addLayer(marcador);
            });

            const aviso = document.getElementById('mapa-puntos-aviso');
            if (aviso) {
                if (sinCoordenadas.length > 0) {
                    aviso.textContent = `No aparecen en el mapa porque les faltan coordenadas: ${sinCoordenadas.join(', ')}.`;
                    aviso.classList.remove('hidden');
                } else {
                    aviso.textContent = '';
                    aviso.classList.add('hidden');
                }
            }
            if (mapaPuntos) {
                if (capaPuntos.getLayers().length > 0) {
                    mapaPuntos.fitBounds(capaPuntos.getBounds(), { padding: [24, 24], maxZoom: 18 });
                } else {
                    mapaPuntos.setView([-32.851, -61.154], 13);
                }
            }
        }

        function seleccionarPuntoMapaRuta(codigo) {
            if (codigosMapaRutaPendientes.has(codigo)) codigosMapaRutaPendientes.delete(codigo);
            else codigosMapaRutaPendientes.add(codigo);
            actualizarSeleccionMapaRuta();
            const marcador = capaPuntosRutas && capaPuntosRutas.getLayers().find(m => m.options.codigoPunto === codigo);
            if (marcador) {
                marcador.openPopup();
            }
        }

        function iconoPuntoMapaRuta(seleccionado) {
            return window.L.divIcon({
                className: 'marcador-ruta-contenedor',
                html: `<span class="marcador-ruta${seleccionado ? ' seleccionado' : ''}"></span>`,
                iconSize: [29, 34],
                iconAnchor: [14, 31]
            });
        }

        function coordenadasValidasPunto(punto) {
            if (!punto || punto.lat === null || punto.lat === '' || punto.lng === null || punto.lng === '') return false;
            const lat = Number(punto.lat);
            const lng = Number(punto.lng);
            return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
        }

        function actualizarPuntosMapaRuta() {
            const lista = document.getElementById('lista-puntos-mapa');
            const selectRuta = document.getElementById('ruta-punto');
            if (!lista || !selectRuta) return;

            if (capaPuntosRutas) capaPuntosRutas.clearLayers();
            lista.replaceChildren();
            const puntos = Object.values(puntosCache).sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));
            const sinCoordenadas = [];

            puntos.forEach(p => {
                const lat = Number(p.lat);
                const lng = Number(p.lng);
                const tieneCoordenadas = coordenadasValidasPunto(p);
                const boton = document.createElement('button');
                boton.type = 'button';
                boton.dataset.codigo = p.codigo;
                boton.className = 'w-full text-left px-2.5 py-2 rounded-md border border-[#E2E8F0] hover:border-[#0F172A] hover:bg-slate-50 text-xs transition';
                boton.textContent = `${p.nombre || 'Punto'} (${p.codigo})${tieneCoordenadas ? '' : ' · sin coordenadas'}`;
                boton.disabled = !tieneCoordenadas;
                boton.classList.toggle('opacity-50', !tieneCoordenadas);
                boton.addEventListener('click', () => seleccionarPuntoMapaRuta(p.codigo));
                lista.appendChild(boton);

                if (!tieneCoordenadas) {
                    sinCoordenadas.push(p.nombre || p.codigo);
                    return;
                }
                if (!capaPuntosRutas) return;

                const contenido = document.createElement('div');
                const titulo = document.createElement('strong');
                titulo.textContent = p.nombre || 'Punto de control';
                const codigo = document.createElement('div');
                codigo.className = 'text-xs text-slate-500';
                codigo.textContent = p.codigo;
                contenido.append(titulo, codigo);

                const marcador = window.L.marker([lat, lng], {
                    title: `${p.nombre || 'Punto'} (${p.codigo})`,
                    alt: `Punto ${p.nombre || p.codigo}`,
                    icon: iconoPuntoMapaRuta(codigosMapaRutaPendientes.has(p.codigo))
                });
                marcador.options.codigoPunto = p.codigo;
                marcador.bindPopup(contenido);
                marcador.on('click', () => seleccionarPuntoMapaRuta(p.codigo));
                capaPuntosRutas.addLayer(marcador);
            });

            const aviso = document.getElementById('mapa-puntos-aviso');
            if (sinCoordenadas.length > 0) {
                aviso.textContent = `No aparecen en el mapa porque les faltan coordenadas: ${sinCoordenadas.join(', ')}.`;
                aviso.classList.remove('hidden');
            } else {
                aviso.textContent = '';
                aviso.classList.add('hidden');
            }

            actualizarSeleccionMapaRuta();
            if (mapaPuntosRutas) enfocarPuntosMapaRuta();
        }

        function actualizarSeleccionMapaRuta() {
            const puntos = [...codigosMapaRutaPendientes].map(codigo => puntosCache[codigo]).filter(Boolean);
            const etiqueta = document.getElementById('mapa-punto-elegido');
            const confirmar = document.getElementById('btn-confirmar-punto-mapa');
            if (etiqueta) etiqueta.textContent = puntos.length ? `Seleccionados (${puntos.length}): ${puntos.map(punto => punto.nombre).join(', ')}` : 'Todavía no seleccionaste puntos.';
            if (confirmar) confirmar.disabled = puntos.length === 0;

            const lista = document.getElementById('lista-puntos-mapa');
            if (lista) {
                Array.from(lista.children).forEach(boton => {
                    const seleccionado = codigosMapaRutaPendientes.has(boton.dataset.codigo);
                    boton.classList.toggle('border-emerald-600', Boolean(seleccionado));
                    boton.classList.toggle('bg-emerald-50', Boolean(seleccionado));
                });
            }

            if (capaPuntosRutas) {
                capaPuntosRutas.eachLayer(marcador => {
                    marcador.setIcon(iconoPuntoMapaRuta(codigosMapaRutaPendientes.has(marcador.options.codigoPunto)));
                });
            }
        }

        function enfocarPuntosMapaRuta() {
            if (!mapaPuntosRutas || !capaPuntosRutas || capaPuntosRutas.getLayers().length === 0) {
                if (mapaPuntosRutas) mapaPuntosRutas.setView([-32.851, -61.154], 13);
                return;
            }
            const seleccionados = capaPuntosRutas.getLayers().filter(m => codigosMapaRutaPendientes.has(m.options.codigoPunto));
            if (seleccionados.length === 1) {
                mapaPuntosRutas.setView(seleccionados[0].getLatLng(), Math.max(mapaPuntosRutas.getZoom(), 15));
            } else if (seleccionados.length > 1) {
                const grupo = window.L.featureGroup(seleccionados);
                mapaPuntosRutas.fitBounds(grupo.getBounds(), { padding: [24, 24], maxZoom: 18 });
            } else {
                mapaPuntosRutas.fitBounds(capaPuntosRutas.getBounds(), { padding: [24, 24], maxZoom: 18 });
            }
        }

        function renderizarPuntosAdmin() {
            const tbody = document.getElementById('tabla-puntos-admin-body');
            if (!tbody) return;
            tbody.innerHTML = '';
            const codigos = Object.keys(puntosCache);
            if (codigos.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" class="py-8 text-center text-slate-400">Sin puntos registrados.</td></tr>';
                return;
            }

            codigos.forEach(cod => {
                const p = puntosCache[cod];
                const rutasPt = rutasCache.filter(r => r.codigoQR === cod);
                const diasArr = [...new Set(rutasPt.map(r => r.dia))];
                const diasTxt = diasArr.length === 0 ? "Sin agendar" : (diasArr.length >= 7 ? "L–D" : diasArr.join(', '));

                let horariosChips = '';
                if (rutasPt.length === 0) horariosChips = `<span class="text-[#64748B]">Ronda libre</span>`;
                else rutasPt.forEach(rp => horariosChips += `<span class="inline-block px-1.5 py-0.5 rounded border border-[#E2E8F0] bg-[#F8FAFC] font-mono-val text-[11px] mr-1 mb-1">${escapeHtml(rp.hora)}</span>`);

                tbody.innerHTML += `
                    <tr class="hover:bg-[#F8FAFC] transition">
                        <td class="py-3.5 px-5">
                            <strong class="font-medium text-[#0F172A] block">${escapeHtml(p.nombre)}</strong>
                            <span class="text-[12px] text-[#94A3B8] font-mono-val">${escapeHtml(p.codigo)}</span>
                        </td>
                        <td class="py-3.5 px-5 font-mono-val text-xs text-[#334155]">${escapeHtml(p.lat ?? 0)}, ${escapeHtml(p.lng ?? 0)}</td>
                        <td class="py-3.5 px-5 font-mono-val text-xs text-[#334155]">${Number(p.tolerancia) || 25} m</td>
                        <td class="py-3.5 px-5 text-xs text-[#334155]">${escapeHtml(diasTxt)}</td>
                        <td class="py-3.5 px-5">${horariosChips}</td>
                        <td class="py-3.5 px-5 text-right space-x-1">
                            <button onclick="abrirModalQRPorId('${p.id}')" class="h-8 px-2.5 bg-white border border-[#E2E8F0] hover:bg-slate-50 rounded text-xs font-semibold text-[#334155]"><i class="fa-solid fa-qrcode mr-1"></i> QR</button>
                            <button onclick="editarNombrePunto('${p.id}')" title="Editar nombre del punto" class="h-8 px-2 bg-white border border-[#E2E8F0] hover:bg-slate-50 rounded text-xs text-[#334155]"><i class="fa-solid fa-pen"></i></button>
                            <button onclick="eliminarPunto('${p.id}')" class="h-8 px-2 bg-white border border-red-200 hover:bg-red-50 rounded text-xs text-red-600"><i class="fa-solid fa-trash"></i></button>
                        </td>
                    </tr>
                `;
            });
        }

        window.renderizarRutasAdmin = () => {
            const contenedor = document.getElementById('tabla-rutas-admin-body');
            const filtro = document.getElementById('filtro-dia-rutas').value;
            if (!contenedor) return;
            contenedor.innerHTML = '';

            const rutasFiltradas = rutasCache.filter(r => filtro === "TODOS" || r.dia === filtro || r.dia === "Todos");
            if (rutasFiltradas.length === 0) {
                contenedor.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-slate-400">Sin horarios agendados para este filtro.</td></tr>';
                return;
            }

            rutasFiltradas.forEach(r => {
                contenedor.innerHTML += `<tr class="border-b border-[#F1F5F9] text-sm"><td class="py-3 px-5">${escapeHtml(r.dia)}</td><td class="py-3 px-5 font-mono-val">${escapeHtml(r.hora)}</td><td class="py-3 px-5">${escapeHtml(r.puntoNombre || 'Punto')}</td><td class="py-3 px-5">±${Number(r.margen) || 15} min</td><td class="py-3 px-5 text-right"><button onclick="eliminarRuta('${r.id}')" class="text-red-500 hover:text-red-700 font-semibold px-2 py-1" aria-label="Eliminar horario"><i class="fa-solid fa-trash"></i></button></td></tr>`;
            });
        };

        window.toggleDiaSel = (btn) => {
            const dia = btn.getAttribute('data-dia');
            if (diasSeleccionadosForm.includes(dia)) {
                diasSeleccionadosForm = diasSeleccionadosForm.filter(d => d !== dia);
                btn.className = "h-9 rounded border border-[#E2E8F0] text-xs font-semibold hover:border-[#0F172A] transition";
            } else {
                diasSeleccionadosForm.push(dia);
                btn.className = "h-9 rounded border border-[#0F172A] bg-[#0F172A] text-white text-xs font-semibold transition";
            }
        };

        window.crearPuntoConGPS = () => {
            const nombre = document.getElementById('punto-nombre').value.trim();
            const tolerancia = parseInt(document.getElementById('punto-tolerancia').value) || 25;
            if (!nombre) return mostrarMensajeForm('msg-punto', "Ingresá el nombre del punto primero.", 'error');
            if (existePuntoConNombre(nombre)) {
                return mostrarMensajeForm('msg-punto', `Ya existe un punto llamado "${nombre}".`, 'error');
            }
            if (Object.keys(puntosCache).length >= MAX_PUNTOS) {
                return mostrarMensajeForm('msg-punto', `Límite alcanzado: no se pueden crear más de ${MAX_PUNTOS} puntos de control.`, 'error');
            }
            if (!navigator.geolocation) return mostrarMensajeForm('msg-punto', "Este dispositivo no soporta geolocalización.", 'error');

            navigator.geolocation.getCurrentPosition(async (pos) => {
                try {
                    const codigo = generarCodigoPuntoUnico();
                    await addDoc(collection(db, "puntos_control"), {
                        codigo, nombre, tolerancia,
                        lat: parseFloat(pos.coords.latitude.toFixed(5)),
                        lng: parseFloat(pos.coords.longitude.toFixed(5))
                    });
                    document.getElementById('punto-nombre').value = '';
                    document.getElementById('btn-gps-txt').textContent = `Ubicación capturada · ±${Math.round(pos.coords.accuracy)} m`;
                    await cargarPuntos();
                    renderizarPuntosAdmin();
                    mostrarMensajeForm('msg-punto', `Punto "${nombre}" creado con código ${codigo}.`, 'ok');
                } catch (e) {
                    console.error('[Puntos] Error al crear punto:', e);
                    mostrarMensajeForm('msg-punto', "No se pudo crear el punto. Revisá la conexión y las reglas de Firestore.", 'error');
                }
            }, () => mostrarMensajeForm('msg-punto', "No se pudo obtener la ubicación actual.", 'error'), { enableHighAccuracy: true });
        };

        window.guardarPuntoManual = async () => {
            const nombre = document.getElementById('punto-nombre').value.trim();
            const lat = parseFloat(document.getElementById('punto-lat').value);
            const lng = parseFloat(document.getElementById('punto-lng').value);
            const tolerancia = parseInt(document.getElementById('punto-tolerancia').value) || 25;
            if (!nombre || isNaN(lat) || isNaN(lng)) return mostrarMensajeForm('msg-punto', "Completá nombre, latitud y longitud.", 'error');
            if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return mostrarMensajeForm('msg-punto', "Latitud o longitud fuera de rango.", 'error');
            if (existePuntoConNombre(nombre)) {
                return mostrarMensajeForm('msg-punto', `Ya existe un punto llamado "${nombre}".`, 'error');
            }
            if (Object.keys(puntosCache).length >= MAX_PUNTOS) {
                return mostrarMensajeForm('msg-punto', `Límite alcanzado: no se pueden crear más de ${MAX_PUNTOS} puntos de control.`, 'error');
            }

            try {
                const codigo = generarCodigoPuntoUnico();
                await addDoc(collection(db, "puntos_control"), { codigo, nombre, tolerancia, lat, lng });
                document.getElementById('punto-nombre').value = '';
                document.getElementById('punto-lat').value = '';
                document.getElementById('punto-lng').value = '';
                await cargarPuntos();
                renderizarPuntosAdmin();
                if (mapaPuntos) actualizarMapaPuntos();
                mostrarMensajeForm('msg-punto', `Punto "${nombre}" creado con código ${codigo}.`, 'ok');
            } catch (e) {
                console.error('[Puntos] Error al crear punto manual:', e);
                mostrarMensajeForm('msg-punto', "No se pudo crear el punto. Revisá la conexión y las reglas de Firestore.", 'error');
            }
        };

        window.agregarHorarioRuta = async () => {
            const codigosQR = document.getElementById('ruta-punto').value.split(',').filter(Boolean);
            const hora = document.getElementById('ruta-hora').value;
            const margen = parseInt(document.getElementById('ruta-margen').value) || 15;
            if (codigosQR.length === 0 || !hora || diasSeleccionadosForm.length === 0) return mostrarMensajeForm('msg-ruta', "Seleccioná puntos, días y hora.", 'error');
            if (margen < 1 || margen > 120) return mostrarMensajeForm('msg-ruta', "El margen debe estar entre 1 y 120 minutos.", 'error');

            const conflictos = [];
            codigosQR.forEach(codigoQR => {
                const punto = puntosCache[codigoQR];
                diasSeleccionadosForm.forEach(dia => {
                    if (rutasCache.some(r => r.codigoQR === codigoQR && r.dia === dia && String(r.hora || '') === String(hora))) {
                        conflictos.push(`${punto ? punto.nombre : codigoQR} (${dia})`);
                    }
                });
            });
            if (conflictos.length > 0) {
                return mostrarMensajeForm('msg-ruta', `Ya existe un horario ${hora} para: ${conflictos.join(', ')}.`, 'error');
            }

            try {
                const batch = writeBatch(db);
                codigosQR.forEach(codigoQR => {
                    const punto = puntosCache[codigoQR];
                    const puntoNombre = punto ? punto.nombre : codigoQR;
                    diasSeleccionadosForm.forEach(dia => {
                        const ref = doc(collection(db, "rutas_horarias"));
                        batch.set(ref, { dia, codigoQR, puntoNombre, hora, margen });
                    });
                });
                await batch.commit();
                await cargarRutas();
                renderizarRutasAdmin();
                renderizarPuntosAdmin();
                mostrarMensajeForm('msg-ruta', `Se programaron ${codigosQR.length} punto(s) a las ${hora} en ${diasSeleccionadosForm.length} día(s).`, 'ok');
            } catch (e) {
                console.error('[Rutas] Error al agendar horario:', e);
                mostrarMensajeForm('msg-ruta', "No se pudo agendar el horario. Revisá la conexión y las reglas de Firestore.", 'error');
            }
        };

        function renderizarPersonalAdmin() {
            const tbody = document.getElementById('tabla-operadores-admin-body');
            tbody.innerHTML = '';
            if (operadoresCache.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400">Sin personal registrado.</td></tr>';
                return;
            }

            const fechaSel = obtenerFechaFiltroISO();
            const regsDia = registrosAdminCache.filter(r => r.fechaISO === fechaSel);

            operadoresCache.forEach(op => {
                const escaneosOp = regsDia.filter(r => r.operador === op.nombre);
                const validosOp = escaneosOp.filter(r => r.severidad === "OK").length;
                const totalOp = escaneosOp.length;
                const pctOp = totalOp > 0 ? Math.round((validosOp / totalOp) * 100) : 0;
                const activo = op.activo !== false;

                const estadoHtml = activo
                    ? `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-[#ECFDF5] text-[#047857]"><span class="w-1.5 h-1.5 rounded-full bg-[#059669]"></span> Activo</span>`
                    : `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-[#F1F5F9] text-[#64748B]"><span class="w-1.5 h-1.5 rounded-full bg-[#94A3B8]"></span> Inactivo</span>`;

                const toggleHtml = activo
                    ? `<button onclick="toggleOperadorActivo('${op.id}', false)" title="Desactivar operador" class="h-8 px-2 text-slate-400 hover:text-amber-600 rounded"><i class="fa-solid fa-user-slash text-xs"></i></button>`
                    : `<button onclick="toggleOperadorActivo('${op.id}', true)" title="Activar operador" class="h-8 px-2 text-slate-400 hover:text-emerald-600 rounded"><i class="fa-solid fa-user-check text-xs"></i></button>`;

                tbody.innerHTML += `
                    <tr class="hover:bg-[#F8FAFC] transition">
                        <td class="py-3.5 px-5">
                            <div class="flex items-center gap-3">
                                <div class="w-8 h-8 rounded-full bg-[#F1F5F9] text-[#0F172A] text-xs font-semibold flex items-center justify-center">${escapeHtml(obtenerIniciales(op.nombre))}</div>
                                <div>
                                    <strong class="font-medium text-[#0F172A] block">${escapeHtml(op.nombre)}</strong>
                                    <span class="text-[11px] text-[#94A3B8] font-mono-val">Legajo ${escapeHtml(op.legajo || "0112")}</span>
                                </div>
                            </div>
                        </td>
                        <td class="py-3.5 px-5 text-xs text-[#334155] font-medium">${escapeHtml(op.turno || "Mañana")}</td>
                        <td class="py-3.5 px-5">
                            <div class="space-y-1">
                                <span class="font-mono-val text-xs text-[#0F172A]">${totalOp} ${totalOp === 1 ? 'escaneo' : 'escaneos'}</span>
                                <div class="w-28 h-1.5 bg-[#F1F5F9] rounded-full overflow-hidden">
                                    <div class="h-full bg-[#0F172A]" style="width:${pctOp}%"></div>
                                </div>
                            </div>
                        </td>
                        <td class="py-3.5 px-5 font-mono-val text-xs ${pctOp >= 80 ? 'text-[#059669]' : pctOp >= 50 ? 'text-[#B45309]' : 'text-[#B91C1C]'} font-semibold">${pctOp}%</td>
                        <td class="py-3.5 px-5 font-mono-val text-xs text-[#64748B]">${obtenerUltimoEscaneoOperador(op.nombre, regsDia)}</td>
                        <td class="py-3.5 px-5">${estadoHtml}</td>
                        <td class="py-3.5 px-2 text-right whitespace-nowrap">
                            ${toggleHtml}
                            <button onclick="eliminarOperador('${op.id}')" title="Eliminar operador" class="h-8 px-2 text-slate-400 hover:text-red-600 rounded"><i class="fa-solid fa-trash text-xs"></i></button>
                        </td>
                    </tr>
                `;
            });
        }

        window.seleccionarTurnoOp = (turno, btn) => {
            turnoOpSeleccionado = turno;
            document.querySelectorAll('.turno-btn').forEach(b => b.className = "py-2 rounded text-[#475569] hover:text-[#0F172A] transition turno-btn");
            btn.className = "py-2 rounded bg-white text-[#0F172A] shadow-xs transition turno-btn font-medium";
        };

        window.agregarOperador = async () => {
            const nombre = document.getElementById('op-nombre').value.trim();
            const legajo = document.getElementById('op-legajo').value.trim() || "0112";
            if (!nombre) return mostrarMensajeForm('msg-operador', "Ingresá el nombre del operador.", 'error');
            if (operadoresCache.length >= MAX_OPERADORES) {
                return mostrarMensajeForm('msg-operador', `Límite alcanzado: no se pueden registrar más de ${MAX_OPERADORES} operadores.`, 'error');
            }
            if (operadoresCache.some(op => String(op.nombre || '').trim().toLowerCase() === nombre.toLowerCase())) {
                return mostrarMensajeForm('msg-operador', `Ya existe un operador con el nombre "${nombre}".`, 'error');
            }

            try {
                await addDoc(collection(db, "operadores"), { nombre, legajo, turno: turnoOpSeleccionado, activo: true });
                document.getElementById('op-nombre').value = '';
                document.getElementById('op-legajo').value = '';
                await cargarOperadores();
                renderizarPersonalAdmin();
                mostrarMensajeForm('msg-operador', `Operador "${nombre}" agregado.`, 'ok');
            } catch (e) {
                console.error('[Personal] Error al agregar operador:', e);
                mostrarMensajeForm('msg-operador', "No se pudo agregar el operador. Revisá la conexión y las reglas de Firestore.", 'error');
            }
        };

        window.toggleOperadorActivo = async (id, activo) => {
            try {
                await updateDoc(doc(db, "operadores", id), { activo });
                await cargarOperadores();
                renderizarPersonalAdmin();
                mostrarMensajeForm('msg-operador', activo ? "Operador activado." : "Operador desactivado.", 'ok');
            } catch (e) {
                console.error('[Personal] Error al cambiar estado del operador:', e);
                mostrarMensajeForm('msg-operador', "No se pudo cambiar el estado del operador.", 'error');
            }
        };

        window.abrirModalQR = (codigo, nombre) => {
            qrActualTexto = codigo;
            qrActualNombre = nombre || codigo;
            qrActualDataUrl = "";
            document.getElementById('modal-qr-titulo').textContent = qrActualNombre;
            document.getElementById('modal-qr-codigo-txt').textContent = codigo;
            const cont = document.getElementById('contenedor-qr-canvas');
            cont.innerHTML = "";
            try {
                const qr = qrcode(0, 'M'); qr.addData(codigo); qr.make();
                qrActualDataUrl = qr.createDataURL(8, 4);
                const img = document.createElement('img');
                img.src = qrActualDataUrl;
                img.alt = `Código QR ${codigo}`;
                img.className = "w-full h-full object-contain";
                cont.appendChild(img);
            } catch (e) {
                cont.textContent = codigo;
            }
            document.getElementById('modal-qr').classList.remove('hidden');
        };

        window.abrirModalQRPorId = (id) => {
            const p = Object.values(puntosCache).find(x => x.id === id);
            if (!p) return mostrarAvisoPanel('No se encontró el punto de control.', 'error');
            abrirModalQR(p.codigo, p.nombre);
        };

        window.cerrarModalQR = () => document.getElementById('modal-qr').classList.add('hidden');

        function convertirDataUrlAPng(dataUrl, tamano = 512) {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = tamano;
                    canvas.height = tamano;
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = '#FFFFFF';
                    ctx.fillRect(0, 0, tamano, tamano);
                    ctx.imageSmoothingEnabled = false;
                    ctx.drawImage(img, 0, 0, tamano, tamano);
                    resolve(canvas.toDataURL('image/png'));
                };
                img.onerror = reject;
                img.src = dataUrl;
            });
        }

        window.descargarImagenQR = async () => {
            if (!qrActualDataUrl) return;
            let dataUrl = qrActualDataUrl;
            try {
                dataUrl = await convertirDataUrlAPng(qrActualDataUrl);
            } catch (e) {
                console.warn('[QR] No se pudo convertir a PNG, se descarga la imagen original:', e);
            }
            const a = document.createElement('a');
            a.href = dataUrl;
            a.download = `QR_${qrActualNombre.replace(/[^\w\-]+/g, '_')}_${qrActualTexto}.png`;
            a.click();
        };

        window.imprimirTodosQR = () => {
            const puntos = Object.values(puntosCache);
            if (puntos.length === 0) return mostrarAvisoPanel('No hay puntos de control para imprimir.', 'warn');

            const tarjetas = puntos.map(p => {
                try {
                    const qr = qrcode(0, 'M');
                    qr.addData(p.codigo);
                    qr.make();
                    return `<article class="tarjeta">
                        <img src="${qr.createDataURL(8, 4)}" alt="QR ${escapeHtml(p.codigo)}">
                        <h2>${escapeHtml(p.nombre)}</h2>
                        <p>${escapeHtml(p.codigo)}</p>
                    </article>`;
                } catch (e) {
                    return '';
                }
            }).join('');

            const win = window.open('', '_blank');
            if (!win) return mostrarAvisoPanel('El navegador bloqueó la ventana de impresión. Habilitá las ventanas emergentes.', 'error');

            win.document.write(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>QR de puntos de control</title>
<style>
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; margin: 16px; color: #0F172A; }
    #grilla { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .tarjeta { border: 1px solid #CBD5E1; border-radius: 10px; padding: 12px; text-align: center; page-break-inside: avoid; }
    .tarjeta img { width: 100%; max-width: 260px; height: auto; }
    .tarjeta h2 { font-size: 15px; margin: 8px 0 2px; }
    .tarjeta p { font-family: monospace; font-size: 12px; margin: 0; color: #475569; }
    @media print {
        body { margin: 0; }
        #grilla { grid-template-columns: repeat(2, 1fr); gap: 8px; }
        .tarjeta { padding: 8px; }
    }
</style>
</head>
<body>
<div id="grilla">${tarjetas}</div>
<script>window.onload = function () { window.print(); };<\/script>
</body>
</html>`);
            win.document.close();
        };

        async function actualizarNombreEnRutas(codigoQR, nombre) {
            const snap = await getDocs(query(
                collection(db, "rutas_horarias"),
                where("codigoQR", "==", codigoQR)
            ));
            const rutas = snap.docs;
            for (let inicio = 0; inicio < rutas.length; inicio += 450) {
                const lote = writeBatch(db);
                rutas.slice(inicio, inicio + 450).forEach(ruta => lote.update(ruta.ref, { puntoNombre: nombre }));
                await lote.commit();
            }
        }

        window.editarNombrePunto = async id => {
            const punto = Object.values(puntosCache).find(p => p.id === id);
            if (!punto) return mostrarAvisoPanel('No se encontró el punto de control.', 'error');

            const entrada = prompt(`Nuevo nombre para ${punto.nombre}. El código ${punto.codigo} no se modifica:`, punto.nombre);
            if (entrada === null) return;
            const nombre = entrada.trim();
            if (!nombre) return mostrarAvisoPanel('El nombre del punto no puede quedar vacío.', 'error');
            if (nombre.length > 80) return mostrarAvisoPanel('El nombre no puede superar los 80 caracteres.', 'error');
            if (existePuntoConNombre(nombre, punto.codigo)) return mostrarAvisoPanel('Ya existe otro punto con ese nombre.', 'error');

            try {
                await updateDoc(doc(db, "puntos_control", id), { nombre });
                let horariosActualizados = true;
                try {
                    await actualizarNombreEnRutas(punto.codigo, nombre);
                } catch (e) {
                    horariosActualizados = false;
                    console.error('[Puntos] El nombre se guardó, pero no se pudieron actualizar todos sus horarios:', e);
                }

                await Promise.all([cargarPuntos(), cargarRutas()]);
                renderizarPuntosAdmin();
                renderizarRutasAdmin();
                if (mapaPuntos) actualizarMapaPuntos();
                if (horariosActualizados) {
                    mostrarAvisoPanel(`Nombre actualizado a "${nombre}". El código ${punto.codigo} se conservó.`, 'ok');
                } else {
                    mostrarAvisoPanel('El nombre se guardó, pero algunos horarios pueden conservar el nombre anterior. Volvé a intentarlo para sincronizarlos.', 'warn');
                }
            } catch (e) {
                console.error('[Puntos] Error al editar el nombre:', e);
                mostrarAvisoPanel('No se pudo actualizar el nombre. Revisá la conexión y las reglas de Firestore.', 'error');
            }
        };

        window.eliminarPunto = async (id) => {
            const p = Object.values(puntosCache).find(x => x.id === id);
            const nombre = p ? p.nombre : "este punto";
            const rutasAsociadas = p ? rutasCache.filter(r => r.codigoQR === p.codigo) : [];
            const aviso = rutasAsociadas.length > 0
                ? `¿Eliminar "${nombre}"? También se eliminarán ${rutasAsociadas.length} horario(s) asociado(s).`
                : `¿Eliminar "${nombre}"?`;
            if (!confirm(aviso)) return;

            try {
                const batch = writeBatch(db);
                rutasAsociadas.forEach(r => batch.delete(doc(db, "rutas_horarias", r.id)));
                batch.delete(doc(db, "puntos_control", id));
                await batch.commit();
                await Promise.all([cargarPuntos(), cargarRutas()]);
                renderizarPuntosAdmin();
                renderizarRutasAdmin();
                if (mapaPuntos) actualizarMapaPuntos();
                mostrarAvisoPanel(`Punto "${nombre}" eliminado.`, 'ok');
            } catch (e) {
                console.error('[Puntos] Error al eliminar punto:', e);
                mostrarAvisoPanel('No se pudo eliminar el punto. Revisá la conexión y las reglas de Firestore.', 'error');
            }
        };

        window.eliminarRuta = async (id) => {
            const r = rutasCache.find(x => x.id === id);
            if (!confirm(`¿Eliminar el horario ${r ? r.hora : ''} de ${r ? r.puntoNombre : 'este punto'}?`)) return;

            try {
                await deleteDoc(doc(db, "rutas_horarias", id));
                await cargarRutas();
                renderizarRutasAdmin();
                renderizarPuntosAdmin();
                mostrarAvisoPanel('Horario eliminado de la agenda.', 'ok');
            } catch (e) {
                console.error('[Rutas] Error al eliminar horario:', e);
                mostrarAvisoPanel('No se pudo eliminar el horario. Revisá la conexión y las reglas de Firestore.', 'error');
            }
        };

        window.eliminarOperador = async (id) => {
            const op = operadoresCache.find(x => x.id === id);
            const nombre = op ? op.nombre : "este operador";
            if (!confirm(`¿Eliminar a "${nombre}"? El historial de escaneos se conserva.`)) return;

            try {
                await deleteDoc(doc(db, "operadores", id));
                await cargarOperadores();
                renderizarPersonalAdmin();
                mostrarAvisoPanel(`Operador "${nombre}" eliminado.`, 'ok');
            } catch (e) {
                console.error('[Personal] Error al eliminar operador:', e);
                mostrarAvisoPanel('No se pudo eliminar el operador. Revisá la conexión y las reglas de Firestore.', 'error');
            }
        };

        window.exportarRondas = async () => {
            if (typeof XLSX === 'undefined') {
                return mostrarAvisoPanel('No se pudo cargar el generador de XLSX. Revisá la conexión a internet.', 'error');
            }

            const opFiltro = document.getElementById('filtro-operador').value;
            const busqueda = document.getElementById('filtro-busqueda').value.toLowerCase().trim();
            let registros = [];
            let alcance = "";
            let alcanzoLimite = false;

            try {
                if (offsetDiasFiltro !== 0) {
                    const fecha = obtenerFechaFiltroISO();
                    registros = registrosAdminCache.filter(r => r.fechaISO === fecha);
                    alcance = fecha;
                } else {
                    const corte = Date.now() - RETENCION_MS;
                    const snap = await getDocs(query(
                        collection(db, "registros_ronda"),
                        where("timestampMs", ">=", corte),
                        orderBy("timestampMs", "desc"),
                        limit(LIMITE_EXPORTACION)
                    ));
                    registros = snap.docs.map(d => d.data());
                    alcance = `ultimos_${DIAS_RETENCION}_dias`;
                    alcanzoLimite = snap.size >= LIMITE_EXPORTACION;
                }
            } catch (e) {
                console.error('[Export] Error al leer registros:', e);
                return mostrarAvisoPanel('No se pudieron leer los registros para exportar. Revisá la conexión y las reglas de Firestore.', 'error');
            }

            if (filtroEstadoActual === 'valido') registros = registros.filter(r => r.severidad === "OK");
            if (filtroEstadoActual === 'advertencia') registros = registros.filter(r => r.severidad === "ADVERTENCIA");
            if (filtroEstadoActual === 'critico') registros = registros.filter(r => r.severidad === "CRITICO");
            if (opFiltro) registros = registros.filter(r => r.operador === opFiltro);
            if (busqueda) {
                registros = registros.filter(r =>
                    (r.puntoNombre && r.puntoNombre.toLowerCase().includes(busqueda)) ||
                    (r.codigoQR && r.codigoQR.toLowerCase().includes(busqueda)) ||
                    (r.operador && r.operador.toLowerCase().includes(busqueda))
                );
            }

            if (registros.length === 0) {
                return mostrarAvisoPanel('No hay registros para exportar con los filtros actuales.', 'warn');
            }

            const filas = registros.map(r => {
                const [fechaTxt, horaTxt] = r.fechaTexto ? r.fechaTexto.split(' ') : ["", ""];
                const hora = horaTxt || (r.timestampMs ? formatearHoraDeMs(r.timestampMs) : "");
                const margen = obtenerMargenRegistro(r, rutasCache);
                let desvio = "";
                if (r.timestampMs && r.horarioProgramado && r.horarioProgramado !== "Sin agenda") {
                    const [hP, mP] = r.horarioProgramado.split(':').map(Number);
                    if (!isNaN(hP) && !isNaN(mP)) {
                        const dProg = new Date(r.timestampMs);
                        dProg.setHours(hP, mP, 0, 0);
                        desvio = Math.round((r.timestampMs - dProg.getTime()) / 60000);
                    }
                }

                return {
                    'Fecha': r.fechaISO || fechaTxt || "",
                    'Hora': hora,
                    'Operador': r.operador || "",
                    'Punto': r.puntoNombre || "",
                    'Codigo QR': r.codigoQR || "",
                    'Programado': r.horarioProgramado || "",
                    'Margen (min)': margen,
                    'Desvio (min)': desvio,
                    'Distancia (m)': r.distancia !== undefined ? r.distancia : (r.gpsDist !== undefined ? r.gpsDist : ""),
                    'Tolerancia (m)': obtenerToleranciaRegistro(r, puntosCache[r.codigoQR]),
                    'Estado': r.estado || "",
                    'Severidad': r.severidad || "",
                    'Latitud': r.latReal !== undefined ? r.latReal : "",
                    'Longitud': r.lngReal !== undefined ? r.lngReal : "",
                    'Dia de ruta': r.diaRuta || "",
                    'ID de ruta': r.rutaId || ""
                };
            });

            const conteo = { OK: 0, ADVERTENCIA: 0, CRITICO: 0 };
            const porOperador = {};
            registros.forEach(r => {
                if (conteo[r.severidad] !== undefined) conteo[r.severidad]++;
                const op = r.operador || "Sin asignar";
                if (!porOperador[op]) porOperador[op] = { total: 0, ok: 0, adv: 0, crit: 0 };
                porOperador[op].total++;
                if (r.severidad === "OK") porOperador[op].ok++;
                else if (r.severidad === "ADVERTENCIA") porOperador[op].adv++;
                else if (r.severidad === "CRITICO") porOperador[op].crit++;
            });

            const resumen = [
                { 'Concepto': 'Total de registros', 'Valor': registros.length },
                { 'Concepto': 'Válidos', 'Valor': conteo.OK },
                { 'Concepto': 'Fuera de horario', 'Valor': conteo.ADVERTENCIA },
                { 'Concepto': 'Críticos', 'Valor': conteo.CRITICO },
                { 'Concepto': 'Alcance', 'Valor': alcance },
                { 'Concepto': 'Generado', 'Valor': new Date().toLocaleString('es-AR') }
            ];

            const filasOperadores = Object.entries(porOperador).map(([operador, c]) => ({
                'Operador': operador,
                'Escaneos': c.total,
                'Validos': c.ok,
                'Advertencias': c.adv,
                'Criticos': c.crit,
                '% Validos': c.total > 0 ? Math.round((c.ok / c.total) * 100) : 0
            }));

            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.json_to_sheet(filas);
            ws['!cols'] = [
                { wch: 12 }, { wch: 8 }, { wch: 22 }, { wch: 24 }, { wch: 16 },
                { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 13 },
                { wch: 24 }, { wch: 12 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 20 }
            ];
            const wsResumen = XLSX.utils.json_to_sheet(resumen);
            wsResumen['!cols'] = [{ wch: 24 }, { wch: 24 }];
            const wsOperadores = XLSX.utils.json_to_sheet(filasOperadores);
            wsOperadores['!cols'] = [{ wch: 24 }, { wch: 10 }, { wch: 10 }, { wch: 13 }, { wch: 11 }, { wch: 10 }];

            XLSX.utils.book_append_sheet(wb, ws, 'Rondas');
            XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');
            XLSX.utils.book_append_sheet(wb, wsOperadores, 'Por operador');
            XLSX.writeFile(wb, `Rondas_${alcance}_${obtenerFechaHoyISO()}.xlsx`);

            if (alcanzoLimite) {
                mostrarAvisoPanel(`Se exportaron ${registros.length} registros (límite de ${LIMITE_EXPORTACION} alcanzado).`, 'warn');
            } else {
                mostrarAvisoPanel(`${registros.length} registros exportados a XLSX.`, 'ok');
            }
        };


// === Instalacion PWA (Add to Home Screen) ===
let deferredInstallPrompt = null;
let installPromptListo = false;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    installPromptListo = true;
    const banner = document.getElementById('banner-instalar');
    if (banner) banner.classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    const banner = document.getElementById('banner-instalar');
    if (banner) banner.classList.add('hidden');
});
document.addEventListener('DOMContentLoaded', () => {
    if (installPromptListo) {
        const banner = document.getElementById('banner-instalar');
        if (banner) banner.classList.remove('hidden');
    }
    const btnInstalar = document.getElementById('btn-instalar');
    const btnCerrar = document.getElementById('btn-cerrar-instalar');
    if (btnInstalar) {
        btnInstalar.addEventListener('click', async () => {
            if (!deferredInstallPrompt) return;
            deferredInstallPrompt.prompt();
            const { outcome } = await deferredInstallPrompt.userChoice;
            if (outcome === 'accepted') {
                const banner = document.getElementById('banner-instalar');
                if (banner) banner.classList.add('hidden');
            }
            deferredInstallPrompt = null;
        });
    }
    if (btnCerrar) {
        btnCerrar.addEventListener('click', () => {
            const banner = document.getElementById('banner-instalar');
            if (banner) banner.classList.add('hidden');
            deferredInstallPrompt = null;
        });
    }
});


// === Gate de permisos obligatorios (instalacion, notificaciones, ubicacion) ===
(function inicializarGate() {
    const gate = document.getElementById('gate-permisos');
    if (!gate) return;

    const esMovil = /android|iphone|ipad|ipod/i.test(navigator.userAgent) || (window.matchMedia('(max-width: 768px)').matches && 'ontouchstart' in window);
    const esStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

    const itemInstall = document.getElementById('gate-item-install');
    const btnInstall = document.getElementById('gate-btn-install');
    const btnNotif = document.getElementById('gate-btn-notif');
    const btnGps = document.getElementById('gate-btn-gps');
    const btnContinuar = document.getElementById('gate-btn-continuar');
    const mensaje = document.getElementById('gate-mensaje');

    let notifOk = (typeof Notification === 'undefined') || Notification.permission === 'granted';
    let gpsOk = !navigator.geolocation;
    let installOk = !esMovil || esStandalone;

    if (typeof Notification === 'undefined' && btnNotif) {
        btnNotif.textContent = 'No soportado';
        btnNotif.disabled = true;
        btnNotif.classList.add('opacity-60');
    }
    if (!navigator.geolocation && btnGps) {
        btnGps.textContent = 'No soportado';
        btnGps.disabled = true;
        btnGps.classList.add('opacity-60');
    }

    function mostrarMensaje(texto) {
        if (!mensaje) return;
        mensaje.textContent = texto;
        mensaje.classList.remove('hidden');
    }

    function actualizarEstado() {
        if (notifOk && btnNotif) {
            btnNotif.textContent = 'OK';
            btnNotif.disabled = true;
            btnNotif.classList.add('opacity-60');
        }
        if (gpsOk && btnGps) {
            btnGps.textContent = 'OK';
            btnGps.disabled = true;
            btnGps.classList.add('opacity-60');
        }
        if (installOk && btnInstall) {
            btnInstall.textContent = 'OK';
            btnInstall.disabled = true;
            btnInstall.classList.add('opacity-60');
        }
        if (btnContinuar) {
            btnContinuar.disabled = !(notifOk && gpsOk && installOk);
        }
    }

    // Mostrar item de instalacion solo en movil no instalado
    if (esMovil && !esStandalone && itemInstall) {
        itemInstall.classList.remove('hidden');
    } else {
        installOk = true;
    }

    // Notificaciones
    if (btnNotif) {
        btnNotif.addEventListener('click', async () => {
            if (typeof Notification === 'undefined') {
                mostrarMensaje('Este navegador no soporta notificaciones.');
                return;
            }
            try {
                const perm = await Notification.requestPermission();
                notifOk = (perm === 'granted');
                if (notifOk) {
                    try { await registrarTokenFCM(); } catch (e) { console.warn('[Gate] Error registrando token FCM:', e); }
                } else {
                    mostrarMensaje('Debes permitir las notificaciones para continuar. Activalas en la configuracion del navegador.');
                }
                actualizarEstado();
            } catch (e) {
                mostrarMensaje('No se pudo solicitar el permiso de notificaciones.');
            }
        });
    }

    // Ubicacion
    if (btnGps) {
        btnGps.addEventListener('click', () => {
            if (!navigator.geolocation) {
                mostrarMensaje('Este dispositivo no soporta geolocalizacion.');
                return;
            }
            navigator.geolocation.getCurrentPosition(
                () => { gpsOk = true; mensaje.classList.add('hidden'); actualizarEstado(); },
                () => { mostrarMensaje('Debes permitir la ubicacion precisa para continuar. Activala en la configuracion del navegador.'); },
                { enableHighAccuracy: true, timeout: 10000 }
            );
        });
    }

    // Instalacion
    if (btnInstall) {
        btnInstall.addEventListener('click', async () => {
            if (deferredInstallPrompt) {
                deferredInstallPrompt.prompt();
                const { outcome } = await deferredInstallPrompt.userChoice;
                if (outcome === 'accepted') {
                    installOk = true;
                    mensaje.classList.add('hidden');
                } else {
                    mostrarMensaje('Debes instalar la app para continuar.');
                }
                deferredInstallPrompt = null;
                actualizarEstado();
            } else {
                // Instrucciones manuales (iOS o navegador sin beforeinstallprompt)
                mostrarMensaje('Instalala manualmente: en el menu del navegador elegi "Agregar a pantalla de inicio" o "Instalar app".');
            }
        });
    }

    // Si el prompt de instalacion llega despues
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        if (esMovil && !esStandalone && itemInstall) {
            itemInstall.classList.remove('hidden');
        }
    });
    window.addEventListener('appinstalled', () => {
        installOk = true;
        if (itemInstall) itemInstall.classList.add('hidden');
        actualizarEstado();
    });

    // Verificar permisos ya concedidos
    if (notifOk) actualizarEstado();
    if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: 'geolocation' }).then(res => {
            if (res.state === 'granted') { gpsOk = true; actualizarEstado(); }
            res.addEventListener('change', () => {
                gpsOk = (res.state === 'granted');
                actualizarEstado();
            });
        }).catch(() => {});
    }

    // Continuar
    if (btnContinuar) {
        btnContinuar.addEventListener('click', () => {
            if (notifOk && gpsOk && installOk) {
                gate.classList.add('hidden');
            }
        });
    }

    // Si todo ya esta OK, ocultar el gate de inmediato
    // (se verifica despues de un tick para que los permisos se evaluen)
    setTimeout(() => {
        if (notifOk && gpsOk && installOk && !(esMovil && !esStandalone)) {
            gate.classList.add('hidden');
        }
        actualizarEstado();
    }, 300);
})();


        window.abrirCalendarioEncargado = async () => {
            const input = document.getElementById('input-fecha-calendario');
            if (!input) return;
            const hoy = obtenerFechaHoyISO();
            input.max = hoy;
            input.value = obtenerFechaFiltroISO();
            // Limitar el minimo a la fecha mas antigua con registros (si se puede).
            try {
                const snap = await getDocs(query(collection(db, "registros_ronda"), orderBy("fechaISO", "asc"), limit(1)));
                if (!snap.empty) {
                    const oldest = snap.docs[0].data().fechaISO;
                    if (oldest) input.min = oldest;
                }
            } catch (e) { /* ignorar */ }
            try { input.showPicker(); } catch (e) { input.click(); }
        };

        let ultimaFechaCalendario = null;
        window.cambiarFechaCalendario = async (isoDate) => {
            if (!isoDate) return;
            // Evitar procesar el mismo evento dos veces (algunos navegadores
            // disparan 'change' al cerrar el selector con la fecha de hoy).
            if (isoDate === ultimaFechaCalendario) return;
            const hoy = obtenerFechaHoyISO();
            const fechaActualFiltro = obtenerFechaFiltroISO();
            // Si el input se reseteo a hoy pero el filtro actual no es hoy,
            // es un evento espurio del navegador: ignorarlo.
            if (isoDate === hoy && fechaActualFiltro !== hoy) return;
            // No permitir fechas futuras.
            if (isoDate > hoy) isoDate = hoy;
            const dHoy = new Date(hoy + 'T00:00:00');
            const dSel = new Date(isoDate + 'T00:00:00');
            const diff = Math.round((dSel.getTime() - dHoy.getTime()) / (24 * 60 * 60 * 1000));
            const offsetAnterior = offsetDiasFiltro;
            offsetDiasFiltro = Math.min(0, diff);
            ultimaFechaCalendario = isoDate;
            actualizarRelojYFechaHeader();
            await cargarRegistrosAdmin();
            // Si no hay registros para esa fecha, avisar y volver a la fecha anterior.
            const hayRegistros = registrosAdminCache.some(r => r.fechaISO === isoDate);
            if (!hayRegistros && isoDate !== hoy) {
                mostrarAvisoPanel('No hay registros para ' + isoDate + '. Selecciona otra fecha.', 'warn');
                offsetDiasFiltro = offsetAnterior;
                ultimaFechaCalendario = obtenerFechaFiltroISO();
                actualizarRelojYFechaHeader();
                await cargarRegistrosAdmin();
            }
            renderizarTodoAdmin();
        };
