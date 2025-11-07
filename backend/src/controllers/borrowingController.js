// backend/src/controllers/borrowingController.js
const pool = require('../db');
const dotenv = require('dotenv');
dotenv.config();
const socket = require('../socket');

const BORROW_INTEREST_PCT = 0.10; // 10%
const MAIN_PERIOD_DAYS = 30;
const VALIDITY_PERIOD_DAYS = 7;

function dateAddDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * POST /api/people/:id/borrow
 * Body: { poolType: "MAIN"|"VALIDITY", amount: number, adminOverride?: boolean, adminPassword?: string }
 */
async function borrow(req, res) {
  const personId = parseInt(req.params.id, 10);
  const { poolType, amount, adminOverride = false, adminPassword } = req.body;
  const amt = parseFloat(amount);

  if (!['MAIN', 'VALIDITY'].includes(poolType)) {
    return res.status(400).json({ error: 'poolType must be MAIN or VALIDITY' });
  }
  if (!amt || amt <= 0) {
    return res.status(400).json({ error: 'amount must be > 0' });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Lock personal_balance for this person
    const [personalRows] = await conn.query('SELECT * FROM personal_balance WHERE person_id = ? FOR UPDATE', [personId]);
    const personal = personalRows[0];
    if (!personal) {
      await conn.rollback();
      return res.status(400).json({ error: 'Personal balance row not found for person. Create personal_balance row first.' });
    }

    // Lock group_pool for this poolType
    const [groupRows] = await conn.query('SELECT * FROM group_pool WHERE pool_type = ? FOR UPDATE', [poolType]);
    const group = groupRows[0];
    if (!group) {
      await conn.rollback();
      return res.status(500).json({ error: 'Group pool not initialized for ' + poolType });
    }

    // If adminOverride requested, validate password
    let isAdminOverride = false;
    if (adminOverride) {
      const ADMIN_PW = process.env.ADMIN_PASSWORD || '';
      if (!adminPassword || adminPassword !== ADMIN_PW) {
        await conn.rollback();
        return res.status(403).json({ error: 'Admin password required/invalid for override' });
      }
      isAdminOverride = true;
    }

    // Check saved-count (must have saved >= 3) unless admin override
    if (!isAdminOverride) {
      const [savedRows] = await conn.query('SELECT COUNT(*) as cnt FROM payment WHERE person_id = ? AND type = "UNIT"', [personId]);
      const savedCount = savedRows[0] ? parseInt(savedRows[0].cnt, 10) : 0;
      if (savedCount < 3) {
        await conn.rollback();
        return res.status(400).json({ error: 'Borrow denied: user must have saved at least 3 times', savedCount });
      }
    }

    // Check for existing open borrowing in the SAME pool (allow other pool)
    if (!isAdminOverride) {
      const [openBorrowings] = await conn.query('SELECT COUNT(*) as cnt FROM borrowing WHERE person_id = ? AND status = "OPEN" AND pool_type = ?', [personId, poolType]);
      if (openBorrowings[0].cnt > 0) {
        await conn.rollback();
        return res.status(400).json({ error: `Cannot borrow from ${poolType} while you have an open ${poolType} debt` });
      }
    }

    // Compute personal limit = 130% of the person's corresponding personal pool balance (unless admin override)
    const personPoolBalance = poolType === 'MAIN' ? parseFloat(personal.main_savings_balance) : parseFloat(personal.validity_savings_balance);
    const allowedLimit = +(personPoolBalance * 1.30).toFixed(2);
    if (!isAdminOverride && amt > allowedLimit) {
      await conn.rollback();
      return res.status(400).json({
        error: 'Requested amount exceeds your allowed limit.',
        allowedLimit
      });
    }

    // Check group pool available funds (always enforced)
    const groupBalance = parseFloat(group.balance);
    if (amt > groupBalance) {
      await conn.rollback();
      return res.status(400).json({ error: `Insufficient funds in group pool: available ${groupBalance.toFixed(2)}` });
    }

    // Compute profit and outstanding
    const profit = +(amt * BORROW_INTEREST_PCT).toFixed(2);
    const outstanding = +(amt + profit).toFixed(2);
    const periodDays = poolType === 'MAIN' ? MAIN_PERIOD_DAYS : VALIDITY_PERIOD_DAYS;
    const today = new Date().toISOString().slice(0, 10);
    const dueDate = dateAddDays(today, periodDays);

    // Insert borrowing record
    const [insertResult] = await conn.query(
      'INSERT INTO borrowing (person_id, pool_type, principal, initial_profit_amount, outstanding_amount, due_date) VALUES (?, ?, ?, ?, ?, ?)',
      [personId, poolType, amt, profit, outstanding, dueDate]
    );

    // Decrease the group pool by the principal
    await conn.query('UPDATE group_pool SET balance = balance - ? WHERE id = ?', [amt, group.id]);

    // Log transaction
    const [gpNow] = await conn.query('SELECT balance FROM group_pool WHERE pool_type = ?', [poolType]);
    const resultGroupBalance = gpNow[0] ? parseFloat(gpNow[0].balance) : null;
    await conn.query(
      'INSERT INTO transaction_log (person_id, transaction_type, details, amount, resulting_group_main_balance, resulting_group_validity_balance) VALUES (?, "BORROW", ?, ?, ?, ?)',
      [
        personId,
        JSON.stringify({ poolType, principal: amt, profit, borrowingId: insertResult.insertId, adminOverride: isAdminOverride }),
        amt,
        poolType === 'MAIN' ? resultGroupBalance : null,
        poolType === 'VALIDITY' ? resultGroupBalance : null
      ]
    );

    await conn.commit();

    // Emit socket update (person + global)
    socket.emitUpdate({ personId, type: 'borrow' });
    socket.emitUpdate({ personId: 0, type: 'group' });

    return res.json({ ok: true, borrowingId: insertResult.insertId, outstanding, dueDate, adminOverride: isAdminOverride });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('borrow error:', err);
    return res.status(500).json({ error: 'DB error', details: err.message });
  } finally {
    if (conn) conn.release();
  }
}

