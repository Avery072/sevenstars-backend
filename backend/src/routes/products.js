const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  listProducts, createProduct, updateProduct, toggleShowPrice, deleteProduct,
} = require('../controllers/productsController');

router.use(requireAuth);

router.get('/', listProducts);
router.post('/', createProduct);
router.patch('/:id', updateProduct);
router.patch('/:id/show-price', toggleShowPrice);
router.delete('/:id', deleteProduct);

module.exports = router;
