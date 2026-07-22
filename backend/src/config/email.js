const { BrevoClient } = require('@getbrevo/brevo');

const brevo = process.env.BREVO_API_KEY ? new BrevoClient({ apiKey: process.env.BREVO_API_KEY }) : null;

async function sendPasswordResetCode(to, code) {
  if (!brevo) {
    // No Brevo key configured yet (e.g. local testing) — log instead of sending
    // so the reset flow can still be exercised end-to-end.
    console.log(`[email] BREVO_API_KEY not set — password reset code for ${to}: ${code}`);
    return;
  }

  await brevo.transactionalEmails.sendTransacEmail({
    subject: 'Your Seven Star Food password reset code',
    textContent: `Your password reset code is ${code}. It expires in 15 minutes. If you didn't request this, you can ignore this email.`,
    htmlContent: `<p>Your password reset code is <strong>${code}</strong>.</p><p>It expires in 15 minutes. If you didn't request this, you can ignore this email.</p>`,
    sender: { name: 'Seven Star Food', email: process.env.EMAIL_FROM },
    to: [{ email: to }],
  });
}

module.exports = { sendPasswordResetCode };
