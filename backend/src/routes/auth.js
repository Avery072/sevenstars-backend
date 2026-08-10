const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { login, startQBOAuth, qbOAuthCallback, qbStatus } = require('../controllers/authController');
const {
  customerLogin,
  customerSignup,
  customerMe,
  checkCompany,
  customerForgotPassword,
  customerResetPassword,
  customerDeleteAccount,
} = require('../controllers/customerAuthController');
const { requireCustomerAuth } = require('../middleware/auth');

// Narrow limiter on top of the app-wide one — these endpoints send email and
// let callers guess a 6-digit code, so they need tighter throttling.
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// Admin auth
router.post('/login', login);
router.get('/qb', startQBOAuth);
router.get('/qb/callback', qbOAuthCallback);
router.get('/qb-status', qbStatus);

// Customer (mobile) auth
router.post('/customer-login', customerLogin);
router.post('/customer-signup', customerSignup);
router.get('/customer-me', requireCustomerAuth, customerMe);
router.delete('/customer-me', requireCustomerAuth, customerDeleteAccount);
router.get('/check-company', checkCompany);
router.post('/forgot-password', resetLimiter, customerForgotPassword);
router.post('/reset-password', resetLimiter, customerResetPassword);

module.exports = router;
