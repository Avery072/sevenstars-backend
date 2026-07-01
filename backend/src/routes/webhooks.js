const express = require('express');
const router = express.Router();
const { handleWebhook } = require('../controllers/webhooksController');

// QB webhook — no JWT auth, but payload is signature-verified inside the handler
router.post('/quickbooks', express.json(), handleWebhook);

module.exports = router;

// Test endpoint — call this to verify webhook handler works
router.post('/quickbooks-test', express.json(), (req, res) => {
  console.log('=== TEST WEBHOOK RECEIVED ===');
  console.log('Body:', JSON.stringify(req.body).substring(0, 300));
  console.log('Headers:', JSON.stringify(req.headers, null, 2).substring(0, 300));
  res.json({ received: true });
});
