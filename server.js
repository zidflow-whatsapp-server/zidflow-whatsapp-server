const express = require('express');
const qrcode = require('qrcode');

const app = express();
app.use(express.json());

// ===== WHATSAPP CLIENT SETUP =====
let client = null;
let qrCodeData = null;
let clientStatus = 'DISCONNECTED'; // DISCONNECTED | CONNECTING | QR | READY
let retryCount = 0;
const MAX_RETRIES = 3;

async function initWhatsApp() {
  try {
    const { Client, LocalAuth } = require('whatsapp-web.js');
    
    console.log('[WhatsApp] Initializing client...');
    clientStatus = 'CONNECTING';
    
    client = new Client({
      authStrategy: new LocalAuth({ dataPath: '/tmp/whatsapp-session' }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      }
    });

    client.on('qr', async (qr) => {
      console.log('[WhatsApp] QR Code received. Scan it!');
      clientStatus = 'QR';
      qrCodeData = await qrcode.toDataURL(qr);
    });

    client.on('ready', () => {
      console.log('[WhatsApp] ✅ Client is READY!');
      clientStatus = 'READY';
      qrCodeData = null;
      retryCount = 0;
    });

    client.on('authenticated', () => {
      console.log('[WhatsApp] Authenticated successfully.');
    });

    client.on('auth_failure', (msg) => {
      console.error('[WhatsApp] Auth failure:', msg);
      clientStatus = 'DISCONNECTED';
    });

    client.on('disconnected', (reason) => {
      console.warn('[WhatsApp] Disconnected:', reason);
      clientStatus = 'DISCONNECTED';
      qrCodeData = null;
      
      // Auto-reconnect after 10 seconds
      if (retryCount < MAX_RETRIES) {
        retryCount++;
        console.log(`[WhatsApp] Reconnecting... (attempt ${retryCount}/${MAX_RETRIES})`);
        setTimeout(initWhatsApp, 10000);
      }
    });

    await client.initialize();

  } catch (err) {
    console.error('[WhatsApp] Init error:', err.message);
    clientStatus = 'DISCONNECTED';
  }
}

// Start WhatsApp on boot
initWhatsApp();


// ===== API ROUTES =====

// Health check + status
app.get('/', (req, res) => {
  res.json({
    service: 'ZidFlow WhatsApp Server',
    status: clientStatus,
    ready: clientStatus === 'READY',
    hasQR: !!qrCodeData
  });
});

// Get QR Code (open this URL in browser to scan)
app.get('/qr', (req, res) => {
  if (clientStatus === 'READY') {
    return res.send(`
      <html><body style="text-align:center;font-family:Arial;padding:40px;background:#f0f9f0">
        <h1 style="color:#004d40">✅ WhatsApp متصل!</h1>
        <p>الخادم يعمل بشكل طبيعي</p>
      </body></html>
    `);
  }
  if (!qrCodeData) {
    return res.send(`
      <html><body style="text-align:center;font-family:Arial;padding:40px">
        <h2>⏳ جاري تحميل الـ QR...</h2>
        <p>انتظر 30 ثانية ثم أعد تحديث الصفحة</p>
        <meta http-equiv="refresh" content="5">
      </body></html>
    `);
  }
  res.send(`
    <html>
    <head><title>ZidFlow WhatsApp QR</title></head>
    <body style="text-align:center;font-family:Arial;padding:40px;background:#fafafa">
      <h1 style="color:#004d40">📱 امسح QR Code</h1>
      <p style="color:#666">افتح واتساب → النقاط الثلاث → WhatsApp Web → امسح الكود</p>
      <img src="${qrCodeData}" style="width:300px;border:2px solid #004d40;border-radius:12px;padding:10px;background:white"/>
      <p style="color:#888;font-size:12px">الصفحة تتحدث تلقائياً كل 10 ثوانٍ</p>
      <meta http-equiv="refresh" content="10">
    </body>
    </html>
  `);
});

// Send WhatsApp message (called by ZidFlow on new order)
app.post('/send', async (req, res) => {
  const { to, message, secret } = req.body;

  // Basic security check
  if (process.env.API_SECRET && secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!to || !message) {
    return res.status(400).json({ error: 'to and message are required' });
  }

  if (clientStatus !== 'READY') {
    return res.status(503).json({ 
      error: 'WhatsApp not ready', 
      status: clientStatus,
      qrUrl: clientStatus === 'QR' ? '/qr' : null
    });
  }

  try {
    const formattedNumber = to.replace(/\D/g, '') + '@c.us';
    await client.sendMessage(formattedNumber, message);
    console.log(`[WhatsApp] ✅ Message sent to ${to}`);
    res.json({ success: true, to, message });
  } catch (err) {
    console.error('[WhatsApp] Send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Send to multiple numbers at once
app.post('/send-bulk', async (req, res) => {
  const { messages, secret } = req.body;
  
  if (process.env.API_SECRET && secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (clientStatus !== 'READY') {
    return res.status(503).json({ error: 'WhatsApp not ready', status: clientStatus });
  }

  const results = [];
  for (const { to, message } of messages) {
    try {
      const formattedNumber = to.replace(/\D/g, '') + '@c.us';
      await client.sendMessage(formattedNumber, message);
      results.push({ to, success: true });
      // Small delay between messages to avoid spam detection
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      results.push({ to, success: false, error: err.message });
    }
  }

  res.json({ results });
});

// Restart WhatsApp client
app.post('/restart', async (req, res) => {
  const { secret } = req.body;
  if (process.env.API_SECRET && secret !== process.env.API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (client) {
    try { await client.destroy(); } catch (e) {}
  }
  clientStatus = 'DISCONNECTED';
  retryCount = 0;
  
  setTimeout(initWhatsApp, 2000);
  res.json({ success: true, message: 'Restarting WhatsApp client...' });
});


// ===== START SERVER =====
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🟢 ZidFlow WhatsApp Server running on port ${PORT}`);
  console.log(`📱 Open /qr to scan WhatsApp QR Code\n`);
});
