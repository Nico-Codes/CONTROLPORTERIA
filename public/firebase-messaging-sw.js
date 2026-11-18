/* Service Worker para Notificaciones Nativas, FCM y cache del app shell */
/* Control de Rondas – Meatex */

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

const firebaseConfig = {
    apiKey: "AIzaSyAl9AqfZzwojhuB_7QPFS0kfMbw5dfdI-4",
    authDomain: "control-rondas-porteria-7ecc7.firebaseapp.com",
    projectId: "control-rondas-porteria-7ecc7",
    storageBucket: "control-rondas-porteria-7ecc7.firebasestorage.app",
    messagingSenderId: "873679139344",
    appId: "1:873679139344:web:cdf54b69a8eb7582959095"
};

firebase.initializeApp(firebaseConfig);

let messaging = null;
try {
    messaging = firebase.messaging();
} catch (e) {
    console.warn('[SW] Firebase Messaging no disponible en este entorno:', e);
}

const CACHE_NAME = 'rondas-shell-v1';
const CORE_ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png', '/badge-72.png'];

// Instalación: precache del app shell.
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS)).catch(() => {})
    );
    self.skipWaiting();
});

// Activación: limpiar caches viejos y tomar control.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// Cache del app shell: network-first para navegación, cache-first para assets.
self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    let url;
    try { url = new URL(req.url); } catch (e) { return; }
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/')) return;
    if (url.pathname === '/firebase-messaging-sw.js') return;

    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req).then(res => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(c => c.put(req, clone)).catch(() => {});
                }
                return res;
            }).catch(() => caches.match(req).then(r => r || caches.match('/index.html')))
        );
        return;
    }

    event.respondWith(
        caches.match(req).then(cached => {
            if (cached) return cached;
            return fetch(req).then(res => {
                if (res && res.status === 200) {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(c => c.put(req, clone)).catch(() => {});
                }
                return res;
            }).catch(() => cached);
        })
    );
});

// Receptor de notificaciones en segundo plano (FCM).
if (messaging) {
    messaging.onBackgroundMessage((payload) => {
        console.log('[SW] Push recibido en segundo plano:', payload);

        const title = payload.notification?.title || payload.data?.title || "Control de Rondas · Meatex";
        const body = payload.notification?.body || payload.data?.body || "Aviso del sistema de rondas.";
        const severidad = payload.data?.severidad || "info";

        const options = {
            body: body,
            icon: "/icon-192.png",
            badge: "/badge-72.png",
            vibrate: severidad === "CRITICO" ? [300, 100, 300, 100, 400] : [200, 100, 200],
            tag: payload.data?.tag || payload.notification?.title || "ronda-alerta",
            renotify: true,
            requireInteraction: severidad === "CRITICO",
            data: payload.data || {}
        };

        return self.registration.showNotification(title, options);
    });
}

// Receptor de eventos de mensaje directo desde la ventana principal.
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SHOW_NATIVE_NOTIFICATION') {
        const title = event.data.title || "Control de Rondas";
        const options = event.data.options || {};
        self.registration.showNotification(title, options);
    }
});

// Acción al hacer clic en la notificación.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const urlDestino = 'https://controlporteria.vercel.app/';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            for (const client of windowClients) {
                if (client.url && client.url.includes('vercel.app') && 'focus' in client) {
                    return client.focus();
                }
            }
            for (const client of windowClients) {
                if (client.url && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow(urlDestino);
            }
        })
    );
});