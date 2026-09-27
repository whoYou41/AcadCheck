'use strict';
const assert = require('assert');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { generateAnswerSheet, TEMPLATE_PATH } = require('./answer-sheet-generator');
(async () => {
  const result = await generateAnswerSheet({classroomName:'Do not overwrite the supplied form'});
  assert.ok(result.buffer.equals(fs.readFileSync(TEMPLATE_PATH)));
  const zip = new AdmZip(result.buffer);
  const xml = zip.readAsText('word/document.xml');
  assert.equal((xml.match(/ANSWER SHEET/g)||[]).length,2);
  assert.ok(xml.includes('18720')); // 13-inch page height in twips.
  assert.ok(!xml.includes('Do not overwrite'));
  assert.equal(result.copiesUpdated,2);
  console.log('Blank supplied answer-sheet template preserved');
})().catch(error=>{console.error(error);process.exitCode=1;});
