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

/** People */
router.get('/people', savingsCtrl.getPeople); // list people
router.post('/people', savingsCtrl.createMember); // NEW: create member (admin pw required)
router.get('/people/:id/meta', savingsCtrl.getPersonMeta); // NEW: savedCount, etc
router.get('/people/:id/balance', savingsCtrl.getPersonBalance); // personal + open borrowings
router.get('/people/:id/transactions', savingsCtrl.getTransactions); // person's tx log

/** Save / retroactive */
router.post('/people/:id/save', savingsCtrl.saveUnitsAndValidity);
router.post('/people/:id/retroactive', savingsCtrl.retroactiveFill);

/** Borrow / repay */
router.post('/people/:id/borrow', borrowingCtrl.borrow);
router.post('/people/:id/repay', borrowingCtrl.repay);
router.post('/people/:id/pay_full', borrowingCtrl.payFull);

/** Group / admin */
router.get('/group/pools', adminCtrl.getGroupPools);
router.post('/admin/penalties/run', adminCtrl.runPenalties);

module.exports = router;
