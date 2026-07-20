require('dotenv').config();
const path = require('path');
const express = require('express');
// Patches Express to forward rejected Promises from async route handlers to
// the error middleware below, instead of letting them become unhandled
// rejections that crash the whole process (Node 15+ default). Must be
// required after express but before any router/route is defined.
require('express-async-errors');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const ordersRoutes = require('./routes/orders');
const productsRoutes = require('./routes/products');
const customersRoutes = require('./routes/customers');
const webhookRoutes = require('./routes/webhooks');
const adminRoutes = require('./routes/admin');
const mobileRoutes = require('./routes/mobile');
const { purgeOldOrders } = require('./controllers/ordersController');

const app = express();

// Railway (and most PaaS) sit behind a reverse proxy — trust it so
// express-rate-limit can read the real client IP from X-Forwarded-For
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

// QB webhooks need raw body for signature verification — mount before json middleware
app.use('/api/webhooks', webhookRoutes);

app.use(express.json());

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
  })
);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/mobile', mobileRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/customers', customersRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Last-resort net for anything outside the Express request cycle that
// express-async-errors can't see (background jobs, timers, stray promises
// missing a .catch()) — log it and keep the process alive rather than
// crashing the whole backend over one bad request's worth of fallout.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (backend stayed up):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (backend stayed up):', err);
});

function runPurge() {
  purgeOldOrders().catch(err => console.error('purgeOldOrders failed:', err.message));
}

// Only listen (and run the purge job) when this file is the actual entry
// point — requiring it from tests should just build the app, no side effects.
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Seven Stars backend running on port ${PORT}`);
    runPurge();
    setInterval(runPurge, 24 * 60 * 60 * 1000);
  });
}

module.exports = app;
