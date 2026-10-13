const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { syncFromQB, syncInvoicesFromQB, reconcileOrders, previewInvoiceNumberRecovery, runInvoiceNumberRecovery } = require('../controllers/syncController');
const { getPackingReport, getSalmonPullReport, syncPendingInvoices } = require('../controllers/ordersController');
const { listPending, approveCustomer, rejectCustomer, listPendingSubUsers, approveSubUser, rejectSubUser, listAllAccounts, deleteAccount, setMainUser, changeUserCompany } = require('../controllers/approvalController');
const { generateDailyPull } = require('../controllers/dailyPullController');

router.use(requireAuth);

router.post('/sync-from-qb', syncFromQB);
router.post('/sync-invoices-from-qb', syncInvoicesFromQB);
router.post('/reconcile-orders', reconcileOrders);
router.post('/sync-pending-invoices', syncPendingInvoices);
router.get('/invoice-number-recovery', previewInvoiceNumberRecovery);
router.post('/invoice-number-recovery', runInvoiceNumberRecovery);
router.get('/packing-report', getPackingReport);
router.get('/salmon-pull', getSalmonPullReport);
router.get('/pending', listPending);
router.post('/approve/:id', approveCustomer);
router.post('/reject/:id', rejectCustomer);
router.get('/pending-sub-users', listPendingSubUsers);
router.post('/approve-sub-user/:id', approveSubUser);
router.post('/reject-sub-user/:id', rejectSubUser);
router.get('/accounts', listAllAccounts);
router.delete('/accounts/user/:id', deleteAccount);
router.post('/accounts/user/:id/set-main', setMainUser);
router.post('/accounts/user/:id/change-company', changeUserCompany);
router.get('/daily-pull', generateDailyPull);

module.exports = router;
