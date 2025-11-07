// backend/src/controllers/savingsController.js
const pool = require('../db');
const dotenv = require('dotenv');
dotenv.config();
const socket = require('../socket');

const UNIT_PRICE = parseFloat(process.env.UNIT_PRICE || '500');
const VALIDITY_FEE = parseFloat(process.env.VALIDITY_FEE || '100');
const FINE_AMOUNT = parseFloat(process.env.FINE_AMOUNT || '500');

/**
 * GET /api/people
 */
async function getPeople(req, res) {
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT id, name FROM person ORDER BY name');
      return res.json({ people: rows });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('getPeople error:', err);
    return res.status(500).json({ error: 'DB error', details: err.message });
  }
}

/**
 * POST /api/people  (create member) — admin password protected
 */
async function createMember(req, res) {
  const { name, adminPassword } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const ADMIN_PW = process.env.ADMIN_PASSWORD || '';
  if (!adminPassword || adminPassword !== ADMIN_PW) {
    return res.status(403).json({ error: 'Admin password required / invalid' });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [r] = await conn.query('INSERT INTO person (name) VALUES (?)', [name]);
    const personId = r.insertId;
    // create personal_balance row
    await conn.query('INSERT INTO personal_balance (person_id, main_savings_balance, validity_savings_balance) VALUES (?, 0.00, 0.00)', [personId]);

    // optional transaction_log entry
    await conn.query('INSERT INTO transaction_log (person_id, transaction_type, details, amount) VALUES (?, "GROUP_ADJUST", ?, 0)', [personId, JSON.stringify({ note: 'member created' })]);

    await conn.commit();

    // emit update (new person list)
    socket.emitUpdate({ personId, type: 'new_member' });
    socket.emitUpdate({ personId: 0, type: 'group' });

    return res.json({ ok: true, personId, name });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('createMember error:', err);
    return res.status(500).json({ error: 'DB error', details: err.message });
  } finally {
    if (conn) conn.release();
  }
}

/**
 * GET /api/people/:id/meta
 * Return savedCount (how many UNIT payments)
 */
async function getPersonMeta(req, res) {
  const personId = parseInt(req.params.id, 10);
  try {
    const conn = await pool.getConnection();
    try {
      const [savedRows] = await conn.query('SELECT COUNT(*) as cnt FROM payment WHERE person_id = ? AND type = "UNIT"', [personId]);
      const savedCount = savedRows[0] ? parseInt(savedRows[0].cnt, 10) : 0;
      return res.json({ savedCount });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('getPersonMeta error:', err);
    return res.status(500).json({ error: 'DB error', details: err.message });
  }
}

/**
 * GET /api/people/:id/transactions
 */
async function getTransactions(req, res) {
  const personId = parseInt(req.params.id, 10);
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query(
        'SELECT id, transaction_type, details, amount, resulting_person_main_balance, resulting_person_validity_balance, resulting_group_main_balance, resulting_group_validity_balance, created_at FROM transaction_log WHERE person_id = ? ORDER BY created_at DESC LIMIT 200',
        [personId]
      );
      return res.json({ transactions: rows });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('getTransactions error:', err);
    return res.status(500).json({ error: 'DB error', details: err.message });
  }
}

/**
 * GET /api/people/:id/balance
 */
