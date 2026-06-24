const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { syncFromQB } = require('../controllers/syncController');
const { syncPendingInvoices } = require('../controllers/ordersController');
const { listPending, approveCustomer, rejectCustomer, listPendingSubUsers, approveSubUser, rejectSubUser } = require('../controllers/approvalController');

router.use(requireAuth);

router.post('/sync-from-qb', syncFromQB);
router.post('/sync-pending-invoices', syncPendingInvoices);
router.get('/pending', listPending);
router.post('/approve/:id', approveCustomer);
router.post('/reject/:id', rejectCustomer);
router.get('/pending-sub-users', listPendingSubUsers);
router.post('/approve-sub-user/:id', approveSubUser);
router.post('/reject-sub-user/:id', rejectSubUser);

module.exports = router;
