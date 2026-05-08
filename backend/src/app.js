require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const ordersRoutes = require('./routes/orders');
const productsRoutes = require('./routes/products');
const customersRoutes = require('./routes/customers');
const webhookRoutes = require('./routes/webhooks');
const adminRoutes = require('./routes/admin');
const { purgeOldOrders } = require('./controllers/ordersController');

const app = express();

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
app.use('/api/orders', ordersRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/customers', customersRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Seven Stars backend running on port ${PORT}`);
  purgeOldOrders();
  setInterval(purgeOldOrders, 24 * 60 * 60 * 1000);
});

module.exports = app;
