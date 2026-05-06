const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { listCustomers, getCustomer, createCustomer, updateCustomer } = require('../controllers/customersController');

router.use(requireAuth);

router.get('/', listCustomers);
router.get('/:id', getCustomer);
router.post('/', createCustomer);
router.patch('/:id', updateCustomer);

module.exports = router;
