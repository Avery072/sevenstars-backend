const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { listOrders, getOrder, createOrder } = require('../controllers/ordersController');

router.use(requireAuth);

router.get('/', listOrders);
router.get('/:id', getOrder);
router.post('/', createOrder);

module.exports = router;
