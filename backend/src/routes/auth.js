const express = require('express');
const router = express.Router();
const { login, startQBOAuth, qbOAuthCallback } = require('../controllers/authController');

router.post('/login', login);
router.get('/qb', startQBOAuth);
router.get('/qb/callback', qbOAuthCallback);

module.exports = router;