async function getPersonBalance(req, res) {
  const personId = parseInt(req.params.id, 10) || 0;
  try {
    const conn = await pool.getConnection();
    try {
      const [personalRows] = await conn.query('SELECT * FROM personal_balance WHERE person_id = ?', [personId]);
      const personal = personalRows[0] || { main_savings_balance: 0, validity_savings_balance: 0 };

      const [borrowings] = await conn.query('SELECT * FROM borrowing WHERE person_id = ? AND status = "OPEN"', [personId]);
      const [groupPools] = await conn.query('SELECT pool_type, balance FROM group_pool');

      return res.json({ person: personal, openBorrowings: borrowings, groupPools });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('getPersonBalance error:', err);
    return res.status(500).json({ error: 'DB error', details: err.message });
  }
}

/**
 * POST /api/people/:id/save
 * Only record amounts actually applied.
 */
async function saveUnitsAndValidity(req, res) {
  const personId = parseInt(req.params.id, 10);
  const { units = 0, payValidity = false, effectiveDate = null } = req.body;
  const date = effectiveDate ? effectiveDate : new Date().toISOString().slice(0, 10);

  if (units < 0 || units > 4) return res.status(400).json({ error: 'units must be between 0 and 4' });

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Ensure personal_balance row exists; lock it
    const [personalRows] = await conn.query('SELECT * FROM personal_balance WHERE person_id = ? FOR UPDATE', [personId]);
    if (!personalRows[0]) {
      await conn.query('INSERT INTO personal_balance (person_id, main_savings_balance, validity_savings_balance) VALUES (?, 0.00, 0.00)', [personId]);
    }

    // Lock or create daily_summary row for this person/date
    const [existingDaily] = await conn.query('SELECT * FROM daily_summary WHERE person_id = ? AND `date` = ? FOR UPDATE', [personId, date]);
    let daily = existingDaily[0];

    // Track what we actually applied
    let appliedUnits = 0;
    let appliedValidity = 0;

    if (!daily) {
      // New daily summary for this date
      const validityPaidFlag = payValidity ? 1 : 0;
      const unitsCount = units;
      await conn.query('INSERT INTO daily_summary (person_id, `date`, validity_paid, units_count) VALUES (?, ?, ?, ?)', [personId, date, validityPaidFlag, unitsCount]);
      daily = { id: null, validity_paid: validityPaidFlag, units_count: unitsCount }; // approximate for logic below

      // Apply validity if requested
      if (payValidity) {
        appliedValidity = VALIDITY_FEE;
        await conn.query('UPDATE personal_balance SET validity_savings_balance = validity_savings_balance + ? WHERE person_id = ?', [appliedValidity, personId]);
        await conn.query('INSERT INTO payment (person_id, type, amount, effective_date) VALUES (?, "VALIDITY", ?, ?)', [personId, appliedValidity, date]);
        await conn.query('UPDATE group_pool SET balance = balance + ? WHERE pool_type = "VALIDITY"', [appliedValidity]);
      }

      // Apply units
      if (units > 0) {
        appliedUnits = units;
        const unitsAmount = +(units * UNIT_PRICE).toFixed(2);
        await conn.query('UPDATE personal_balance SET main_savings_balance = main_savings_balance + ? WHERE person_id = ?', [unitsAmount, personId]);
        await conn.query('INSERT INTO payment (person_id, type, amount, effective_date) VALUES (?, "UNIT", ?, ?)', [personId, unitsAmount, date]);
        await conn.query('UPDATE group_pool SET balance = balance + ? WHERE pool_type = "MAIN"', [unitsAmount]);
      }
    } else {
      // existing record for that date - validate
      if (payValidity && daily.validity_paid) {
        // validity already paid — do not charge or log it
      } else if (payValidity && !daily.validity_paid) {
        appliedValidity = VALIDITY_FEE;
        await conn.query('UPDATE daily_summary SET validity_paid = 1 WHERE id = ?', [daily.id]);
        await conn.query('UPDATE personal_balance SET validity_savings_balance = validity_savings_balance + ? WHERE person_id = ?', [appliedValidity, personId]);
        await conn.query('INSERT INTO payment (person_id, type, amount, effective_date) VALUES (?, "VALIDITY", ?, ?)', [personId, appliedValidity, date]);
        await conn.query('UPDATE group_pool SET balance = balance + ? WHERE pool_type = "VALIDITY"', [appliedValidity]);
      }

      const newUnits = daily.units_count + units;
      if (newUnits > 4) {
        await conn.rollback();
        return res.status(400).json({ error: 'Daily unit cap exceeded (max 4 units per day)' });
      }

      if (units > 0) {
        appliedUnits = units;
        await conn.query('UPDATE daily_summary SET units_count = units_count + ? WHERE id = ?', [units, daily.id]);
        const unitsAmount = +(units * UNIT_PRICE).toFixed(2);
        await conn.query('UPDATE personal_balance SET main_savings_balance = main_savings_balance + ? WHERE person_id = ?', [unitsAmount, personId]);
        await conn.query('INSERT INTO payment (person_id, type, amount, effective_date) VALUES (?, "UNIT", ?, ?)', [personId, unitsAmount, date]);
        await conn.query('UPDATE group_pool SET balance = balance + ? WHERE pool_type = "MAIN"', [unitsAmount]);
      }
    }

    // Fetch balances for logs
    const [balRows] = await conn.query('SELECT main_savings_balance, validity_savings_balance FROM personal_balance WHERE person_id = ?', [personId]);
    const personBal = balRows[0] || { main_savings_balance: 0, validity_savings_balance: 0 };
    const [groupMainRows] = await conn.query('SELECT balance FROM group_pool WHERE pool_type = "MAIN"');
    const groupMain = groupMainRows[0] ? parseFloat(groupMainRows[0].balance) : 0;
    const [groupValidityRows] = await conn.query('SELECT balance FROM group_pool WHERE pool_type = "VALIDITY"');
    const groupValidity = groupValidityRows[0] ? parseFloat(groupValidityRows[0].balance) : 0;

    // Build applied amounts for logging and response
    const appliedUnitsAmount = +(appliedUnits * UNIT_PRICE).toFixed(2);
    const appliedValidityAmount = appliedValidity; // either 0 or VALIDITY_FEE
    const savedAmount = +(appliedUnitsAmount + appliedValidityAmount).toFixed(2);

    // Only insert a transaction_log entry if something was applied
    if (savedAmount > 0) {
      await conn.query(
        'INSERT INTO transaction_log (person_id, transaction_type, details, amount, resulting_person_main_balance, resulting_person_validity_balance, resulting_group_main_balance, resulting_group_validity_balance) VALUES (?, "SAVING", ?, ?, ?, ?, ?, ?)',
        [personId, JSON.stringify({ date, appliedUnits, appliedValidity: appliedValidityAmount }), savedAmount, personBal.main_savings_balance, personBal.validity_savings_balance, groupMain, groupValidity]
      );
    }

    await conn.commit();

    // Emit updates for realtime UI
    socket.emitUpdate({ personId, type: 'saving' });
    socket.emitUpdate({ personId: 0, type: 'group' });

    return res.json({
      ok: true,
      applied: { appliedUnits, appliedUnitsAmount, appliedValidityAmount },
      newBalances: personBal,
      groupPools: { MAIN: groupMain, VALIDITY: groupValidity }
    });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('saveUnitsAndValidity error:', err);
    return res.status(500).json({ error: 'DB error', details: err.message });
  } finally {
    if (conn) conn.release();
  }
}

