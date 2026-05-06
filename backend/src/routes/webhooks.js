const express = require('express');
const router = express.Router();
const { handleWebhook } = require('../controllers/webhooksController');

// QB webhook — no JWT auth, but payload is signature-verified inside the handler
router.post('/quickbooks', express.json(), handleWebhook);

module.exports = router;
