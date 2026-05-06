const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { syncFromQB } = require('../controllers/syncController');

router.use(requireAuth);

router.post('/sync-from-qb', syncFromQB);

module.exports = router;
