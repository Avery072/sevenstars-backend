const express = require('express');
const router = express.Router();
const { login, startQBOAuth, qbOAuthCallback, qbStatus } = require('../controllers/authController');
const { customerLogin, customerSignup, customerMe, checkCompany } = require('../controllers/customerAuthController');
const { requireCustomerAuth } = require('../middleware/auth');

// Admin auth
router.post('/login', login);
router.get('/qb', startQBOAuth);
router.get('/qb/callback', qbOAuthCallback);
router.get('/qb-status', qbStatus);

// Customer (mobile) auth
router.post('/customer-login', customerLogin);
router.post('/customer-signup', customerSignup);
router.get('/customer-me', requireCustomerAuth, customerMe);
router.get('/check-company', checkCompany);

module.exports = router;
