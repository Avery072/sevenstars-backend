const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { syncFromQB } = require('../controllers/syncController');
const { syncPendingInvoices } = require('../controllers/ordersController');
const { listPending, approveCustomer, rejectCustomer } = require('../controllers/approvalController');

router.use(requireAuth);

router.post('/sync-from-qb', syncFromQB);
router.post('/sync-pending-invoices', syncPendingInvoices);
router.get('/pending', listPending);
router.post('/approve/:id', approveCustomer);
router.post('/reject/:id', rejectCustomer);

module.exports = router;
