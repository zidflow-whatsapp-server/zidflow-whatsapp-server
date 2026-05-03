const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');

const app = express();
app.use(express.json());

let sock = null;
let qrCodeData = null;
let clientStatus = 'DISCONNECTED';
let retryCount = 0;

async function initWhatsApp() {
  try {
    const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = await import('@whiskeysockets/baileys');
    const { default: pino } = await import('pino');

    const sessionDir = '/tmp/wa-session';
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    clientStatus = 'CONNECTING';
    console.log('[WA] Connecting...');

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['ZidFlow', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        clientStatus = 'QR';
        qrCodeData = await qrcode.toDataURL(qr);
        console.log('[WA] QR ready - scan it!');
      }
      if (connection === 'open') {
        clientStatus = 'READY';
        qrCodeData = null;
        retryCount = 0;
        console.log('[WA] ✅ Connected!');
      }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        clientStatus = 'DISCONNECTED';
        qrCodeData = null;
        console.log('[WA] Disconnected. Logged out:', loggedOut);
        if (!loggedOut && retryCount < 5) {
          retryCount++;
          setTimeout(initWhatsApp, 5000);
        } else if (loggedOut) {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      }
    });

  } catch (err) {
    console.error('[WA] Error:', err.message);
    clientStatus = 'DISCONNECTED';
    if (retryCount < 3) { retryCount++; setTimeout(initWhatsApp, 10000); }
  }
}

initWhatsApp();

// ===== ROUTES =====

app.get('/', (req, res) => {
  res.json({ service: 'ZidFlow WhatsApp Server', status: clientStatus, ready: clientStatus === 'READY' });
});

app.get('/qr', (req, res) => {
  if (clientStatus === 'READY') {
    return res.send(`<html><body style="font-family:Arial;text-align:center;padding:60px;background:#f0fff4" dir="rtl">
      <div style="font-size:80px">✅</div>
      <h1 style="color:#004d40">واتساب متصل!</h1>
      <p>النظام يعمل. الرسائل ترسل تلقائياً.</p>
    </body></html>`);
  }
  if (!qrCodeData) {
    return res.send(`<html><head><meta http-equiv="refresh" content="5"></head>
    <body style="font-family:Arial;text-align:center;padding:60px" dir="rtl">
      <h2>⏳ جاري تجهيز QR Code...</h2>
      <p>الحالة: <strong>${clientStatus}</strong></p>
      <p style="color:#999">الصفحة تتحدث كل 5 ثوانٍ</p>
    </body></html>`);
  }
  res.send(`<html><head><meta http-equiv="refresh" content="30"></head>
  <body style="font-family:Arial;text-align:center;padding:40px;background:#fafafa" dir="rtl">
    <h1 style="color:#004d40">📱 امسح QR Code الآن</h1>
    <p>واتساب ← النقاط الثلاث ⋮ ← <strong>WhatsApp Web</strong> ← امسح</p>
    <img src="${qrCodeData}" style="width:280px;border:3px solid #004d40;border-radius:16px;padding:10px;background:white"/>
    <p style="color:#999;margin-top:20px;font-size:13px">تتحدث كل 30 ثانية</p>
  </body></html>`);
});

app.post('/send', async (req, res) => {
  const { to, message, secret } = req.body;
  if (process.env.API_SECRET && secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  if (clientStatus !== 'READY' || !sock) return res.status(503).json({ error: 'WhatsApp not ready', status: clientStatus });
  try {
    await sock.sendMessage(to.replace(/\D/g, '') + '@s.whatsapp.net', { text: message });
    console.log(`[WA] ✅ Sent to ${to}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🟢 ZidFlow WA Server on port ${PORT}`));
