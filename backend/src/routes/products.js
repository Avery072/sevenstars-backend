const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const multer = require('multer');
const {
  listProducts, createProduct, updateProduct, toggleShowPrice, deleteProduct, uploadProductImage,
} = require('../controllers/productsController');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// TEMPORARY DEBUG ROUTE - REMOVE BEFORE PRODUCTION
router.get('/qb-debug', async (req, res) => {
  const result = await pool.query(
    'SELECT id, sku, description, qb_item_id FROM products ORDER BY id DESC LIMIT 5'
  );
  res.json(result.rows);
});

router.use(requireAuth);

router.get('/', listProducts);
router.post('/', createProduct);
router.patch('/:id', updateProduct);
router.patch('/:id/show-price', toggleShowPrice);
router.delete('/:id', deleteProduct);
router.post('/:id/image', upload.single('image'), uploadProductImage);

module.exports = router;
