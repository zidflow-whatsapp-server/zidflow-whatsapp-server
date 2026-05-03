const express = require('express');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// ===== STATE =====
let sock = null;
let qrCodeData = null;
let clientStatus = 'DISCONNECTED';
let retryCount = 0;

// ===== WHATSAPP INIT (Baileys - Lightweight, No Browser Needed) =====
async function initWhatsApp() {
  try {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import('@whiskeysockets/baileys');
    const { Boom } = await import('@hapi/boom');
    const pino = (await import('pino')).default;

    const sessionDir = '/tmp/whatsapp-baileys-session';
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    console.log('[WhatsApp] Initializing Baileys client...');
    clientStatus = 'CONNECTING';

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['ZidFlow', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log('[WhatsApp] QR Code ready - scan it!');
        clientStatus = 'QR';
        qrCodeData = await qrcode.toDataURL(qr);
      }

      if (connection === 'open') {
        console.log('[WhatsApp] ✅ Connected successfully!');
        clientStatus = 'READY';
        qrCodeData = null;
        retryCount = 0;
      }

      if (connection === 'close') {
        const { StatusCode } = await import('@whiskeysockets/baileys');
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('[WhatsApp] Connection closed. Reconnect:', shouldReconnect);
        clientStatus = 'DISCONNECTED';
        qrCodeData = null;

        if (shouldReconnect && retryCount < 5) {
          retryCount++;
          console.log(`[WhatsApp] Reconnecting in 5s... (${retryCount}/5)`);
          setTimeout(initWhatsApp, 5000);
        } else if (!shouldReconnect) {
          // Logged out - clear session
          fs.rmSync(sessionDir, { recursive: true, force: true });
          console.log('[WhatsApp] Logged out. Session cleared. Restart to get new QR.');
        }
      }
    });

  } catch (err) {
    console.error('[WhatsApp] Init error:', err.message);
    clientStatus = 'DISCONNECTED';
    if (retryCount < 3) {
      retryCount++;
      setTimeout(initWhatsApp, 10000);
    }
  }
}

// Start on boot
initWhatsApp();

// ===== ROUTES =====

// Status
app.get('/', (req, res) => {
  res.json({
    service: 'ZidFlow WhatsApp Server',
    status: clientStatus,
    ready: clientStatus === 'READY',
    hasQR: !!qrCodeData,
    qrPage: '/qr'
  });
});

// QR Code page
app.get('/qr', (req, res) => {
  if (clientStatus === 'READY') {
    return res.send(`
      <html><body style="font-family:Arial;text-align:center;padding:60px;background:#f0fff4">
        <div style="font-size:80px">✅</div>
        <h1 style="color:#004d40">واتساب متصل!</h1>
        <p style="color:#555">النظام يعمل بشكل طبيعي. الرسائل ترسل تلقائياً.</p>
        <div style="background:#e8f5e9;padding:20px;border-radius:12px;display:inline-block;margin-top:20px">
          <code style="color:#1b5e20">Status: READY ✅</code>
        </div>
      </body></html>
    `);
  }

  if (!qrCodeData) {
    return res.send(`
      <html>
      <head><meta http-equiv="refresh" content="5"><title>ZidFlow WA - Loading</title></head>
      <body style="font-family:Arial;text-align:center;padding:60px;background:#fafafa">
        <div style="font-size:60px">⏳</div>
        <h2>جاري تجهيز QR Code...</h2>
        <p style="color:#666">الحالة: <strong>${clientStatus}</strong></p>
        <p style="color:#999;font-size:13px">الصفحة تتحدث كل 5 ثوانٍ تلقائياً</p>
        <div style="width:40px;height:40px;border:4px solid #004d40;border-top:4px solid transparent;border-radius:50%;animation:spin 1s linear infinite;margin:20px auto"></div>
        <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
      </body></html>
    `);
  }

  res.send(`
    <html>
    <head><meta http-equiv="refresh" content="30"><title>ZidFlow - امسح QR</title></head>
    <body style="font-family:Arial;text-align:center;padding:40px;background:#fafafa" dir="rtl">
      <h1 style="color:#004d40">📱 امسح QR Code الآن</h1>
      <p style="color:#555;margin-bottom:30px">
        افتح واتساب → اضغط النقاط الثلاث ⋮ → <strong>WhatsApp Web</strong> → امسح
      </p>
      <div style="background:white;display:inline-block;padding:20px;border-radius:16px;border:3px solid #004d40;box-shadow:0 8px 32px rgba(0,77,64,0.15)">
        <img src="${qrCodeData}" style="width:280px;display:block"/>
      </div>
      <p style="color:#999;margin-top:20px;font-size:13px">⏱️ الصفحة تتحدث كل 30 ثانية</p>
    </body></html>
  `);
});

// Send message
app.post('/send', async (req, res) => {
  const { to, message, secret } = req.body;

  if (process.env.API_SECRET && secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!to || !message) {
    return res.status(400).json({ error: 'to and message are required' });
  }
  if (clientStatus !== 'READY' || !sock) {
    return res.status(503).json({ error: 'WhatsApp not ready', status: clientStatus });
  }

  try {
    const jid = to.replace(/\D/g, '') + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text: message });
    console.log(`[WA] ✅ Sent to ${to}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[WA] Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Restart
app.post('/restart', async (req, res) => {
  const { secret } = req.body;
  if (process.env.API_SECRET && secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    if (sock) await sock.logout().catch(() => {});
  } catch (e) {}
  clientStatus = 'DISCONNECTED';
  retryCount = 0;
  setTimeout(initWhatsApp, 2000);
  res.json({ success: true, message: 'Restarting...' });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🟢 ZidFlow WhatsApp Server on port ${PORT}`);
  console.log(`📱 Scan QR at /qr\n`);
});
