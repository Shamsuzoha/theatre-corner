require('dotenv').config();
const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'secret123';

// ── DB ─────────────────────────────────────────────
const pool = mysql.createPool({
  host:     process.env.DB_HOST,
  port:     parseInt(process.env.DB_PORT) || 3306,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }
});

const db = async (sql, params = []) => {
  const [rows] = await pool.execute(sql, params);
  return rows;
};

// ── DEBUG (remove after confirming connection works) ──
app.get('/api/debug', async (req, res) => {
  try {
    await pool.execute('SELECT 1');
    res.json({
      status: 'connected',
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      database: process.env.DB_NAME,
      pass_set: !!process.env.DB_PASS
    });
  } catch (e) {
    res.status(500).json({
      status: 'failed',
      error: e.message,
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      database: process.env.DB_NAME,
      pass_set: !!process.env.DB_PASS
    });
  }
});

// ── AUTH MIDDLEWARE ────────────────────────────────
function auth(requiredRole = null) {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token' });
    try {
      const user = jwt.verify(token, JWT_SECRET);
      req.user = user;
      if (requiredRole && user.role !== requiredRole)
        return res.status(403).json({ message: 'Forbidden' });
      next();
    } catch {
      res.status(401).json({ message: 'Invalid token' });
    }
  };
}

// ── PROGRESSIVE LOCKOUT ────────────────────────────
// NOTE: In-memory — resets on each cold start in serverless.
// For persistent lockout on Vercel, move this to a DB table.
const loginAttempts = {};

const LOCKOUT_SCHEDULE = [
  { threshold: 5, duration: 5  * 60 * 1000 },
  { threshold: 6, duration: 15 * 60 * 1000 },
  { threshold: 7, duration: 45 * 60 * 1000 },
  { threshold: 8, duration:  3 * 60 * 60 * 1000 },
  { threshold: 9, duration: 24 * 60 * 60 * 1000 },
];

function getLockout(username) {
  const entry = loginAttempts[username];
  if (!entry) return null;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    const remaining = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    return { locked: true, remaining };
  }
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    entry.lockedUntil = null;
  }
  return null;
}

function recordFailure(username) {
  if (!loginAttempts[username]) {
    loginAttempts[username] = { count: 0, lockedUntil: null };
  }
  const entry = loginAttempts[username];
  entry.count += 1;
  const tier = [...LOCKOUT_SCHEDULE].reverse().find(t => entry.count >= t.threshold);
  if (tier) {
    entry.lockedUntil = Date.now() + tier.duration;
  }
  return entry.count;
}

function recordSuccess(username) {
  delete loginAttempts[username];
}

function formatDuration(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60)   return `${s} seconds`;
  if (s < 3600) return `${Math.ceil(s / 60)} minutes`;
  return `${Math.ceil(s / 3600)} hours`;
}

// ── LOGIN ──────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { name, password } = req.body;
  if (!name || !password)
    return res.status(400).json({ message: 'Username and password required' });

  const lockout = getLockout(name);
  if (lockout?.locked) {
    const mins = Math.ceil(lockout.remaining / 60);
    const timeStr = lockout.remaining >= 3600
      ? `${Math.ceil(lockout.remaining / 3600)} hour${Math.ceil(lockout.remaining / 3600) > 1 ? 's' : ''}`
      : lockout.remaining >= 60
        ? `${mins} minute${mins > 1 ? 's' : ''}`
        : `${lockout.remaining} seconds`;
    return res.status(429).json({
      message: `Account locked. Try again in ${timeStr}.`,
      locked: true,
      remaining: lockout.remaining
    });
  }

  let role = null;
  if      (name === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) role = 'admin';
  else if (name === process.env.USER_USER  && password === process.env.USER_PASS)  role = 'user';

  if (!role) {
    const count = recordFailure(name);
    const entry = loginAttempts[name];
    if (entry.lockedUntil) {
      const duration = formatDuration(entry.lockedUntil - Date.now());
      return res.status(429).json({
        message: `Too many failed attempts. Account locked for ${duration}.`,
        locked: true,
        remaining: Math.ceil((entry.lockedUntil - Date.now()) / 1000)
      });
    }
    if (count === 3) {
      return res.status(401).json({
        message: 'Invalid credentials.',
        warning: 'Warning: 2 more failed attempts will lock this account for 5 minutes.'
      });
    }
    if (count === 4) {
      return res.status(401).json({
        message: 'Invalid credentials.',
        warning: '⚠ Last attempt before account is locked for 5 minutes!'
      });
    }
    return res.status(401).json({ message: 'Invalid credentials.' });
  }

  recordSuccess(name);
  const token = jwt.sign({ name, role }, JWT_SECRET, { expiresIn: '1d' });
  res.json({ token, role });
});

