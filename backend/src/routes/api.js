// backend/src/routes/api.js
const express = require('express');
const router = express.Router();

const savingsCtrl = require('../controllers/savingsController');
const borrowingCtrl = require('../controllers/borrowingController');
const adminCtrl = require('../controllers/adminController');

// Basic sanity: ensure controller functions exist before wiring routes
if (!savingsCtrl) throw new Error('savingsController not found');
if (!borrowingCtrl) throw new Error('borrowingController not found');
if (!adminCtrl) throw new Error('adminController not found');

/** ------------------------------
 *  PEOPLE ENDPOINTS
 * ------------------------------ */
router.get('/people', savingsCtrl.getPeople);                  // list people
router.post('/people', savingsCtrl.createMember);              // create member (admin pw required)
router.get('/people/:id/meta', savingsCtrl.getPersonMeta);     // savedCount, etc
router.get('/people/:id/balance', savingsCtrl.getPersonBalance); // personal + open borrowings
router.get('/people/:id/transactions', savingsCtrl.getTransactions); // person's tx log

/** ------------------------------
 *  SAVINGS / RETROACTIVE
 * ------------------------------ */
router.post('/people/:id/save', savingsCtrl.saveUnitsAndValidity);
router.post('/people/:id/retroactive', savingsCtrl.retroactiveFill);

/** ------------------------------
 *  BORROW / REPAY
 * ------------------------------ */
router.post('/people/:id/borrow', borrowingCtrl.borrow);
router.post('/people/:id/repay', borrowingCtrl.repay);
router.post('/people/:id/pay_full', borrowingCtrl.payFull);

/** ------------------------------
 *  GROUP / ADMIN
 * ------------------------------ */
router.get('/group/pools', adminCtrl.getGroupPools);
router.post('/admin/penalties/run', adminCtrl.runPenalties);

// ✅ NEW: Delete member (requires password)
if (typeof adminCtrl.deleteMember === 'function') {
  router.post('/admin/delete-member', adminCtrl.deleteMember);
}

// ✅ NEW: Reset all transactions (requires password)
if (typeof adminCtrl.resetAll === 'function') {
  router.post('/admin/reset', adminCtrl.resetAll);
}

// ✅ NEW: Calculate and return share per person
if (typeof adminCtrl.getShare === 'function') {
  router.get('/admin/share', adminCtrl.getShare);
}

module.exports = router;