/**
 * POST /api/people/:id/retroactive
 * Fine only applied when units are actually added (addUnits > 0).
 * Insert payments and logs only for what was actually applied.
 */
async function retroactiveFill(req, res) {
  const personId = parseInt(req.params.id, 10);
  const { date, addUnits = 0, payValidityIfMissing = false } = req.body;

  if (!date) return res.status(400).json({ error: 'date required' });
  const today = new Date().toISOString().slice(0, 10);
  if (date >= today) return res.status(400).json({ error: 'date must be in the past for retroactive fill' });
  if (addUnits < 0 || addUnits > 4) return res.status(400).json({ error: 'addUnits must be between 0 and 4' });

  // If user is not changing anything, reject early (no-op)
  if (addUnits === 0 && !payValidityIfMissing) {
    return res.status(400).json({ error: 'no changes requested' });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Ensure personal_balance exists and lock it
    const [personalRows] = await conn.query('SELECT * FROM personal_balance WHERE person_id = ? FOR UPDATE', [personId]);
    if (!personalRows[0]) {
      await conn.query('INSERT INTO personal_balance (person_id, main_savings_balance, validity_savings_balance) VALUES (?, 0.00, 0.00)', [personId]);
    }

    // lock daily_summary if exists
    const [rows] = await conn.query('SELECT * FROM daily_summary WHERE person_id = ? AND `date` = ? FOR UPDATE', [personId, date]);
    const daily = rows[0];

    // Track applied
    let appliedUnits = 0;
    let appliedUnitsAmount = 0;
    let appliedValidityAmount = 0;
    let fineToCharge = 0;

    if (!daily) {
      // missing day: charge fine only when units are being added
      if (addUnits > 0) fineToCharge = FINE_AMOUNT;

      const validityPaid = payValidityIfMissing ? 1 : 0;
      await conn.query('INSERT INTO daily_summary (person_id, `date`, validity_paid, units_count, fine_amount) VALUES (?, ?, ?, ?, ?)', [personId, date, validityPaid, addUnits, fineToCharge]);

      // apply validity if requested
      if (payValidityIfMissing) {
        appliedValidityAmount = VALIDITY_FEE;
        await conn.query('UPDATE personal_balance SET validity_savings_balance = validity_savings_balance + ? WHERE person_id = ?', [appliedValidityAmount, personId]);
        await conn.query('INSERT INTO payment (person_id, type, amount, effective_date) VALUES (?, "VALIDITY", ?, ?)', [personId, appliedValidityAmount, date]);
        await conn.query('UPDATE group_pool SET balance = balance + ? WHERE pool_type = "VALIDITY"', [appliedValidityAmount]);
      }

      if (addUnits > 0) {
        appliedUnits = addUnits;
        appliedUnitsAmount = +(addUnits * UNIT_PRICE).toFixed(2);
        await conn.query('UPDATE personal_balance SET main_savings_balance = main_savings_balance + ? WHERE person_id = ?', [appliedUnitsAmount, personId]);
        await conn.query('INSERT INTO payment (person_id, type, amount, effective_date) VALUES (?, "UNIT", ?, ?)', [personId, appliedUnitsAmount, date]);
        await conn.query('UPDATE group_pool SET balance = balance + ? WHERE pool_type = "MAIN"', [appliedUnitsAmount]);
      }
    } else {
      // day exists
      // validate
      const targetUnits = daily.units_count + addUnits;
      if (targetUnits > 4) {
        await conn.rollback();
        return res.status(400).json({ error: 'resulting units would exceed daily cap (4)' });
      }

      // charge fine only if units being added
      fineToCharge = addUnits > 0 ? FINE_AMOUNT : 0;

      await conn.query('UPDATE daily_summary SET units_count = units_count + ?, fine_amount = fine_amount + ? WHERE id = ?', [addUnits, fineToCharge, daily.id]);

      // validity: only if not already paid
      if (payValidityIfMissing && !daily.validity_paid) {
        appliedValidityAmount = VALIDITY_FEE;
        await conn.query('UPDATE daily_summary SET validity_paid = 1 WHERE id = ?', [daily.id]);
        await conn.query('UPDATE personal_balance SET validity_savings_balance = validity_savings_balance + ? WHERE person_id = ?', [appliedValidityAmount, personId]);
        await conn.query('INSERT INTO payment (person_id, type, amount, effective_date) VALUES (?, "VALIDITY", ?, ?)', [personId, appliedValidityAmount, date]);
        await conn.query('UPDATE group_pool SET balance = balance + ? WHERE pool_type = "VALIDITY"', [appliedValidityAmount]);
      }

      if (addUnits > 0) {
        appliedUnits = addUnits;
        appliedUnitsAmount = +(addUnits * UNIT_PRICE).toFixed(2);
        await conn.query('UPDATE personal_balance SET main_savings_balance = main_savings_balance + ? WHERE person_id = ?', [appliedUnitsAmount, personId]);
        await conn.query('INSERT INTO payment (person_id, type, amount, effective_date) VALUES (?, "UNIT", ?, ?)', [personId, appliedUnitsAmount, date]);
        await conn.query('UPDATE group_pool SET balance = balance + ? WHERE pool_type = "MAIN"', [appliedUnitsAmount]);
      }
    }

    // If a fine was charged (only when addUnits>0), add to group MAIN and create payment/log
    if (fineToCharge > 0) {
      await conn.query('UPDATE group_pool SET balance = balance + ? WHERE pool_type = "MAIN"', [fineToCharge]);
      await conn.query('INSERT INTO payment (person_id, type, amount, effective_date) VALUES (?, "FINE", ?, ?)', [personId, fineToCharge, date]);

      const [gmain] = await conn.query('SELECT balance FROM group_pool WHERE pool_type = "MAIN"');
      const gmainBal = gmain[0] ? parseFloat(gmain[0].balance) : null;
      await conn.query('INSERT INTO transaction_log (person_id, transaction_type, details, amount, resulting_group_main_balance) VALUES (?, "FINE", ?, ?, ?)', [personId, JSON.stringify({ date }), fineToCharge, gmainBal]);
    }

    // Final transaction log for what was actually applied (only if something changed)
    const totalApplied = +(appliedUnitsAmount + appliedValidityAmount + fineToCharge).toFixed(2);

    // fetch balances
    const [personBalRows] = await conn.query('SELECT main_savings_balance, validity_savings_balance FROM personal_balance WHERE person_id = ?', [personId]);
    const personBal = personBalRows[0] || { main_savings_balance: 0, validity_savings_balance: 0 };
    const [groupMainRows] = await conn.query('SELECT balance FROM group_pool WHERE pool_type = "MAIN"');
    const groupMain = groupMainRows[0] ? parseFloat(groupMainRows[0].balance) : 0;
    const [groupValidityRows] = await conn.query('SELECT balance FROM group_pool WHERE pool_type = "VALIDITY"');
    const groupValidity = groupValidityRows[0] ? parseFloat(groupValidityRows[0].balance) : 0;

    if (totalApplied > 0) {
      await conn.query('INSERT INTO transaction_log (person_id, transaction_type, details, amount, resulting_person_main_balance, resulting_person_validity_balance, resulting_group_main_balance, resulting_group_validity_balance) VALUES (?, "SAVING", ?, ?, ?, ?, ?, ?)', [
        personId,
        JSON.stringify({ date, appliedUnits, appliedUnitsAmount, appliedValidityAmount, fineToCharge }),
        totalApplied,
        personBal.main_savings_balance,
        personBal.validity_savings_balance,
        groupMain,
        groupValidity
      ]);
    }

    await conn.commit();

    // Emit realtime updates
    socket.emitUpdate({ personId, type: 'saving' });
    socket.emitUpdate({ personId: 0, type: 'group' });

    return res.json({
      ok: true,
      applied: { appliedUnits, appliedUnitsAmount, appliedValidityAmount, fineApplied: fineToCharge },
      newBalances: personBal,
      groupPools: { MAIN: groupMain, VALIDITY: groupValidity }
    });
  } catch (err) {
    if (conn) await conn.rollback();
    console.error('retroactiveFill error:', err);
    return res.status(500).json({ error: 'DB error', details: err.message });
  } finally {
    if (conn) conn.release();
  }
}

module.exports = {
  getPeople,
  createMember,
  getPersonMeta,
  getTransactions,
  getPersonBalance,
  saveUnitsAndValidity,
  retroactiveFill
};