// ── EDIT HISTORY ───────────────────────────────────
async function addHistory(action, type, detail, userName) {
  try {
    await db(
      'INSERT INTO EditHistory (Action, Type, Detail, UserName) VALUES (?,?,?,?)',
      [action, type, detail, userName || 'system']
    );
  } catch (e) {
    console.error('History insert failed:', e.message);
  }
}

app.get('/api/history', auth('admin'), async (req, res) => {
  try {
    const rows = await db('SELECT * FROM EditHistory ORDER BY ID DESC LIMIT 200');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.delete('/api/history', auth('admin'), async (req, res) => {
  try {
    await db('DELETE FROM EditHistory');
    res.json({ message: 'Cleared' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── PURGE endpoint (called by Vercel Cron) ─────────
// Vercel cron hits GET /api/purge every hour — no auth needed
// since it's only triggered server-side and deletes nothing sensitive.
app.get('/api/purge', async (req, res) => {
  try {
    const [result] = await pool.execute(
      'DELETE FROM ItemPurchased WHERE PurchasedAt < NOW() - INTERVAL 7 DAY'
    );
    console.log(`[purge] Removed ${result.affectedRows} record(s)`);
    res.json({ deleted: result.affectedRows });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── VENDORS ────────────────────────────────────────
app.get('/api/vendors', auth(), async (req, res) => {
  res.json(await db('SELECT * FROM Vendors'));
});

app.post('/api/vendors', auth(), async (req, res) => {
  try {
    const { Name, Phone, TotalPaid = 0, Remaining = 0 } = req.body;
    if (!Name) return res.status(400).json({ message: 'Name required' });
    await db(
      'INSERT INTO Vendors (Name, Phone, TotalPaid, Remaining) VALUES (?,?,?,?)',
      [Name, Phone || null, Math.round(TotalPaid), Math.round(Remaining)]
    );
    await addHistory('create', 'vendor', `Created vendor "${Name}"`, req.user?.name);
    res.json({ message: 'Created' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.put('/api/vendors/:id', auth('admin'), async (req, res) => {
  try {
    const { Phone, TotalPaid, Remaining } = req.body;
    await db(
      'UPDATE Vendors SET Phone=?, TotalPaid=?, Remaining=? WHERE Name=?',
      [Phone ?? null, Math.round(TotalPaid ?? 0), Math.round(Remaining ?? 0), req.params.id]
    );
    await addHistory('update', 'vendor', `Updated vendor "${req.params.id}"`, req.user?.name);
    res.json({ message: 'Updated' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/vendors/:id/pay', auth(), async (req, res) => {
  try {
    const amount = Math.round(parseFloat(req.body.amount));
    if (!amount || amount <= 0) return res.status(400).json({ message: 'Invalid amount' });
    const [rows] = await pool.execute('SELECT * FROM Vendors WHERE Name=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: 'Vendor not found' });
    const v = rows[0];
    const newPaid      = parseInt(v.TotalPaid) + amount;
    const newRemaining = Math.max(0, parseInt(v.Remaining) - amount);
    await db('INSERT INTO VendorPayments (VendorName, Amount, PaidAt) VALUES (?,?,NOW())', [req.params.id, amount]);
    await db('UPDATE Vendors SET TotalPaid=?, Remaining=? WHERE Name=?', [newPaid, newRemaining, req.params.id]);
    await addHistory('update', 'vendor', `Paid ${amount} to vendor "${req.params.id}" — Remaining: ${newRemaining}`, req.user?.name);
    res.json({ message: 'Payment recorded', newPaid, newRemaining });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE vendor — detaches items, does NOT delete them
app.delete('/api/vendors/:id', auth('admin'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('UPDATE Items SET VendorName = NULL WHERE VendorName = ?', [req.params.id]);
    await conn.execute('DELETE FROM Vendors WHERE Name=?', [req.params.id]);
    await conn.commit();
    await addHistory('delete', 'vendor', `Deleted vendor "${req.params.id}"`, req.user?.name);
    res.json({ message: 'Deleted' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ message: e.message });
  } finally {
    conn.release();
  }
});

// ── VENDOR PAYMENT STATS ───────────────────────────
app.get('/api/vendor-payments/stats', auth(), async (req, res) => {
  try {
    const rows = await db(`
      SELECT
        COALESCE(SUM(CASE WHEN DATE(PaidAt) = CURDATE() THEN Amount ELSE 0 END),0) AS daily,
        COALESCE(SUM(CASE WHEN MONTH(PaidAt)=MONTH(NOW()) AND YEAR(PaidAt)=YEAR(NOW()) THEN Amount ELSE 0 END),0) AS monthly,
        COALESCE(SUM(CASE WHEN YEAR(PaidAt)=YEAR(NOW()) THEN Amount ELSE 0 END),0) AS yearly,
        COALESCE(SUM(Amount),0) AS total
      FROM VendorPayments
    `);
    res.json(rows[0] || { daily: 0, monthly: 0, yearly: 0, total: 0 });
  } catch (e) {
    res.json({ daily: 0, monthly: 0, yearly: 0, total: 0 });
  }
});

// ── VENDOR ORDERS ──────────────────────────────────
app.get('/api/vendor-orders', auth(), async (req, res) => {
  const isAdmin = req.user?.role === 'admin';
  const rows = await db(`
    SELECT
      v.Name           AS VendorName,
      v.Phone          AS VendorPhone,
      v.TotalPaid,
      v.Remaining,
      i.ID             AS ItemID,
      i.Name           AS ItemName,
      i.Price          AS ItemPrice,
      ${isAdmin ? 'i.BuyingPrice AS BuyingPrice,' : ''}
      i.Count          AS QuantityInStock,
      i.OrderedQty     AS OrderedQty
    FROM Vendors v
    LEFT JOIN Items i ON i.VendorName = v.Name
    ORDER BY v.Name, i.Name
  `);
  res.json(rows);
});

// ── ITEMS ──────────────────────────────────────────
app.get('/api/items', auth(), async (req, res) => {
  const isAdmin = req.user?.role === 'admin';
  const cols = isAdmin
    ? 'ID, Name, Price, BuyingPrice, Count, OrderedQty, VendorName'
    : 'ID, Name, Price, Count, OrderedQty, VendorName';
  res.json(await db(`SELECT ${cols} FROM Items`));
});

app.post('/api/items', auth(), async (req, res) => {
  try {
    const { ID, Name, Price, BuyingPrice, Count = 0, VendorName } = req.body;
    if (!Name || Price == null || !VendorName)
      return res.status(400).json({ message: 'Name, Price, VendorName required' });
    const orderedQty = Math.round(Count);
    const buyingPriceVal = (BuyingPrice != null && BuyingPrice !== '') ? Math.round(BuyingPrice) : null;
    await db(
      'INSERT INTO Items (ID, Name, Price, BuyingPrice, Count, OrderedQty, VendorName) VALUES (?,?,?,?,?,?,?)',
      [ID || null, Name, Math.round(Price), buyingPriceVal, Math.round(Count), orderedQty, VendorName]
    );
    await addHistory('create', 'item', `Created item "${Name}" — Price: ${Math.round(Price)}, Vendor: ${VendorName}`, req.user?.name);
    res.json({ message: 'Created' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.put('/api/items/:id', auth(), async (req, res) => {
  try {
    const { Name, Price, BuyingPrice, Count, VendorName, OrderedQty } = req.body;
    const isAdmin = req.user?.role === 'admin';
    if (isAdmin) {
      const buyingPriceVal = (BuyingPrice != null && BuyingPrice !== '') ? Math.round(BuyingPrice) : null;
      await db(
        'UPDATE Items SET Name=?, Price=?, BuyingPrice=?, Count=?, OrderedQty=?, VendorName=? WHERE ID=?',
        [Name, Math.round(Price), buyingPriceVal, Math.round(Count), Math.round(OrderedQty ?? Count), VendorName, req.params.id]
      );
    } else {
      await db(
        'UPDATE Items SET Name=?, Price=?, Count=?, VendorName=? WHERE ID=?',
        [Name, Math.round(Price), Math.round(Count), VendorName, req.params.id]
      );
    }
    await addHistory('update', 'item', `Updated item "${Name}" (ID ${req.params.id})`, req.user?.name);
    res.json({ message: 'Updated' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE item — nullifies purchase history references, does NOT delete order history
app.delete('/api/items/:id', auth('admin'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('UPDATE ItemPurchased SET ItemID = NULL WHERE ItemID = ?', [req.params.id]);
    await conn.execute('DELETE FROM Items WHERE ID=?', [req.params.id]);
    await conn.commit();
    await addHistory('delete', 'item', `Deleted item ID "${req.params.id}"`, req.user?.name);
    res.json({ message: 'Deleted' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ message: e.message });
  } finally {
    conn.release();
  }
});

// ── CUSTOMERS ──────────────────────────────────────
app.get('/api/customers', auth(), async (req, res) => {
  res.json(await db('SELECT * FROM Customer'));
});

app.post('/api/customers', auth(), async (req, res) => {
  try {
    const { Phone, Tabs = 0, Email, TotalSpent = 0 } = req.body;
    if (!Phone) return res.status(400).json({ message: 'Phone required' });
    await db(
      'INSERT INTO Customer (Phone, Tabs, Email, TotalSpent) VALUES (?,?,?,?)',
      [Phone, Math.round(Tabs), Email || null, Math.round(TotalSpent)]
    );
    await addHistory('create', 'customer', `Created customer ${Phone}${Email ? ' (' + Email + ')' : ''}`, req.user?.name);
    res.json({ message: 'Created' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.put('/api/customers/:phone', auth(), async (req, res) => {
  try {
    const { Tabs, Email, TotalSpent } = req.body;
    await db(
      'UPDATE Customer SET Tabs=?, Email=?, TotalSpent=? WHERE Phone=?',
      [Math.round(Tabs ?? 0), Email ?? null, Math.round(TotalSpent ?? 0), req.params.phone]
    );
    await addHistory('update', 'customer', `Updated customer ${req.params.phone}`, req.user?.name);
    res.json({ message: 'Updated' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE customer — nullifies purchase history references, does NOT delete order history
app.delete('/api/customers/:phone', auth('admin'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('UPDATE ItemPurchased SET CustomerPhone = NULL WHERE CustomerPhone = ?', [req.params.phone]);
    await conn.execute('DELETE FROM Customer WHERE Phone=?', [req.params.phone]);
    await conn.commit();
    await addHistory('delete', 'customer', `Deleted customer ${req.params.phone}`, req.user?.name);
    res.json({ message: 'Deleted' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ message: e.message });
  } finally {
    conn.release();
  }
});

// ── PURCHASES ──────────────────────────────────────
app.get('/api/purchases', auth(), async (req, res) => {
  res.json(await db('SELECT * FROM ItemPurchased'));
});

app.get('/api/purchases/full', auth(), async (req, res) => {
  const rows = await db(`
    SELECT
      ip.ID           AS PurchaseID,
      ip.CustomerPhone,
      ip.ItemID,
      ip.Quantity,
      ip.PurchasedAt,
      i.Name          AS ItemName,
      i.Price         AS ItemPrice,
      c.Email         AS CustomerEmail,
      c.TotalSpent
    FROM ItemPurchased ip
    LEFT JOIN Items i         ON ip.ItemID = i.ID
    LEFT JOIN Customer c      ON ip.CustomerPhone = c.Phone
    ORDER BY ip.ID DESC
  `);
  res.json(rows);
});

// ── DASHBOARD STATS ────────────────────────────────
app.get('/api/stats/dashboard', auth(), async (req, res) => {
  try {
    const [orderStats] = await pool.execute(`
      SELECT
        COALESCE(SUM(CASE WHEN DATE(ip.PurchasedAt) = CURDATE() THEN ip.Quantity ELSE 0 END),0)                                             AS soldStockDaily,
        COALESCE(SUM(CASE WHEN MONTH(ip.PurchasedAt)=MONTH(NOW()) AND YEAR(ip.PurchasedAt)=YEAR(NOW()) THEN ip.Quantity ELSE 0 END),0)      AS soldStockMonthly,
        COALESCE(SUM(CASE WHEN YEAR(ip.PurchasedAt)=YEAR(NOW()) THEN ip.Quantity ELSE 0 END),0)                                             AS soldStockYearly,
        COALESCE(SUM(ip.Quantity),0)                                                                                                        AS soldStockTotal,

        COALESCE(SUM(CASE WHEN DATE(ip.PurchasedAt) = CURDATE() THEN ip.Quantity * i.Price ELSE 0 END),0)                                   AS soldValueDaily,
        COALESCE(SUM(CASE WHEN MONTH(ip.PurchasedAt)=MONTH(NOW()) AND YEAR(ip.PurchasedAt)=YEAR(NOW()) THEN ip.Quantity * i.Price ELSE 0 END),0) AS soldValueMonthly,
        COALESCE(SUM(CASE WHEN YEAR(ip.PurchasedAt)=YEAR(NOW()) THEN ip.Quantity * i.Price ELSE 0 END),0)                                   AS soldValueYearly,
        COALESCE(SUM(ip.Quantity * i.Price),0)                                                                                              AS soldValueTotal,

        COALESCE(COUNT(CASE WHEN DATE(ip.PurchasedAt) = CURDATE() THEN 1 END),0)                                                           AS ordersDaily,
        COALESCE(COUNT(CASE WHEN MONTH(ip.PurchasedAt)=MONTH(NOW()) AND YEAR(ip.PurchasedAt)=YEAR(NOW()) THEN 1 END),0)                    AS ordersMonthly,
        COALESCE(COUNT(CASE WHEN YEAR(ip.PurchasedAt)=YEAR(NOW()) THEN 1 END),0)                                                           AS ordersYearly,
        COALESCE(COUNT(*),0)                                                                                                               AS ordersTotal,

        COALESCE(SUM(CASE WHEN DATE(ip.PurchasedAt) = CURDATE() AND i.BuyingPrice IS NOT NULL AND i.OrderedQty > 0
          THEN ip.Quantity * (i.Price - (i.BuyingPrice / i.OrderedQty)) ELSE 0 END),0)                                                     AS profitDaily,
        COALESCE(SUM(CASE WHEN MONTH(ip.PurchasedAt)=MONTH(NOW()) AND YEAR(ip.PurchasedAt)=YEAR(NOW()) AND i.BuyingPrice IS NOT NULL AND i.OrderedQty > 0
          THEN ip.Quantity * (i.Price - (i.BuyingPrice / i.OrderedQty)) ELSE 0 END),0)                                                     AS profitMonthly,
        COALESCE(SUM(CASE WHEN YEAR(ip.PurchasedAt)=YEAR(NOW()) AND i.BuyingPrice IS NOT NULL AND i.OrderedQty > 0
          THEN ip.Quantity * (i.Price - (i.BuyingPrice / i.OrderedQty)) ELSE 0 END),0)                                                     AS profitYearly,
        COALESCE(SUM(CASE WHEN i.BuyingPrice IS NOT NULL AND i.OrderedQty > 0
          THEN ip.Quantity * (i.Price - (i.BuyingPrice / i.OrderedQty)) ELSE 0 END),0)                                                     AS profitTotal
      FROM ItemPurchased ip
      LEFT JOIN Items i ON ip.ItemID = i.ID
    `);

    const [stockRow] = await pool.execute(`SELECT COALESCE(SUM(Count),0) AS totalStock FROM Items`);

    res.json({
      ...(orderStats[0] || {}),
      totalStock: stockRow[0]?.totalStock || 0
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/purchases ────────────────────────────
app.post('/api/purchases', auth(), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const { CustomerPhone, items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0)
      return res.status(400).json({ message: 'items array required' });

    const phone = CustomerPhone || null;
    let orderTotal = 0;

    for (const line of items) {
      const { ItemID, Quantity = 1 } = line;
      if (!ItemID) throw new Error('Each item must have an ItemID');
      const qty = Math.max(1, parseInt(Quantity) || 1);

      const [itemRows] = await conn.execute('SELECT Price, Count FROM Items WHERE ID=?', [ItemID]);
      if (!itemRows.length) throw new Error(`Item #${ItemID} not found`);
      const item = itemRows[0];
      if (item.Count < qty)
        throw new Error(`Not enough stock for item #${ItemID} (have ${item.Count}, need ${qty})`);

      await conn.execute(
        'INSERT INTO ItemPurchased (CustomerPhone, ItemID, Quantity, PurchasedAt) VALUES (?,?,?,NOW())',
        [phone, ItemID, qty]
      );
      await conn.execute('UPDATE Items SET Count = Count - ? WHERE ID=?', [qty, ItemID]);
      orderTotal += parseInt(item.Price) * qty;
    }

    if (phone) {
      await conn.execute(
        'UPDATE Customer SET TotalSpent = TotalSpent + ? WHERE Phone=?',
        [orderTotal, phone]
      );
    }

    await conn.commit();
    await addHistory('order', 'order', `New order for ${phone || 'walk-in'} — Total: ${orderTotal}`, req.user?.name);
    res.json({ message: 'Order recorded', total: orderTotal });
  } catch (e) {
    await conn.rollback();
    const is4xx = e.message.includes('not found') || e.message.includes('stock') || e.message.includes('ItemID');
    res.status(is4xx ? 400 : 500).json({ message: e.message });
  } finally {
    conn.release();
  }
});

// ── DELETE /api/purchases/:id ──────────────────────
app.delete('/api/purchases/:id', auth('admin'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute('SELECT * FROM ItemPurchased WHERE ID=?', [req.params.id]);
    if (!rows.length) { await conn.rollback(); return res.status(404).json({ message: 'Not found' }); }
    const p = rows[0];

    await conn.execute('DELETE FROM ItemPurchased WHERE ID=?', [req.params.id]);

    if (p.ItemID) {
      await conn.execute('UPDATE Items SET Count = Count + ? WHERE ID=?', [p.Quantity, p.ItemID]);
    }

    if (p.CustomerPhone && p.ItemID) {
      const [itemRows] = await conn.execute('SELECT Price FROM Items WHERE ID=?', [p.ItemID]);
      if (itemRows.length) {
        const refund = parseInt(itemRows[0].Price) * p.Quantity;
        await conn.execute(
          'UPDATE Customer SET TotalSpent = GREATEST(0, TotalSpent - ?) WHERE Phone=?',
          [refund, p.CustomerPhone]
        );
      }
    }

    await conn.commit();
    await addHistory('delete', 'order', `Deleted purchase #${req.params.id}`, req.user?.name);
    res.json({ message: 'Deleted' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ message: e.message });
  } finally {
    conn.release();
  }
});

// ── EXPORT (Vercel) / LISTEN (local) ───────────────
if (require.main === module) {
  app.listen(PORT, () => console.log('Server running → http://localhost:' + PORT));
}

module.exports = app;
