const OAuthClient = require('intuit-oauth');
const pool = require('./db');

const oauthClient = new OAuthClient({
  clientId: process.env.QB_CLIENT_ID,
  clientSecret: process.env.QB_CLIENT_SECRET,
  environment: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
  redirectUri: process.env.QB_REDIRECT_URI,
});

async function getStoredTokens() {
  const result = await pool.query('SELECT * FROM qb_tokens ORDER BY updated_at DESC, id DESC LIMIT 1');
  return result.rows[0] || null;
}

async function saveTokens({ realmId, accessToken, refreshToken, expiresAt }) {
  await pool.query(
    `INSERT INTO qb_tokens (realm_id, access_token, refresh_token, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (realm_id) DO UPDATE
       SET access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
    [realmId, accessToken, refreshToken, expiresAt]
  );
}

function getQBErrorMessage(err) {
  const message = err.response?.data ? JSON.stringify(err.response.data) : err.message || 'Unknown QB token refresh error';
  return message.replace(/please authorize again/ig, 'stored refresh token was rejected');
}

async function refreshStoredTokens(stored) {
  let lastErr;
  let tokenRow = stored;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const authResponse = await oauthClient.refreshUsingToken(tokenRow.refresh_token);
      const token = authResponse.getJson();

      const newExpiresAt = new Date(Date.now() + token.expires_in * 1000);
      await saveTokens({
        realmId: tokenRow.realm_id,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: newExpiresAt,
      });

      return { accessToken: token.access_token, realmId: tokenRow.realm_id };
    } catch (err) {
      lastErr = err;
      tokenRow = await getStoredTokens() || tokenRow;
    }
  }

  throw new Error(`QB token refresh failed: ${getQBErrorMessage(lastErr)}`);
}

// Returns a valid access token, refreshing if expiry is within 5 minutes.
async function getValidAccessToken() {
  const stored = await getStoredTokens();
  if (!stored) throw new Error('No QB tokens stored');

  const expiresAt = new Date(stored.expires_at);
  const fiveMinutes = 5 * 60 * 1000;

  if (Date.now() < expiresAt.getTime() - fiveMinutes) {
    return { accessToken: stored.access_token, realmId: stored.realm_id };
  }

  return refreshStoredTokens(stored);
}

module.exports = { oauthClient, getStoredTokens, saveTokens, getValidAccessToken };
