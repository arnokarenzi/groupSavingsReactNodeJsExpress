const pool = require('../db');

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
    console.error(err);
    res.status(500).json({ error: 'DB error' });
  }
}

// Apply overdue penalties (10% per full period)
async function runPenalties(req, res) {
  // This endpoint applies overdue penalties to all OPEN borrowings that passed due_date.
  // It will compound 10% per full period; periods are 30 days for MAIN, 7 days for VALIDITY.
  try {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // select open borrowings that are past due
      const [openRows] = await conn.query('SELECT * FROM borrowing WHERE status = "OPEN" FOR UPDATE');

      for (const b of openRows) {
        const now = new Date();
        const due = new Date(b.due_date + 'T00:00:00Z');
        if (now <= due) continue; // not overdue yet

        const poolType = b.pool_type;
        const periodDays = poolType === 'MAIN' ? 30 : 7;
        const lastApplied = b.last_penalty_applied_at ? new Date(b.last_penalty_applied_at) : due;
        // compute full periods elapsed since lastApplied (only full intervals count)
        const msPerDay = 24 * 3600 * 1000;
        const daysSince = Math.floor((now - lastApplied) / msPerDay);
        const fullPeriods = Math.floor(daysSince / periodDays);
        if (fullPeriods <= 0) continue;

        // compound outstanding by (1.1)^fullPeriods
        const origOutstanding = parseFloat(b.outstanding_amount);
        const factor = Math.pow(1.10, fullPeriods);
        const newOutstanding = +(origOutstanding * factor).toFixed(2);

        // update borrowing and last_penalty_applied_at
        await conn.query('UPDATE borrowing SET outstanding_amount = ?, last_penalty_applied_at = NOW() WHERE id = ?', [newOutstanding, b.id]);

        // log penalty
        await conn.query('INSERT INTO transaction_log (person_id, transaction_type, details, amount) VALUES (?, "PENALTY", ?, ?)', [b.person_id, JSON.stringify({ borrowingId: b.id, periods: fullPeriods }), +(newOutstanding - origOutstanding).toFixed(2)]);
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

module.exports = { getGroupPools, runPenalties };
