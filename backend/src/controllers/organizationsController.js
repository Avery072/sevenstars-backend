const supabase = require('../config/supabase');
const admin = require('../config/firebase');

// Create a new organization
const createOrganization = async (req, res) => {
  const { name, address, contact_email, contact_phone } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Restaurant name is required' });
  }

  const { data, error } = await supabase
    .from('organizations')
    .insert([{ name, address, contact_email, contact_phone }])
    .select();

  if (error) return res.status(500).json({ error: error.message });

  res.status(201).json({ organization: data[0] });
};

// Get all organizations
const listOrganizations = async (req, res) => {
  const { data, error } = await supabase
    .from('organizations')
    .select('*, users(*)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
};

// Get single organization
const getOrganization = async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('organizations')
    .select('*, users(*)')
    .eq('id', id)
    .single();

  if (error) return res.status(500).json({ error: error.message });

  res.json(data);
};

// Invite a user to an organization
const inviteUser = async (req, res) => {
  const { id } = req.params;
  const { name, email, role } = req.body;

  // Check max 3 users per org
  const { data: existing, error: countError } = await supabase
    .from('users')
    .select('id')
    .eq('organization_id', id);

  if (countError) return res.status(500).json({ error: countError.message });

  if (existing.length >= 3) {
    return res.status(400).json({ error: 'Maximum 3 users per organization' });
  }

  // Create Firebase user
  let firebaseUser;
  try {
    firebaseUser = await admin.auth().createUser({ email, displayName: name });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Save user to Supabase
  const { data, error } = await supabase
    .from('users')
    .insert([{
      id: firebaseUser.uid,
      organization_id: id,
      email,
      name,
      role: role || 'org-member'
    }])
    .select();

  if (error) return res.status(500).json({ error: error.message });

  // Send invite email via Firebase
  const inviteLink = await admin.auth().generatePasswordResetLink(email);

  res.status(201).json({
    message: 'User invited successfully',
    user: data[0],
    invite_link: inviteLink
  });
};

module.exports = {
  createOrganization,
  listOrganizations,
  getOrganization,
  inviteUser
}