/**
 * POST /api/people/:id/repay
 * Body: { borrowingId, amount }
 */
async function repay(req, res) {
  const personId = parseInt(req.params.id, 10);
  const { borrowingId, amount } = req.body;
  const amt = parseFloat(amount);

  if (!amt || amt <= 0) {
    return res.status(400).json({ error: 'amount must be > 0' });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [borrowRows] = await conn.query('SELECT * FROM borrowing WHERE id = ? FOR UPDATE', [borrowingId]);
    const borrow = borrowRows[0];
    if (!borrow) {
      await conn.rollback();
      return res.status(404).json({ error: 'Borrowing not found' });
    }
    if (borrow.person_id !== personId) {
      await conn.rollback();
      return res.status(403).json({ error: 'Borrowing does not belong to this person' });
    }
    if (borrow.status !== 'OPEN') {
      await conn.rollback();
      return res.status(400).json({ error: 'Borrowing is not open' });
    }

    const outstanding = parseFloat(borrow.outstanding_amount);
    if (amt > outstanding) {
      await conn.rollback();
      return res.status(400).json({
        error: 'OVERPAYMENT',
        message: `Payment exceeds outstanding amount. Outstanding is ${outstanding.toFixed(2)}.`,
        outstandingAmount: outstanding
      });
    }

    const newOutstanding = +(outstanding - amt).toFixed(2);
    const newStatus = newOutstanding === 0 ? 'PAID' : 'OPEN';
    await conn.query('UPDATE borrowing SET outstanding_amount = ?, status = ?, last_payment_at = NOW() WHERE id = ?', [newOutstanding, newStatus, borrowingId]);

    // Increase group pool by repayment
    await conn.query('UPDATE group_pool SET balance = balance + ? WHERE pool_type = ?', [amt, borrow.pool_type]);

    // Insert payment and log
    await conn.query('INSERT INTO payment (person_id, type, amount, applied_to_borrowing_id) VALUES (?, "DEBT_PAYMENT", ?, ?)', [personId, amt, borrowingId]);
    const [gpNow] = await conn.query('SELECT pool_type, balance FROM group_pool WHERE pool_type = ?', [borrow.pool_type]);
    const gpBalance = gpNow[0] ? parseFloat(gpNow[0].balance) : null;
    await conn.query('INSERT INTO transaction_log (person_id, transaction_type, details, amount, resulting_group_main_balance, resulting_group_validity_balance) VALUES (?, "REPAYMENT", ?, ?, ?, ?)', [
      personId,
      JSON.stringify({ borrowingId, partialPayment: amt }),
      amt,
      borrow.pool_type === 'MAIN' ? gpBalance : null,
      borrow.pool_type === 'VALIDITY' ? gpBalance : null
    ]);

    await conn.commit();

    // Real-time emit
    socket.emitUpdate({ personId, type: 'repay' });
    socket.emitUpdate({ personId: 0, type: 'group' });

    return res.json({ ok: true, newOutstanding, status: newStatus });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('repay error:', err);
    return res.status(500).json({ error: 'DB error', details: err.message });
  } finally {
    if (conn) conn.release();
  }
}

/**
 * POST /api/people/:id/pay_full
 * Body: { poolType }
 */
async function payFull(req, res) {
  const personId = parseInt(req.params.id, 10);
  const { poolType } = req.body;
  if (!['MAIN', 'VALIDITY'].includes(poolType)) {
    return res.status(400).json({ error: 'poolType must be MAIN or VALIDITY' });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT * FROM borrowing WHERE person_id = ? AND pool_type = ? AND status = "OPEN" FOR UPDATE', [personId, poolType]);
    const b = rows[0];
    if (!b) {
      await conn.rollback();
      return res.status(404).json({ error: 'No open borrowing found for this pool' });
    }

    const outstanding = parseFloat(b.outstanding_amount);

    await conn.query('UPDATE borrowing SET outstanding_amount = 0, status = "PAID", last_payment_at = NOW() WHERE id = ?', [b.id]);
    await conn.query('UPDATE group_pool SET balance = balance + ? WHERE pool_type = ?', [outstanding, poolType]);
    await conn.query('INSERT INTO payment (person_id, type, amount, applied_to_borrowing_id) VALUES (?, "DEBT_PAYMENT", ?, ?)', [personId, outstanding, b.id]);

    const [gpNow] = await conn.query('SELECT pool_type, balance FROM group_pool WHERE pool_type = ?', [poolType]);
    const gpBalance = gpNow[0] ? parseFloat(gpNow[0].balance) : null;
    await conn.query(
      'INSERT INTO transaction_log (person_id, transaction_type, details, amount, resulting_group_main_balance, resulting_group_validity_balance) VALUES (?, "REPAYMENT", ?, ?, ?, ?)',
      [personId, JSON.stringify({ borrowingId: b.id, fullPay: true }), outstanding, poolType === 'MAIN' ? gpBalance : null, poolType === 'VALIDITY' ? gpBalance : null]
    );

    await conn.commit();

    socket.emitUpdate({ personId, type: 'pay_full' });
    socket.emitUpdate({ personId: 0, type: 'group' });

    return res.json({ ok: true, borrowingId: b.id, paidAmount: outstanding });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('payFull error:', err);
    return res.status(500).json({ error: 'DB error', details: err.message });
  } finally {
    if (conn) conn.release();
  }
}

module.exports = {
  borrow,
  repay,
  payFull
};
