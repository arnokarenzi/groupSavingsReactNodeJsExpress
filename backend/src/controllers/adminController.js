// backend/src/controllers/adminController.js
const pool = require('../db');
const dotenv = require('dotenv');
dotenv.config();

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// Return group pools
async function getGroupPools(req, res) {
  try {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT pool_type, balance FROM group_pool');
      res.json({ pools: rows });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('getGroupPools error:', err);
    res.status(500).json({ error: 'DB error', details: err.message });
  }
}

/**
 * Apply overdue penalties (kept as-is / example)
 */
async function runPenalties(req, res) {
  try {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [openRows] = await conn.query('SELECT * FROM borrowing WHERE status = "OPEN" FOR UPDATE');

      for (const b of openRows) {
        const now = new Date();
        const due = b.due_date ? new Date(b.due_date + 'T00:00:00') : null;
        if (!due || now <= due) continue;

        const periodDays = 30; // example period
        const lastApplied = b.last_penalty_applied_at ? new Date(b.last_penalty_applied_at) : due;
        const msPerDay = 24 * 3600 * 1000;
        const elapsedDays = Math.floor((now - lastApplied) / msPerDay);
        const periods = Math.floor(elapsedDays / periodDays);
        if (periods <= 0) continue;

        const PENALTY_PCT = 0.10;
        const originalOutstanding = parseFloat(b.outstanding_amount || 0);
        let newOutstanding = originalOutstanding;
        for (let i = 0; i < periods; i++) {
          newOutstanding = +(newOutstanding * (1 + PENALTY_PCT)).toFixed(2);
        }
        const penaltyApplied = +(newOutstanding - originalOutstanding).toFixed(2);

        await conn.query(
          'UPDATE borrowing SET outstanding_amount = ?, last_penalty_applied_at = ? WHERE id = ?',
          [newOutstanding, new Date().toISOString().slice(0, 19).replace('T',' '), b.id]
        );

        await conn.query(
          'INSERT INTO transaction_log (person_id, transaction_type, amount, details, created_at) VALUES (?, ?, ?, ?, ?)',
          [b.person_id, 'PENALTY', penaltyApplied, JSON.stringify({ borrowing_id: b.id, periods }), new Date()]
        );
      }

      await conn.commit();
      res.json({ ok: true, message: 'Penalties run' });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'DB error', details: err.message });
  }
}

/**
 * Robust deleteMember:
 * - password-protected
 * - runs in a transaction
 * - explicitly deletes dependent rows first (in case FKs do not cascade)
 * - returns informative errors
 *
 * Body: { person_id: <id>, password: '<admin password>' }
 */
async function deleteMember(req, res) {
  const { person_id, password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Invalid admin password' });
  }
  if (!person_id) {
    return res.status(400).json({ error: 'person_id required' });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // ensure person exists
    const [personRows] = await conn.query('SELECT id, name FROM person WHERE id = ? FOR UPDATE', [person_id]);
    const personRow = personRows && personRows[0];
    if (!personRow) {
      await conn.rollback();
      return res.status(404).json({ error: 'Member not found' });
    }

    // Delete dependent records in a safe order.
    // Adjust these table names if your project uses different names.
    const dependentDeletes = [
      ['transaction_log', 'person_id'],
      ['payment', 'person_id'],
      ['borrowing', 'person_id'],
      ['daily_summary', 'person_id'],
      ['personal_balance', 'person_id']
    ];

    for (const [tbl, col] of dependentDeletes) {
      // Use DELETE ... WHERE ... to avoid TRUNCATE / FK issues.
      try {
        await conn.query(`DELETE FROM \`${tbl}\` WHERE \`${col}\` = ?`, [person_id]);
      } catch (err) {
        // Log but continue — if table doesn't exist or column differs, we don't want to fail entire deletion
        console.warn(`Warning: delete from ${tbl} failed:`, err.message);
      }
    }

    // Finally delete the person row
    await conn.query('DELETE FROM person WHERE id = ?', [person_id]);

    // record admin action
    try {
      await conn.query(
        'INSERT INTO transaction_log (person_id, transaction_type, amount, details, created_at) VALUES (?, ?, ?, ?, ?)',
        [null, 'ADMIN_DELETE_MEMBER', 0, JSON.stringify({ deleted_person_id: person_id, by: 'admin' }), new Date()]
      );
    } catch (e) {
      // not critical
      console.warn('Could not insert admin transaction_log:', e.message);
    }

    await conn.commit();
    res.json({ ok: true, message: `Member ${personRow.name} (id ${person_id}) deleted` });
  } catch (err) {
    try { if (conn) await conn.rollback(); } catch(e){}
    console.error('deleteMember error:', err);
    // return SQL error message to help debugging (non-sensitive)
    res.status(500).json({ error: 'DB error', details: err.message });
  } finally {
    try { if (conn) conn.release(); } catch(e){}
  }
}

/**
 * RESET all transactions but keep members:
 * Body: { password: '<admin password>' }
 */
async function resetAll(req, res) {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Invalid admin password' });
  }

  try {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      try {
        await conn.query('TRUNCATE TABLE transaction_log');
      } catch (e) {
        await conn.query('DELETE FROM transaction_log');
      }

      try {
        await conn.query('TRUNCATE TABLE borrowing');
      } catch (e) {
        await conn.query('DELETE FROM borrowing');
      }

      try {
        await conn.query('TRUNCATE TABLE payment');
      } catch (e) {
        await conn.query('DELETE FROM payment');
      }

      try {
        await conn.query('TRUNCATE TABLE daily_summary');
      } catch (e) {
        await conn.query('DELETE FROM daily_summary');
      }

      try {
        await conn.query('UPDATE personal_balance SET main_savings_balance = 0, validity_savings_balance = 0');
      } catch (e) {
        // ignore
      }

      try {
        await conn.query('UPDATE group_pool SET balance = 0');
      } catch (e) {
        // ignore
      }

      try {
        await conn.query(
          'INSERT INTO transaction_log (person_id, transaction_type, amount, details, created_at) VALUES (?, ?, ?, ?, ?)',
          [null, 'ADMIN_RESET', 0, JSON.stringify({ reset_by: 'admin' }), new Date()]
        );
      } catch (e) {
        // ignore
      }

      await conn.commit();
      res.json({ ok: true, message: 'All transactions and balances reset' });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally{
      conn.release();
  } 
}catch (err) {
    console.error('resetAll error:', err);
    res.status(500).json({ error: 'DB error', details: err.message });
  }
}

/**
 * GET /api/admin/share
 */
async function getShare(req, res) {
  try {
    const conn = await pool.getConnection();
    try {
      const [pools] = await conn.query('SELECT pool_type, balance FROM group_pool');
      let total_savings = 0;
      for (const p of pools) {
        total_savings += parseFloat(p.balance || 0);
      }

      const [unitsRows] = await conn.query('SELECT SUM(units_count) AS total_units FROM daily_summary');
      const total_units = unitsRows && unitsRows[0] && parseFloat(unitsRows[0].total_units || 0);

      const share_per_unit = total_units ? +(total_savings / total_units) : 0;

      res.json({
        total_savings: +total_savings.toFixed(2),
        total_units,
        share_per_unit: +share_per_unit.toFixed(2)
      });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('getShare error:', err);
    res.status(500).json({ error: 'DB error', details: err.message });
  }
}

module.exports = {
  getGroupPools,
  runPenalties,
  deleteMember,
  resetAll,
  getShare
};
