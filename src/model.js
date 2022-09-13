const mongoose = require('mongoose');

const auditSchema = new mongoose.Schema({
  itemName: String,
  action: String,
  itemId: {},
  changes: {},
  originalDocument: {},
  user: {}
}, { timestamps: true });

module.exports = mongoose.model('Audit', auditSchema);
