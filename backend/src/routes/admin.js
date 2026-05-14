const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { syncFromQB } = require('../controllers/syncController');
const { syncPendingInvoices } = require('../controllers/ordersController');

router.use(requireAuth);

router.post('/sync-from-qb', syncFromQB);
router.post('/sync-pending-invoices', syncPendingInvoices);

module.exports = router;
