require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDb() {
  try {
    await pool.query('SELECT NOW();');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS purchases (
        id                 SERIAL PRIMARY KEY,
        email              VARCHAR(255) NOT NULL,
        product_id         VARCHAR(255) NOT NULL,
        active_session_id  VARCHAR(255),
        created_at         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at         TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (email, product_id)
      );

      CREATE TABLE IF NOT EXISTS otps (
        id         SERIAL PRIMARY KEY,
        email      VARCHAR(255) NOT NULL,
        otp_code   VARCHAR(6) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Connected to Neon and tables verified.');
  } catch (err) {
    console.error('❌ Database initialization failed:', err);
    process.exit(1);
  }
}

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const color = status >= 500 ? '\x1b[31m' : status >= 400 ? '\x1b[33m' : '\x1b[32m';
    console.log(`${color}[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${status} (${ms}ms)\x1b[0m`);
  });
  next();
});

app.get('/', (req, res) => res.json({ status: 'Server running' }));

// GET /gatekeeper.js
app.get('/gatekeeper.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'gatekeeper.js'));
});

app.post('/api/webhooks/ghl-order', async (req, res) => {
  const body = req.body;

  console.log('\n\x1b[35m================================================');
  console.log('📦 GHL WEBHOOK HIT - ' + new Date().toISOString());
  console.log('================================================\x1b[0m');
  console.log('\x1b[36mHEADERS:\x1b[0m', JSON.stringify(req.headers, null, 2));
  console.log('\x1b[36mFULL RAW BODY:\x1b[0m', JSON.stringify(body, null, 2));
  console.log('\x1b[33m--- Key fields GHL sent ---');
  console.log('email          :', body.email);
  console.log('contact.email  :', body.contact?.email);
  console.log('order          :', JSON.stringify(body.order, null, 2));
  console.log('line_items     :', JSON.stringify(body.order?.line_items, null, 2));
  console.log('global_prod_ids:', JSON.stringify(body.order?.line_item_global_product_ids, null, 2));
  console.log('\x1b[0m');

  const email = body.email || body.contact?.email;
  if (!email) return res.status(400).json({ error: 'Missing email' });

  const lineItems = body.order?.line_items || [];
  let productIds = lineItems.length > 0
    ? lineItems.map(item => item.meta?.product_id || item.id).filter(Boolean)
    : (body.order?.line_item_global_product_ids || []);

  if (productIds.length === 0) productIds = ['default_product'];

  try {
    for (const productId of productIds) {
      await pool.query(
        `INSERT INTO purchases (email, product_id)
         VALUES ($1, $2)
         ON CONFLICT (email, product_id) DO UPDATE
         SET updated_at = NOW();`,
        [email, productId]
      );
      console.log(`✅ Recorded purchase: ${email} -> Product ID: ${productId}`);
    }

    res.status(200).json({ success: true, count: productIds.length });
  } catch (err) {
    console.error('❌ Webhook DB error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/request-otp
app.post('/api/auth/request-otp', async (req, res) => {
  const { email, productId } = req.body;

  const purchase = await pool.query(
    `SELECT id FROM purchases WHERE LOWER(email) = LOWER($1) AND product_id = $2;`,
    [email, productId]
  );
  if (purchase.rows.length === 0)
    return res.status(403).json({ error: 'No active license found for this email and product.' });

  const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

  await pool.query(`DELETE FROM otps WHERE LOWER(email) = LOWER($1);`, [email]);
  await pool.query(
    `INSERT INTO otps (email, otp_code, expires_at) VALUES (LOWER($1), $2, NOW() + INTERVAL '10 minutes');`,
    [email, otpCode]
  );

  console.log(`🔑 [OTP ISSUED] Email: ${email} | Code: ${otpCode} | Product: ${productId}`);

  const { error: emailError } = await resend.emails.send({
    from: 'Verification Code <noreply@auth.novacreatives.co>',
    to: email,
    subject: 'Your verification code',
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#ffffff;">
        <h2 style="margin:0 0 8px;font-size:22px;color:#0f172a;">Your verification code</h2>
        <p style="margin:0 0 24px;font-size:15px;color:#475569;">Use the code below to verify your identity and unlock access to your purchase.</p>
        <div style="background:#f1f5f9;border-radius:10px;padding:24px;text-align:center;margin-bottom:24px;">
          <span style="font-size:36px;font-weight:700;letter-spacing:10px;color:#0f172a;">${otpCode}</span>
        </div>
        <p style="margin:0 0 8px;font-size:13px;color:#94a3b8;">This code expires in <strong>10 minutes</strong> and can only be used once.</p>
        <p style="margin:0;font-size:13px;color:#94a3b8;">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `
  });

  if (emailError) {
    console.error('❌ Resend error:', emailError);
    return res.status(500).json({ error: 'Failed to send verification email.' });
  }

  res.status(200).json({ success: true, message: 'OTP generated' });
});

// POST /api/auth/verify-otp
app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, productId, otpCode } = req.body;

  const result = await pool.query(
    `SELECT id FROM otps WHERE LOWER(email) = LOWER($1) AND otp_code = $2 AND expires_at > NOW();`,
    [email, otpCode]
  );
  if (result.rows.length === 0)
    return res.status(401).json({ error: 'Invalid or expired OTP code' });

  await pool.query(`DELETE FROM otps WHERE id = $1;`, [result.rows[0].id]);

  const sessionToken = crypto.randomBytes(32).toString('hex');

  await pool.query(
    `UPDATE purchases SET active_session_id = $1, updated_at = NOW() WHERE LOWER(email) = LOWER($2) AND product_id = $3;`,
    [sessionToken, email, productId]
  );

  res.status(200).json({ success: true, sessionToken });
});

// POST /api/auth/validate-session
app.post('/api/auth/validate-session', async (req, res) => {
  const { email, productId, sessionToken } = req.body;

  const result = await pool.query(
    `SELECT id FROM purchases WHERE LOWER(email) = LOWER($1) AND product_id = $2 AND active_session_id = $3;`,
    [email, productId, sessionToken]
  );

  if (result.rows.length > 0)
    return res.status(200).json({ valid: true });

  res.status(401).json({ valid: false, error: 'Session expired or active on another device.' });
});

initDb().catch(console.error);

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
