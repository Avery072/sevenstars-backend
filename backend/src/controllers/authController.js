const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const OAuthClient = require('intuit-oauth');
const pool = require('../config/db');
const { oauthClient, saveTokens } = require('../config/quickbooks');

async function login(req, res) {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  const result = await pool.query('SELECT * FROM admin_users WHERE username = $1', [username]);
  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, {
    expiresIn: '8h',
  });

  res.json({ token });
}

function startQBOAuth(req, res) {
  const authUri = oauthClient.authorizeUri({
    scope: [
      OAuthClient.scopes.Accounting,
      OAuthClient.scopes.OpenId,
    ],
    state: 'seven-stars-auth',
  });
  res.redirect(authUri);
}

async function qbOAuthCallback(req, res) {
  try {
    const fullUrl = process.env.QB_REDIRECT_URI + req.url.substring(req.url.indexOf('?'));
    const authResponse = await oauthClient.createToken(fullUrl);
    const token = authResponse.getJson();

    await saveTokens({
      realmId: authResponse.token.realmId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000),
    });

    res.json({ message: 'QuickBooks connected successfully' });
  } catch (err) {
    console.error('QB OAuth callback error:', err);
    res.status(500).json({ error: 'QB OAuth failed', detail: err.message });
  }
}

module.exports = { login, startQBOAuth, qbOAuthCallback };
