const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');
const multer = require('multer');
const {
  listProducts, createProduct, updateProduct, toggleShowPrice, markOutOfStock, setAvailableOverride, deleteProduct, uploadProductImage,
} = require('../controllers/productsController');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(requireAuth);

router.get('/', listProducts);
router.post('/', createProduct);
router.patch('/:id', updateProduct);
router.patch('/:id/show-price', toggleShowPrice);
router.patch('/:id/out-of-stock', markOutOfStock);
router.patch('/:id/available-override', setAvailableOverride);
router.delete('/:id', deleteProduct);
router.post('/:id/image', upload.single('image'), uploadProductImage);

module.exports = router;
