const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  createOrganization,
  listOrganizations,
  getOrganization,
  inviteUser
} = require('../controllers/organizationsController');

router.use(requireAuth);

router.get('/', listOrganizations);
router.post('/', createOrganization);
router.get('/:id', getOrganization);
router.post('/:id/invite', inviteUser);

module.exports = router;