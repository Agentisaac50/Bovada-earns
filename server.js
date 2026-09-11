const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PENDING_FILE = path.join(DATA_DIR, 'pending-deposits.json');

// ========== MarzPay Credentials (server-side only) ==========
const MARZ_API_KEY = process.env.MARZ_API_KEY || 'marz_UFsy6EVzcRmqkDWC';
const MARZ_API_SECRET = process.env.MARZ_API_SECRET || 'ub18BRW8PECvgzinS5CSAncqgLui6XpF';
const MARZ_AUTH = Buffer.from(`${MARZ_API_KEY}:${MARZ_API_SECRET}`).toString('base64');
const MARZ_BASE = 'https://wallet.wearemarz.com/api/v1';

const DEPOSIT_FEE_PERCENT = 5; // 5% charge
const MIN_DEPOSIT = 10000; // UGX

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ========== Pending deposits store ==========
function loadPending() {
  try {
    if (fs.existsSync(PENDING_FILE)) {
      return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading pending deposits:', e.message);
  }
  return {};
}

function savePending(data) {
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error saving pending deposits:', e.message);
  }
}

let pendingDeposits = loadPending();

// ========== Helpers ==========
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject'
};

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) {
        req.destroy();
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        if (!body) return resolve({});
        if (body.trim().startsWith('{') || body.trim().startsWith('[')) {
          resolve(JSON.parse(body));
        } else {
          const params = {};
          body.split('&').forEach(pair => {
            const [k, v] = pair.split('=').map(decodeURIComponent);
            if (k) params[k] = v || '';
          });
          resolve(params);
        }
      } catch (e) {
        resolve({ raw: body });
      }
    });
    req.on('error', reject);
  });
}

function normalizeUgPhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[\s\-\+]/g, '');
  if (p.startsWith('0') && p.length === 10) p = '256' + p.slice(1);
  if (p.startsWith('256') && p.length === 12) return '+' + p;
  if (p.length === 9 && /^[7]/.test(p)) return '+256' + p;
  return null;
}

function generateUUID() {
  return crypto.randomUUID();
}

function marzRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(MARZ_BASE + endpoint);
    const options = {
      hostname: fullUrl.hostname,
      path: fullUrl.pathname + fullUrl.search,
      method,
      headers: {
        'Authorization': `Basic ${MARZ_AUTH}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ statusCode: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: { raw: data } });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('MarzPay request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ========== API Handlers ==========

async function handleInitiateDeposit(req, res) {
  try {
    const body = await parseBody(req);
    const amount = parseFloat(body.amount);
    const userPhone = String(body.userPhone || '').trim();
    let payerPhone = normalizeUgPhone(body.phone || body.payerPhone);

    if (!amount || isNaN(amount) || amount < MIN_DEPOSIT) {
      return sendJson(res, 400, {
        success: false,
        message: `Minimum deposit is ${MIN_DEPOSIT.toLocaleString()} UGX`
      });
    }

    if (!payerPhone) {
      return sendJson(res, 400, {
        success: false,
        message: 'Valid Uganda phone number required (e.g. 07XXXXXXXX or +2567XXXXXXXX)'
      });
    }

    if (!userPhone) {
      return sendJson(res, 400, {
        success: false,
        message: 'User account phone is required'
      });
    }

    const fee = Math.round(amount * (DEPOSIT_FEE_PERCENT / 100));
    const netCredit = amount - fee;
    const reference = generateUUID();

    const host = req.headers.host || `localhost:${PORT}`;
    const protocol = (req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https'));
    const callbackUrl = `${protocol}://${host}/api/marz/webhook`;

    const payload = {
      amount: Math.round(amount),
      phone_number: payerPhone,
      country: 'UG',
      reference: reference,
      description: `Bovada Earns deposit - User ${userPhone}`,
      callback_url: callbackUrl,
      metadata: [
        { userPhone: userPhone },
        { netCredit: String(netCredit) },
        { fee: String(fee) },
        { originalAmount: String(amount) }
      ]
    };

    console.log(`[MarzPay] Initiating collection ref=${reference} amount=${amount} phone=${payerPhone}`);

    const result = await marzRequest('POST', '/collect-money', payload);

    if (result.statusCode >= 200 && result.statusCode < 300 &&
        (result.data.status === 'success' || result.data.success === true)) {

      const txn = result.data.data?.transaction || {};
      const collection = result.data.data?.collection || {};

      pendingDeposits[reference] = {
        reference,
        uuid: txn.uuid || null,
        userPhone,
        payerPhone,
        amount: Math.round(amount),
        fee,
        netCredit,
        status: 'processing',
        provider: collection.provider || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        marzResponse: result.data
      };
      savePending(pendingDeposits);

      return sendJson(res, 200, {
        success: true,
        message: 'Payment request sent. Please approve the prompt on your phone.',
        data: {
          reference,
          uuid: txn.uuid,
          amount: Math.round(amount),
          fee,
          netCredit,
          status: 'processing',
          provider: collection.provider,
          phone: payerPhone
        }
      });
    }

    const errMsg = result.data?.message || result.data?.error || 'Failed to initiate payment';
    console.error('[MarzPay] Initiate failed:', result.statusCode, result.data);
    return sendJson(res, 400, {
      success: false,
      message: errMsg,
      details: result.data
    });
  } catch (err) {
    console.error('[Initiate] Error:', err);
    return sendJson(res, 500, {
      success: false,
      message: err.message || 'Internal server error'
    });
  }
}

