const express = require('express');
const router = express.Router();
const { login, startQBOAuth, qbOAuthCallback } = require('../controllers/authController');
const { customerLogin, customerSignup, customerMe } = require('../controllers/customerAuthController');
const { requireCustomerAuth } = require('../middleware/auth');

// Admin auth
router.post('/login', login);
router.get('/qb', startQBOAuth);
router.get('/qb/callback', qbOAuthCallback);

// Customer (mobile) auth
router.post('/customer-login', customerLogin);
router.post('/customer-signup', customerSignup);
router.get('/customer-me', requireCustomerAuth, customerMe);

module.exports = router;
