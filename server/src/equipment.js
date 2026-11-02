const { z } = require('zod');

const equipmentCategorySchema = z.string().trim().min(1).max(50);

module.exports = { equipmentCategorySchema };