async function handleDepositStatus(req, res, reference) {
  try {
    if (!reference) {
      return sendJson(res, 400, { success: false, message: 'Reference required' });
    }

    let deposit = pendingDeposits[reference];

    if (deposit && (deposit.status === 'processing' || deposit.status === 'pending')) {
      try {
        const id = deposit.uuid || reference;
        const check = await marzRequest('GET', `/transactions/${id}`);
        if (check.statusCode === 200 && check.data) {
          const status =
            check.data.transaction?.status ||
            check.data.status ||
            check.data.data?.transaction?.status ||
            check.data.event_type;

          if (status === 'completed' || status === 'collection.completed' || status === 'sandbox') {
            deposit.status = 'completed';
            deposit.updatedAt = new Date().toISOString();
            deposit.completedAt = new Date().toISOString();
            pendingDeposits[reference] = deposit;
            savePending(pendingDeposits);
          } else if (status === 'failed' || status === 'collection.failed' || status === 'cancelled') {
            deposit.status = 'failed';
            deposit.updatedAt = new Date().toISOString();
            pendingDeposits[reference] = deposit;
            savePending(pendingDeposits);
          }
        }
      } catch (pollErr) {
        console.warn('[Status] Poll MarzPay failed (non-fatal):', pollErr.message);
      }
    }

    deposit = pendingDeposits[reference];
    if (!deposit) {
      return sendJson(res, 404, {
        success: false,
        message: 'Deposit not found',
        status: 'not_found'
      });
    }

    return sendJson(res, 200, {
      success: true,
      data: {
        reference: deposit.reference,
        status: deposit.status,
        amount: deposit.amount,
        fee: deposit.fee,
        netCredit: deposit.netCredit,
        userPhone: deposit.userPhone,
        payerPhone: deposit.payerPhone,
        provider: deposit.provider,
        createdAt: deposit.createdAt,
        completedAt: deposit.completedAt || null
      }
    });
  } catch (err) {
    console.error('[Status] Error:', err);
    return sendJson(res, 500, { success: false, message: err.message });
  }
}

async function handleMarzWebhook(req, res) {
  try {
    const body = await parseBody(req);
    console.log('[Webhook] Received:', JSON.stringify(body).slice(0, 500));

    const eventType = body.event_type || body.event || '';
    const transaction = body.transaction || body.data?.transaction || {};
    const collection = body.collection || body.data?.collection || {};
    const reference = transaction.reference || body.reference;

    if (!reference) {
      console.warn('[Webhook] No reference found');
      return sendJson(res, 200, { received: true });
    }

    let deposit = pendingDeposits[reference];
    if (!deposit) {
      deposit = {
        reference,
        uuid: transaction.uuid || null,
        userPhone: null,
        payerPhone: collection.phone_number || transaction.phone_number,
        amount: transaction.amount?.raw || collection.amount?.raw || 0,
        fee: 0,
        netCredit: 0,
        status: 'unknown',
        createdAt: new Date().toISOString()
      };
      if (Array.isArray(body.metadata)) {
        body.metadata.forEach(m => {
          if (m.userPhone) deposit.userPhone = m.userPhone;
          if (m.netCredit) deposit.netCredit = parseFloat(m.netCredit);
          if (m.fee) deposit.fee = parseFloat(m.fee);
          if (m.originalAmount) deposit.amount = parseFloat(m.originalAmount);
        });
      }
    }

    if (eventType === 'collection.completed' || transaction.status === 'completed' || transaction.status === 'sandbox') {
      deposit.status = 'completed';
      deposit.completedAt = new Date().toISOString();
      deposit.provider = collection.provider || transaction.provider;
      deposit.providerTransactionId = collection.provider_transaction_id || null;
      console.log(`[Webhook] ✅ Deposit COMPLETED ref=${reference} net=${deposit.netCredit}`);
    } else if (eventType === 'collection.failed' || transaction.status === 'failed' || transaction.status === 'cancelled') {
      deposit.status = 'failed';
      deposit.failedAt = new Date().toISOString();
      console.log(`[Webhook] ❌ Deposit FAILED ref=${reference}`);
    }

    deposit.updatedAt = new Date().toISOString();
    deposit.webhookPayload = body;
    pendingDeposits[reference] = deposit;
    savePending(pendingDeposits);

    return sendJson(res, 200, { received: true, status: deposit.status });
  } catch (err) {
    console.error('[Webhook] Error:', err);
    return sendJson(res, 200, { received: true, error: err.message });
  }
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        const indexPath = path.join(PUBLIC_DIR, 'index.html');
        fs.readFile(indexPath, (err2, indexData) => {
          if (err2) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(indexData);
        });
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ========== Server ==========
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  let pathname = parsedUrl.pathname;

  if (pathname === '/api/health') {
    return sendJson(res, 200, {
      status: 'ok',
      message: 'Bovada Earns server is running',
      marzpay: 'configured',
      timestamp: new Date().toISOString()
    });
  }

  if (pathname === '/api/deposit/initiate' && req.method === 'POST') {
    return handleInitiateDeposit(req, res);
  }

  if (pathname.startsWith('/api/deposit/status/') && req.method === 'GET') {
    const reference = pathname.replace('/api/deposit/status/', '').trim();
    return handleDepositStatus(req, res, reference);
  }

  if (pathname === '/api/marz/webhook' && req.method === 'POST') {
    return handleMarzWebhook(req, res);
  }

  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  sendFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║         Bovada Earns Server Started                   ║
╠══════════════════════════════════════════════════════════╣
║  Local:     http://localhost:${PORT}                        ║
║  Status:    Running                                      ║
║  MarzPay:   Integrated (Collections)                     ║
║  Fee:       ${DEPOSIT_FEE_PERCENT}% | Min deposit: ${MIN_DEPOSIT.toLocaleString()} UGX            ║
║  Webhook:   /api/marz/webhook                            ║
╚══════════════════════════════════════════════════════════╝
  `);
});
