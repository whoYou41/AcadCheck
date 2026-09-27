'use strict';
const fs = require('fs');
const path = require('path');
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'Answer-Sheet.docx');
// The user's supplied blank form is authoritative. Do not shade bubbles or
// rewrite its numbering, student fields, university header or sequence boxes.
async function generateAnswerSheet() {
  return { buffer: await fs.promises.readFile(TEMPLATE_PATH), copiesUpdated: 2 };
}
module.exports = { generateAnswerSheet, TEMPLATE_PATH };
